import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { contextIdentity, contextVisible, controlStatus, failure, record, terminalControl, terminalHandle,
  terminalList, terminalRead, terminalSettings, terminalSuccess, text, type Context, type Control, type Handle,
  type Host, type Settings, type UiError } from './core';
import type { DisplayTheme } from './theme';

interface Connection {
  epoch: number; sessionId: string; active: boolean; terminalId?: string; control?: Control;
  cursor?: number; ended: boolean; pending: boolean; readFailed: boolean;
  binding?: Promise<void>; controlOperation?: Promise<void>; input: Promise<void>; resize: Promise<void>; lastSize?: { cols: number; rows: number };
}
export interface TerminalSnapshot {
  phase: 'loading' | 'ready' | 'paused' | 'failed'; title: string; terminalId?: string;
  ended: boolean; controlling: boolean; pending?: string; error?: UiError;
  listOpen: boolean; listLoading: boolean; items?: Handle[]; listError?: UiError;
}
export class TerminalController {
  private state: TerminalSnapshot = { phase: 'loading', title: '系统终端', ended: false, controlling: false, listOpen: false, listLoading: false };
  private readonly listeners = new Set<() => void>();
  private connection?: Connection;
  private epoch = 0;
  private identity?: string;
  private remembered?: string;
  private context: Context | null = null;
  private disposed = false;
  private screen?: HTMLElement;
  private terminal?: Terminal;
  private fit?: FitAddon;
  private observer?: ResizeObserver;
  private inputListener?: { dispose(): void };
  private display?: DisplayTheme;
  private listRevision = 0;
  private disposal?: Promise<void>;
  constructor(private readonly host: Host) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  private patch(value: Partial<TerminalSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
    if (this.terminal) this.terminal.options.disableStdin = !this.connection?.control || this.connection.pending || this.connection.readFailed || this.connection.ended;
  }
  private current(connection: Connection) { return !this.disposed && connection.active && this.connection === connection && this.epoch === connection.epoch; }
  private call = (method: string, params: Record<string, unknown>) => this.host.request(method, params);
  private report(cause: unknown, action: string, operationId: string) {
    console.error('system_terminal.operation.failed', { action, operation_id: operationId });
    return failure(cause, operationId, action);
  }
  attachScreen = (element: HTMLElement) => {
    if (this.screen) throw Error('终端显示区域已经挂载');
    this.screen = element;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(element);
  };
  detachScreen = () => { this.observer?.disconnect(); this.observer = undefined; this.screen = undefined; };
  setTheme = (display: DisplayTheme) => {
    this.display = display;
    if (this.terminal) {
      Object.assign(this.terminal.options, { theme: display.terminal, fontSize: display.fontSize,
        fontFamily: display.fontFamily, cursorBlink: !display.settings.reducedMotion });
      this.resize();
    }
  };
  private destroyTerminal() {
    this.inputListener?.dispose(); this.inputListener = undefined;
    this.terminal?.dispose(); this.terminal = undefined; this.fit = undefined;
  }
  private createTerminal(connection: Connection) {
    if (!this.screen || !this.display) throw Error('终端显示区域或 Host 主题尚未准备完成');
    const terminal = new Terminal({ allowProposedApi: true, disableStdin: true, scrollback: 8_000,
      theme: this.display.terminal, fontSize: this.display.fontSize, fontFamily: this.display.fontFamily,
      cursorBlink: !this.display.settings.reducedMotion });
    const fit = new FitAddon();
    terminal.loadAddon(fit); terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
    this.terminal = terminal; this.fit = fit; terminal.open(this.screen); fit.fit();
    this.inputListener = terminal.onData(data => this.write(connection, data));
  }
  private size() {
    if (!this.terminal) throw Error('终端显示区域不可用');
    return { cols: Math.max(20, Math.min(400, this.terminal.cols)), rows: Math.max(2, Math.min(200, this.terminal.rows)) };
  }
  private async releaseHandle(terminalId: string, sessionId: string, control?: Control) {
    const errors: unknown[] = [];
    if (control) try {
      const result = record(await this.call('xsec.terminal.control.release', { terminalId, control: control }), '控制释放响应');
      if (result.released !== true) throw Error('终端控制权未释放');
    } catch (cause) { errors.push(cause); }
    try { terminalHandle(await this.call('xsec.terminal.detach', { terminalId }), sessionId, terminalId); }
    catch (cause) { errors.push(cause); }
    if (errors.length) throw new AggregateError(errors, 'TERMINAL_SURFACE_RELEASE_FAILED');
  }
  private async disconnect(connection: Connection | undefined) {
    if (!connection) return;
    connection.active = false;
    const reference = connection.control; connection.control = undefined;
    const results = await Promise.allSettled([connection.input, connection.resize, connection.controlOperation, connection.binding]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (connection.terminalId) try { await this.releaseHandle(connection.terminalId, connection.sessionId, reference); }
    catch (cause) { errors.push(cause); }
    if (errors.length) throw new AggregateError(errors, 'TERMINAL_SURFACE_RELEASE_FAILED');
  }
  async update(context: Context | null = this.host.context) {
    if (this.disposed) throw Error('终端页面已释放');
    const identity = contextIdentity(context), visible = contextVisible(context);
    if (identity === this.identity && visible && this.connection?.active) return;
    const epoch = ++this.epoch, old = this.connection;
    this.connection = undefined; this.context = context;
    if (identity !== this.identity) this.remembered = undefined;
    this.identity = identity; this.listRevision += 1;
    this.patch({ phase: visible ? 'loading' : 'paused', title: '系统终端', terminalId: undefined, controlling: false,
      ended: false, pending: undefined, error: undefined, listOpen: false, listLoading: false, items: undefined, listError: undefined });
    this.destroyTerminal();
    try { await this.disconnect(old); }
    catch (cause) { if (epoch === this.epoch) this.patch({ phase: 'failed', error: this.report(cause, 'binding.release', crypto.randomUUID()) }); throw cause; }
    if (this.disposed || epoch !== this.epoch || !visible) return;
    const operationId = crypto.randomUUID();
    const connection: Connection = { epoch, sessionId: '', active: true, ended: false, pending: false,
      readFailed: false, input: Promise.resolve(), resize: Promise.resolve() };
    this.connection = connection;
    try {
      connection.sessionId = text(context?.workspace?.binding?.sessionId, '终端绑定会话');
      this.createTerminal(connection);
      const existing = context?.tool?.entityId ?? this.remembered;
      const bind = async () => {
        const raw = existing ? await this.call('xsec.terminal.attach', { terminalId: existing })
          : await this.call('xsec.terminal.open', this.size());
        const handle = terminalHandle(raw, connection.sessionId, existing);
        if (!existing && !handle.control) throw Error('新建终端未返回控制租约');
        if (!this.current(connection)) {
          await this.releaseHandle(handle.terminal_id, connection.sessionId, handle.control);
          return;
        }
        connection.terminalId = handle.terminal_id; connection.control = handle.control; connection.ended = handle.state !== 'running';
        this.remembered = handle.terminal_id;
        this.patch({ phase: 'ready', title: handle.title, terminalId: handle.terminal_id, controlling: Boolean(handle.control), ended: connection.ended });
        console.info('system_terminal.binding.ready', { operation_id: operationId, existing: Boolean(existing) });
        this.resize(); this.terminal?.focus(); void this.read(connection);
      };
      connection.binding = bind(); await connection.binding;
    } catch (cause) {
      if (this.current(connection)) {
        connection.readFailed = true;
        this.patch({ phase: 'failed', error: this.report(cause, 'binding.open', operationId) });
      } else { this.report(cause, 'binding.cleanup', operationId); throw cause; }
    }
  }
  private async read(connection: Connection) {
    const operationId = crypto.randomUUID();
    try {
      while (this.current(connection) && !connection.readFailed && connection.terminalId) {
        const terminalId = connection.terminalId;
        const result = terminalRead(await this.call('xsec.terminal.read', { terminalId, cursor: connection.cursor, maxBytes: 65_536, waitMs: 1_000 }), connection.cursor);
        if (!this.current(connection)) return;
        if (result.read_error !== null) throw Error('终端输出读取失败：' + result.read_error);
        if (result.truncated) this.terminal?.writeln('\r\n[较早的终端历史已被缓存淘汰]');
        if (result.data) this.terminal?.write(result.data);
        connection.cursor = result.next_cursor;
        if (result.state !== 'running') {
          connection.ended = true; connection.control = undefined;
          this.patch({ ended: true, controlling: false }); return;
        }
        if (result.has_more) continue;
        const reference = connection.control;
        const observed = controlStatus(await this.call('xsec.terminal.control.status', { terminalId }), terminalId);
        if (!this.current(connection)) return;
        if (reference && connection.control === reference && observed.control?.leaseId !== reference.leaseId) {
          connection.control = undefined; this.patch({ controlling: false });
          console.info('system_terminal.control.changed', { generation: observed.generation });
        }
      }
    } catch (cause) {
      if (this.current(connection)) { connection.readFailed = true; this.patch({ phase: 'failed', error: this.report(cause, 'output.read', operationId) }); }
    }
  }
  reconnect = async () => {
    const connection = this.connection;
    if (!connection?.terminalId) { await this.updateAfterFailure(); return; }
    if (!this.current(connection) || connection.pending || !connection.readFailed) return;
    const operationId = crypto.randomUUID(), terminalId = connection.terminalId;
    connection.pending = true; this.patch({ pending: 'reconnect' });
    try {
      const handle = terminalHandle(await this.call('xsec.terminal.attach', { terminalId }), connection.sessionId, terminalId);
      if (!this.current(connection)) return;
      connection.ended = handle.state !== 'running'; connection.readFailed = false;
      this.patch({ phase: 'ready', title: handle.title, ended: connection.ended, error: undefined });
      console.info('system_terminal.output.resumed', { operation_id: operationId });
      void this.read(connection);
    } catch (cause) { if (this.current(connection)) this.patch({ error: this.report(cause, 'output.reconnect', operationId) }); }
    finally { if (this.current(connection)) { connection.pending = false; this.patch({ pending: undefined }); } }
  };
  private async updateAfterFailure() {
    if (this.connection) this.connection.active = false;
    await this.update(this.context);
  }
  changeControl = (action: 'acquire' | 'takeover' | 'release' | 'close') => {
    const connection = this.connection;
    if (!connection?.terminalId || !this.current(connection) || connection.pending || connection.ended) return Promise.resolve();
    const operation = this.runControl(connection, action);
    connection.controlOperation = operation;
    return operation;
  };
  private async runControl(connection: Connection & { terminalId?: string }, action: 'acquire' | 'takeover' | 'release' | 'close') {
    if (!connection.terminalId) throw Error('终端尚未绑定');
    const terminalId = connection.terminalId, reference = connection.control, operationId = crypto.randomUUID();
    connection.pending = true; this.patch({ pending: action });
    console.info('system_terminal.control.started', { action, operation_id: operationId });
    try {
      if (action === 'acquire' || action === 'takeover') {
        if (reference) throw Error('当前页面已持有终端控制权');
        const result = record(await this.call('xsec.terminal.control.acquire', { terminalId, takeover: action === 'takeover' }), '控制获取响应');
        const acquired = terminalControl(result.control, terminalId);
        if (!this.current(connection)) {
          const released = record(await this.call('xsec.terminal.control.release', { terminalId, control: acquired }), '迟到控制释放响应');
          if (released.released !== true) throw Error('迟到的终端控制租约未释放');
          return;
        }
        connection.control = acquired; connection.lastSize = undefined;
      } else {
        if (!reference) throw Error('TERMINAL_CONTROL_REQUIRED');
        connection.control = undefined; this.patch({ controlling: false });
        if (action === 'release') {
          const released = record(await this.call('xsec.terminal.control.release', { terminalId, control: reference }), '控制释放响应');
          if (released.released !== true) throw Error('终端控制权未释放');
        } else {
          const handle = terminalHandle(await this.call('xsec.terminal.close', { terminalId, control: reference }), connection.sessionId, terminalId);
          if (handle.state === 'running') throw Error('终端仍在运行');
          connection.ended = true;
        }
      }
      if (this.current(connection)) {
        this.patch({ controlling: Boolean(connection.control), ended: connection.ended, error: undefined });
        console.info('system_terminal.control.completed', { action, operation_id: operationId });
      }
    } catch (cause) {
      if (this.current(connection)) { connection.control = undefined; this.patch({ controlling: false, error: this.report(cause, 'control.' + action, operationId) }); }
      else { this.report(cause, 'control.cleanup', operationId); throw cause; }
    } finally {
      if (this.current(connection)) { connection.pending = false; this.patch({ pending: undefined }); this.resize(); }
    }
  }
  private mutationFailed(connection: Connection, reference: Control, cause: unknown, action: string, operationId: string) {
    if (!this.current(connection) || connection.control !== reference) return;
    connection.control = undefined;
    this.patch({ controlling: false, error: this.report(cause, action, operationId) });
  }
  private write(connection: Connection, data: string) {
    const reference = connection.control, terminalId = connection.terminalId;
    if (!reference || !terminalId || !this.current(connection) || connection.pending || connection.readFailed || connection.ended) return;
    const operationId = crypto.randomUUID();
    connection.input = connection.input.then(async () => {
      if (!this.current(connection) || connection.control !== reference || connection.pending || connection.readFailed || connection.ended) return;
      terminalSuccess(await this.call('xsec.terminal.write', { terminalId, data, control: reference }));
    }).catch(cause => this.mutationFailed(connection, reference, cause, 'input.write', operationId));
  }
  private resize() {
    const connection = this.connection;
    if (!this.terminal || !this.fit || !connection || !this.current(connection)) return;
    try { this.fit.fit(); }
    catch (cause) { connection.readFailed = true; this.patch({ phase: 'failed', error: this.report(cause, 'screen.fit', crypto.randomUUID()) }); return; }
    const reference = connection.control, terminalId = connection.terminalId, size = this.size();
    if (!reference || !terminalId || connection.pending || connection.readFailed || connection.ended ||
      (connection.lastSize?.cols === size.cols && connection.lastSize.rows === size.rows)) return;
    connection.lastSize = size;
    const operationId = crypto.randomUUID();
    connection.resize = connection.resize.then(async () => {
      if (!this.current(connection) || connection.control !== reference || connection.pending || connection.readFailed || connection.ended) return;
      terminalSuccess(await this.call('xsec.terminal.resize', { terminalId, ...size, control: reference }));
    }).catch(cause => this.mutationFailed(connection, reference, cause, 'screen.resize', operationId));
  }
  toggleList = () => { this.patch({ listOpen: !this.state.listOpen }); if (this.state.listOpen) void this.loadList(); };
  loadList = async () => {
    const connection = this.connection;
    if (!connection || !this.current(connection) || this.state.listLoading) return;
    const revision = ++this.listRevision, operationId = crypto.randomUUID();
    this.patch({ listLoading: true, items: undefined, listError: undefined });
    try {
      const items = terminalList(await this.call('xsec.terminal.list', {}), connection.sessionId);
      if (this.current(connection) && revision === this.listRevision) this.patch({ items });
    } catch (cause) { if (this.current(connection) && revision === this.listRevision) this.patch({ listError: this.report(cause, 'list.read', operationId) }); }
    finally { if (this.current(connection) && revision === this.listRevision) this.patch({ listLoading: false }); }
  };
  reveal = async (terminalId = this.state.terminalId) => {
    const connection = this.connection;
    if (!terminalId || !connection || !this.current(connection)) return;
    const operationId = crypto.randomUUID();
    try {
      const revealed = record(await this.call('xsec.terminal.reveal', { terminalId }), '终端显示响应');
      if (revealed.terminal_id !== terminalId || revealed.revealed !== true) throw Error('终端显示结果无效');
      console.info('system_terminal.reveal.completed', { operation_id: operationId });
    } catch (cause) { if (this.current(connection)) this.patch({ error: this.report(cause, 'terminal.reveal', operationId) }); }
  };
  dispose = () => {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.epoch += 1; this.listRevision += 1;
    const connection = this.connection; this.connection = undefined;
    this.destroyTerminal(); this.detachScreen();
    this.disposal = this.disconnect(connection).finally(() => {
      this.listeners.clear(); console.debug('system_terminal.dispose');
    });
    return this.disposal;
  };
}

export interface SettingsSnapshot { loading: boolean; saving: boolean; paused: boolean; settings?: Settings; profileId: string | null; error?: UiError; saved: boolean }
export class SettingsController {
  private state: SettingsSnapshot = { loading: true, saving: false, paused: false, profileId: null, saved: false };
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private identity?: string;
  private visible = false;
  private disposed = false;
  constructor(private readonly host: Host) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  private patch(value: Partial<SettingsSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener();
  }
  update = async (context: Context | null = this.host.context) => {
    if (this.disposed) throw Error('终端设置页面已释放');
    const identity = contextIdentity(context), visible = contextVisible(context);
    if (this.identity === identity && this.visible === visible) return;
    this.identity = identity; this.visible = visible;
    this.epoch += 1;
    this.patch({ loading: visible, saving: false, settings: undefined, profileId: null, error: undefined, saved: false });
    if (!visible) {
      this.patch({ paused: true, loading: false, saving: false, settings: undefined, error: undefined, saved: false });
      return;
    }
    this.patch({ paused: false });
    await this.load();
  };
  load = async () => {
    if (this.disposed || this.state.paused || this.state.saving) return;
    const epoch = ++this.epoch, operationId = crypto.randomUUID();
    this.patch({ loading: true, settings: undefined, error: undefined, saved: false });
    try {
      const settings = terminalSettings(await this.host.request('xsec.terminal.settings.get', {}));
      if (epoch === this.epoch) this.patch({ settings, profileId: settings.configuredProfileId });
      console.info('system_terminal.settings.loaded', { operation_id: operationId, platform: settings.platform });
    } catch (cause) {
      console.error('system_terminal.settings.failed', { operation_id: operationId, action: 'get' });
      if (epoch === this.epoch) this.patch({ error: failure(cause, operationId, 'settings.get') });
    } finally { if (epoch === this.epoch) this.patch({ loading: false }); }
  };
  select = (profileId: string | null) => {
    if (this.state.saving || this.state.loading || this.state.settings?.platform !== 'windows') return;
    if (profileId !== null && !this.state.settings.profiles.some(profile => profile.id === profileId)) throw Error('Shell 配置不可用');
    this.patch({ profileId, saved: false });
  };
  save = async () => {
    if (this.disposed || this.state.loading || this.state.saving || this.state.settings?.platform !== 'windows') return;
    const epoch = this.epoch, profileId = this.state.profileId, operationId = crypto.randomUUID();
    this.patch({ saving: true, error: undefined, saved: false });
    try {
      const saved = terminalSettings(await this.host.request('xsec.terminal.settings.set', { profileId }));
      if (saved.configuredProfileId !== profileId) throw Error('Shell 保存结果与提交不匹配');
      const readback = terminalSettings(await this.host.request('xsec.terminal.settings.get', {}));
      if (readback.platform !== saved.platform || readback.configuredProfileId !== profileId || readback.effectiveProfileId !== saved.effectiveProfileId) throw Error('Shell 持久化回读不一致');
      if (epoch === this.epoch) this.patch({ settings: readback, profileId: readback.configuredProfileId, saved: true });
      console.info('system_terminal.settings.saved', { operation_id: operationId });
    } catch (cause) {
      console.error('system_terminal.settings.failed', { operation_id: operationId, action: 'set' });
      if (epoch === this.epoch) this.patch({ error: failure(cause, operationId, 'settings.set') });
    } finally { if (epoch === this.epoch) this.patch({ saving: false }); }
  };
  dispose = () => { this.disposed = true; this.epoch += 1; this.listeners.clear(); };
}
