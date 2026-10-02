import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";

type Host = {
  context: { kind?: string; tool?: { entityId?: string } } | null;
  request(method: string, params: Record<string, unknown>): Promise<any>;
  onTheme(listener: (theme: Record<string, string>) => void): { dispose(): void } | undefined;
};

const MIN_COLS = 20;
const MIN_ROWS = 2;
const READ_WAIT_MS = 1_000;
const MAX_READ_BYTES = 65_536;

const css = `${xtermCss}
:root{color:var(--xsec-text-primary,#f5f5f5);background:var(--xsec-surface-base,#111)}
*{box-sizing:border-box}html,body,[data-xsec-plugin-root]{height:100%;margin:0}.terminal{height:100%;display:flex;flex-direction:column}.bar{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--xsec-border,#333);font:12px system-ui}.bar span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar button{border:1px solid var(--xsec-border,#555);border-radius:5px;background:transparent;color:inherit;padding:3px 7px;cursor:pointer}.screen{min-height:0;flex:1;padding:8px}.screen .xterm{height:100%}.notice{padding:8px 10px;color:#ff908c;font:12px system-ui;white-space:pre-wrap}
`;

function theme(theme: Record<string, string>) {
  return {
    background: theme["surface-base"] ?? "#111", foreground: theme["text-primary"] ?? "#f5f5f5",
    cursor: theme.accent ?? "#76a5ff", selectionBackground: theme["accent-soft"] ?? "#2d4f7e",
  };
}

function terminalSize(terminal: Terminal): { cols: number; rows: number } {
  return { cols: Math.max(MIN_COLS, terminal.cols), rows: Math.max(MIN_ROWS, terminal.rows) };
}

type Control = {
  version: 1; instanceId: string; accountContext: string; epoch: number; kind: "terminal";
  resourceId: string; clientId: string; leaseId: string; generation: number;
};

function terminalControl(value: unknown, terminalId: string): Control {
  if (!value || typeof value !== "object") throw new Error("TERMINAL_CONTROL_REQUIRED");
  const control = value as Control;
  if (control.version !== 1 || control.kind !== "terminal" || control.resourceId !== terminalId
    || !Number.isSafeInteger(control.epoch) || control.epoch < 1
    || !Number.isSafeInteger(control.generation) || control.generation < 1
    || ![control.instanceId, control.accountContext, control.clientId, control.leaseId].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("TERMINAL_CONTROL_INVALID");
  }
  return Object.freeze({ ...control });
}

