export interface Context {
  kind?: string; visible?: boolean; tool?: { entityId?: string };
  surface?: { bindingRevision?: string };
  workspace?: { binding?: { projectId?: string; sessionId?: string; cwd?: string } };
}
export interface Host {
  apiVersion: number; context: Context | null;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onTheme(listener: (theme: Record<string, string>) => void): { dispose(): void };
}
export interface Control {
  version: 1; instanceId: string; accountContext: string; epoch: number; kind: 'terminal';
  resourceId: string; clientId: string; leaseId: string; generation: number;
}
export type TerminalState = 'running' | 'exited' | 'terminated';
export interface Handle { terminal_id: string; session_id: string; title: string; state: TerminalState; control?: Control }
export interface Read { data: string; next_cursor: number; oldest_cursor: number; has_more: boolean; truncated: boolean; state: TerminalState; read_error: string | null }
export interface Settings {
  platform: 'windows' | 'macos' | 'linux';
  profiles: { id: string; label: string; is_default: boolean }[];
  configuredProfileId: string | null; effectiveProfileId: string | null;
}
export interface UiError { message: string; operationId: string; action: string }
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(label + '格式无效');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Error(label + '格式无效');
  return value;
}
function integer(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw Error(label + '格式无效');
  return Number(value);
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw Error(label + '格式无效');
  return value;
}
function nullableText(value: unknown, label: string): string | null { return value === null ? null : text(value, label); }
function state(value: unknown): TerminalState {
  if (value !== 'running' && value !== 'exited' && value !== 'terminated') throw Error('终端运行状态无效');
  return value;
}
export function terminalControl(value: unknown, terminalId: string): Control {
  const row = record(value, '终端控制租约');
  if (row.version !== 1 || row.kind !== 'terminal' || row.resourceId !== terminalId) throw Error('TERMINAL_CONTROL_INVALID');
  return Object.freeze({ version: 1, kind: 'terminal', resourceId: terminalId,
    instanceId: text(row.instanceId, '控制实例'), accountContext: text(row.accountContext, '账户上下文'),
    clientId: text(row.clientId, '控制客户端'), leaseId: text(row.leaseId, '控制租约'),
    epoch: integer(row.epoch, '控制 epoch', 1), generation: integer(row.generation, '控制 generation', 1) });
}
export function terminalHandle(value: unknown, sessionId: string, expectedId?: string): Handle {
  const row = record(value, '终端响应'), id = text(row.terminal_id, '终端 ID');
  if (row.session_id !== sessionId || (expectedId !== undefined && id !== expectedId)) throw Error('终端响应与当前会话或资源不匹配');
  return { terminal_id: id, session_id: sessionId, title: row.title === undefined ? id : text(row.title, '终端标题'),
    state: state(row.state), control: row.control === undefined ? undefined : terminalControl(row.control, id) };
}
export function terminalRead(value: unknown, cursor: number | undefined): Read {
  const row = record(value, '终端输出'), next = integer(row.next_cursor, '输出游标'), oldest = integer(row.oldest_cursor, '历史游标');
  if (oldest > next || (cursor !== undefined && next < cursor)) throw Error('终端输出游标倒退');
  if (typeof row.data !== 'string') throw Error('终端输出格式无效');
  return { data: row.data, next_cursor: next, oldest_cursor: oldest,
    has_more: boolean(row.has_more, '剩余输出'), truncated: boolean(row.truncated, '历史截断'),
    state: state(row.state), read_error: row.read_error === undefined ? null : nullableText(row.read_error, '终端读取错误') };
}
export function controlStatus(value: unknown, terminalId: string) {
  const row = record(value, '控制状态'), generation = integer(row.generation, '控制版本');
  const control = row.control === null ? null : terminalControl(row.control, terminalId);
  if (control && control.generation !== generation) throw Error('终端控制版本不匹配');
  return { generation, controllerClientId: nullableText(row.controllerClientId, '控制客户端'),
    operationPending: boolean(row.operationPending, '控制操作状态'), control };
}
export function terminalList(value: unknown, sessionId: string): Handle[] {
  const row = record(value, '终端列表');
  if (!Array.isArray(row.items)) throw Error('终端列表格式无效');
  const items = row.items.map(item => terminalHandle(item, sessionId));
  if (new Set(items.map(item => item.terminal_id)).size !== items.length) throw Error('终端列表包含重复 ID');
  return items;
}
export function terminalSuccess(value: unknown) {
  if (record(value, '终端操作响应').ok !== true) throw Error('终端操作未确认成功');
}
export function terminalSettings(value: unknown): Settings {
  const row = record(value, '终端设置');
  if (row.platform !== 'windows' && row.platform !== 'macos' && row.platform !== 'linux') throw Error('终端设置平台无效');
  if (!Array.isArray(row.profiles)) throw Error('Shell 配置列表无效');
  const profiles = row.profiles.map(value => { const profile = record(value, 'Shell 配置');
    return { id: text(profile.id, 'Shell ID'), label: text(profile.label, 'Shell 名称'), is_default: boolean(profile.is_default, '系统默认标记') }; });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw Error('Shell 配置包含重复 ID');
  const configuredProfileId = nullableText(row.configuredProfileId, '配置 Shell'), effectiveProfileId = nullableText(row.effectiveProfileId, '当前 Shell');
  for (const id of [configuredProfileId, effectiveProfileId]) if (id !== null && !profiles.some(profile => profile.id === id)) throw Error('Shell 设置引用不可用的配置');
  if (row.platform !== 'windows' && configuredProfileId !== null) throw Error('当前平台的 Shell 配置无效');
  return { platform: row.platform, profiles, configuredProfileId, effectiveProfileId };
}
export function contextIdentity(context: Context | null): string {
  const binding = context?.workspace?.binding;
  return JSON.stringify([context?.kind, context?.tool?.entityId, binding?.sessionId, binding?.projectId, binding?.cwd, context?.surface?.bindingRevision]);
}
export function contextVisible(context: Context | null): boolean {
  if (context?.visible !== undefined && typeof context.visible !== 'boolean') throw Error('终端可见状态无效');
  return context?.visible !== false;
}
export function failure(cause: unknown, operationId: string, action: string): UiError {
  return { message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000), operationId, action };
}