function terminalView(host: Host) {
  let terminalId = "";
  let control: Control | undefined;
  let controlPending = false;
  let controlEnded = false;
  let inputQueue = Promise.resolve();
  let resizeQueue = Promise.resolve();
  let lastSize: { cols: number; rows: number } | undefined;
  let controlText: HTMLSpanElement | undefined;
  let acquireButton: HTMLButtonElement | undefined;
  let takeoverButton: HTMLButtonElement | undefined;
  let releaseButton: HTMLButtonElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let cursor: number | undefined;
  let stopped = false;
  let reading = false;
  let themeSubscription: { dispose(): void } | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let terminal: Terminal | undefined;
  let fit: FitAddon | undefined;
  let input: { dispose(): void } | undefined;
  let stateText: HTMLSpanElement | undefined;
  let error: HTMLDivElement | undefined;
  let terminalList: HTMLDivElement | undefined;
  let reconnectButton: HTMLButtonElement | undefined;

  const showError = (value: unknown) => {
    if (error) error.textContent = value instanceof Error ? value.message : String(value);
  };
  const status = (value: string) => { if (stateText) stateText.textContent = value; };
  const call = (method: string, params: Record<string, unknown>) => host.request(method, params);

  const renderControl = () => {
    if (terminal) terminal.options.disableStdin = !control || controlPending || controlEnded;
    if (controlText) controlText.textContent = controlEnded ? "已结束" : control ? "正在控制" : "观察中";
    if (acquireButton) acquireButton.disabled = !terminalId || Boolean(control) || controlPending || controlEnded;
    if (takeoverButton) takeoverButton.disabled = !terminalId || Boolean(control) || controlPending || controlEnded;
    if (releaseButton) releaseButton.disabled = !control || controlPending || controlEnded;
    if (closeButton) closeButton.disabled = !control || controlPending || controlEnded;
  };
  const mutationFailed = (reason: unknown, reference?: Control) => {
    if (!reference || control?.leaseId === reference.leaseId) control = undefined;
    renderControl();
    console.warn("system-terminal.control-operation.failed", { terminalId });
    showError(reason);
  };
  const resize = () => {
    if (!terminal || !fit || stopped) return;
    fit.fit();
    const id = terminalId;
    const reference = control;
    const size = terminalSize(terminal);
    if (!id || !reference || controlPending || (lastSize?.cols === size.cols && lastSize.rows === size.rows)) return;
    lastSize = size;
    resizeQueue = resizeQueue.then(async () => {
      if (stopped || control?.leaseId !== reference.leaseId) return;
      await call("xsec.terminal.resize", { terminalId: id, ...size, control: reference });
    }).catch(reason => mutationFailed(reason, reference));
  };
  const changeControl = async (action: "acquire" | "takeover" | "release" | "close") => {
    const id = terminalId;
    const reference = control;
    if (!id || controlPending || stopped) return;
    controlPending = true;
    renderControl();
    try {
      if (action === "acquire" || action === "takeover") {
        const result = await call("xsec.terminal.control.acquire", { terminalId: id, takeover: action === "takeover" });
        const acquired = terminalControl(result.control, id);
        if (stopped) {
          await call("xsec.terminal.control.release", { terminalId: id, control: acquired });
          return;
        }
        control = acquired;
        lastSize = undefined;
        console.info("system-terminal.control.acquired", { terminalId: id, generation: acquired.generation });
      } else {
        if (!reference) throw new Error("TERMINAL_CONTROL_REQUIRED");
        control = undefined;
        await call(action === "release" ? "xsec.terminal.control.release" : "xsec.terminal.close", { terminalId: id, control: reference });
        controlEnded = action === "close";
        console.info("system-terminal.control.completed", { terminalId: id, action });
      }
      if (error) error.textContent = "";
    } catch (reason) { mutationFailed(reason); }
    finally { controlPending = false; renderControl(); }
    resize();
  };
  const read = async () => {
    if (stopped || reading || !terminalId || !terminal) return;
    reading = true;
    try {
      const result = await call("xsec.terminal.read", {
        terminalId, cursor, maxBytes: MAX_READ_BYTES, waitMs: READ_WAIT_MS,
      });
      if (stopped || !terminal) return;
      if (result.read_error) {
        console.warn("system-terminal.read.failed", { terminalId });
        showError(`终端输出读取失败：${result.read_error}`);
        if (reconnectButton) reconnectButton.disabled = false;
        return;
      }
      if (result.truncated) terminal.writeln("\r\n[较早的终端历史已被缓存淘汰]");
      if (result.data) terminal.write(result.data);
      cursor = result.next_cursor;
      status(result.state === "running" ? terminalId : `${terminalId} (${result.state})`);
      if (result.state !== "running") {
        control = undefined; controlEnded = true; renderControl(); return;
      }
      if (result.has_more) { queueMicrotask(() => void read()); return; }
      const observed = await call("xsec.terminal.control.status", { terminalId });
      if (stopped) return;
      if (control && observed.control?.leaseId !== control.leaseId) {
        control = undefined; renderControl();
      }
      queueMicrotask(() => void read());
    } catch (reason) {
      console.warn("system-terminal.read.failed", { terminalId });
      showError(`读取终端失败：${String(reason)}`);
      if (reconnectButton) reconnectButton.disabled = false;
    } finally { reading = false; }
  };
  const bind = async () => {
    const existing = host.context?.tool?.entityId;
    const handle = existing
      ? await call("xsec.terminal.attach", { terminalId: existing })
      : await call("xsec.terminal.open", terminal ? terminalSize(terminal) : {});
    if (stopped) {
      try {
        if (handle.control) await call("xsec.terminal.control.release", { terminalId: handle.terminal_id, control: handle.control });
      } finally { await call("xsec.terminal.detach", { terminalId: handle.terminal_id }); }
      return;
    }
    terminalId = handle.terminal_id;
    control = handle.control ? terminalControl(handle.control, terminalId) : undefined;
    controlEnded = Boolean(handle.state && handle.state !== "running");
    renderControl();
    status(handle.title ?? terminalId);
    resize();
    terminal?.focus();
    await read();
  };
  const showTerminalList = async () => {
    if (!terminalList) return;
    terminalList.replaceChildren();
    try {
      const result = await call("xsec.terminal.list", {});
      for (const handle of result.items ?? []) {
        const button = Object.assign(document.createElement("button"), {
          textContent: `${handle.title ?? handle.terminal_id} · ${handle.state}`,
        });
        button.onclick = () => void call("xsec.terminal.reveal", { terminalId: handle.terminal_id }).catch(showError);
        terminalList.append(button);
      }
      if (!terminalList.childElementCount) terminalList.textContent = "当前会话没有可显示的终端";
    } catch (reason) { showError(`读取终端列表失败：${String(reason)}`); }
  };

  return {
    async mount(root: HTMLElement) {
      root.replaceChildren();
      root.append(Object.assign(document.createElement("style"), { textContent: css }));
      const app = Object.assign(document.createElement("main"), { className: "terminal" });
      const bar = Object.assign(document.createElement("div"), { className: "bar" });
      stateText = document.createElement("span");
      const list = Object.assign(document.createElement("button"), { textContent: "终端列表" });
      list.onclick = () => void showTerminalList();
      const reveal = Object.assign(document.createElement("button"), { textContent: "显示" });
      reveal.onclick = () => {
        console.info("system-terminal.reveal", { terminalId });
        if (terminalId) void call("xsec.terminal.reveal", { terminalId }).catch(showError);
      };
      controlText = document.createElement("span");
      acquireButton = Object.assign(document.createElement("button"), { textContent: "获取控制", disabled: true });
      acquireButton.onclick = () => void changeControl("acquire");
      takeoverButton = Object.assign(document.createElement("button"), { textContent: "接管", disabled: true });
      takeoverButton.onclick = () => void changeControl("takeover");
      releaseButton = Object.assign(document.createElement("button"), { textContent: "释放控制", disabled: true });
      releaseButton.onclick = () => void changeControl("release");
      closeButton = Object.assign(document.createElement("button"), { textContent: "终止终端", disabled: true });
      closeButton.onclick = () => void changeControl("close");
      reconnectButton = Object.assign(document.createElement("button"), {
        textContent: "重新连接", disabled: true,
      });
      reconnectButton.onclick = () => {
        if (!terminalId || !reconnectButton) return;
        console.info("system-terminal.reconnect", { terminalId });
        reconnectButton.disabled = true;
        void call("xsec.terminal.attach", { terminalId })
          .then(() => { if (error) error.textContent = ""; return read(); })
          .catch((reason) => {
            console.warn("system-terminal.reconnect.failed", { terminalId });
            showError(`重新连接终端失败：${String(reason)}`);
            if (reconnectButton) reconnectButton.disabled = false;
          });
      };
      error = Object.assign(document.createElement("div"), { className: "notice" });
      terminalList = Object.assign(document.createElement("div"), { className: "bar" });
      const screen = Object.assign(document.createElement("div"), { className: "screen" });
      bar.append(stateText, controlText, list, reveal, reconnectButton, acquireButton, takeoverButton, releaseButton, closeButton); app.append(bar, terminalList, screen, error); root.append(app);
      terminal = new Terminal({ allowProposedApi: true, disableStdin: true, cursorBlink: true, fontSize: 13, scrollback: 8_000, theme: theme({}) });
      fit = new FitAddon(); terminal.loadAddon(fit); terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = "11";
      terminal.open(screen); fit.fit();
      input = terminal.onData((data) => {
        const id = terminalId;
        const reference = control;
        if (!id || !reference || stopped || controlPending) return;
        inputQueue = inputQueue.then(async () => {
          if (stopped || control?.leaseId !== reference.leaseId) return;
          await call("xsec.terminal.write", { terminalId: id, data, control: reference });
        }).catch(reason => mutationFailed(reason, reference));
      });
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(screen);
      themeSubscription = host.onTheme?.((value) => { if (terminal) terminal.options.theme = theme(value); resize(); });
      console.info("system-terminal.mount", { existing: Boolean(host.context?.tool?.entityId) });
      try { await bind(); } catch (reason) { showError(`打开终端失败：${String(reason)}`); }
    },
    async dispose() {
      stopped = true; input?.dispose(); resizeObserver?.disconnect(); themeSubscription?.dispose();
      const reference = control;
      control = undefined;
      try {
        if (terminalId) {
          try {
            if (reference) await call("xsec.terminal.control.release", { terminalId, control: reference });
          } finally { await call("xsec.terminal.detach", { terminalId }); }
        }
      } finally {
        terminal?.dispose(); terminal = undefined;
        console.debug("system-terminal.dispose", { terminalId });
      }
    },
  };
}

function settingsView(host: Host) {
  return {
    async mount(root: HTMLElement) {
      root.replaceChildren(); root.append(Object.assign(document.createElement("style"), { textContent: css }));
      const panel = Object.assign(document.createElement("main"), { className: "terminal" });
      const title = Object.assign(document.createElement("div"), { className: "bar", textContent: "系统终端 MCP 设置" });
      const info = Object.assign(document.createElement("div"), { className: "notice" });
      const select = document.createElement("select");
      const save = Object.assign(document.createElement("button"), { textContent: "保存默认 Shell" });
      panel.append(title, select, save, info); root.append(panel);
      try {
        const settings = await host.request("xsec.terminal.settings.get", {});
        const profiles = settings.profiles ?? [];
        select.append(Object.assign(document.createElement("option"), { value: "", textContent: "系统默认" }));
        for (const profile of profiles) select.append(Object.assign(document.createElement("option"), { value: profile.id, textContent: profile.label ?? profile.id }));
        select.value = settings.configuredProfileId ?? "";
        save.disabled = settings.platform !== "windows";
        if (save.disabled) select.disabled = true;
        info.textContent = save.disabled ? "macOS 和 Linux 使用当前帐户的系统登录 Shell。" : `当前默认 Shell：${settings.effectiveProfileId ?? "系统默认"}`;
        save.onclick = () => void host.request("xsec.terminal.settings.set", { profileId: select.value || null })
          .then(() => { info.textContent = "默认 Shell 已保存，仅影响后续新建终端。"; })
          .catch((reason) => { info.textContent = `保存设置失败：${String(reason)}`; });
      } catch (reason) { info.textContent = `读取设置失败：${String(reason)}`; }
    },
    dispose() {},
  };
}

export function activate(host: Host) {
  console.debug("system-terminal-mcp.activate", { kind: host.context?.kind });
  return host.context?.kind === "settings-page" ? settingsView(host) : terminalView(host);
}
