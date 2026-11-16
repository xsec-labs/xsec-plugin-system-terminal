import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";
import baseCss from "./base.css";

type Host = {
  context: { kind?: string; tool?: { entityId?: string } } | null;
  request(method: string, params: Record<string, unknown>): Promise<any>;
  onTheme(listener: (theme: Record<string, string>) => void): { dispose(): void } | undefined;
};

const MIN_COLS = 20;
const MIN_ROWS = 2;
const READ_WAIT_MS = 1_000;
const MAX_READ_BYTES = 65_536;

// 样式用 XSEC Desktop 的设计 token：宿主把当前主题写成 --xsec-<name> 变量，base.css 把它们收成
// --surface、--text 等，宿主没有提供时用 Desktop 亮、暗两套默认值。
const css = `${xtermCss}
${baseCss}
.t-app{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;background:var(--surface)}
.t-bar{display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--hairline)}
.t-title{flex:1;min-width:0;overflow:hidden;color:var(--muted);font:12px/18px var(--mono);text-overflow:ellipsis;white-space:nowrap}
.t-actions{display:flex;flex:none;align-items:center;gap:2px}
.t-actions .x-btn:disabled[data-idle]{display:none}
.t-sep{width:1px;height:16px;margin:0 4px;background:var(--hairline)}
.t-sep:not(:has(~ .x-btn:not([hidden]))){display:none}
.t-danger{color:var(--danger)}
.t-danger:hover{background:color-mix(in srgb,var(--danger) 10%,var(--surface))}
.t-list{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--hairline);color:var(--muted);font-size:12px}
.t-list:empty{display:none}
.t-screen{flex:1;min-height:0;padding:8px 4px 8px 12px}
.t-screen .xterm{height:100%}
.t-screen .xterm-viewport{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--muted) 40%,transparent) transparent}
.t-bar .x-badge:empty{display:none}
.t-error{margin:12px 12px 0;color:var(--danger);white-space:pre-wrap}
.t-error:empty{display:none}
.t-settings{display:grid;gap:8px;max-width:640px}
.t-settings-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.t-settings-row .x-select{flex:1;min-width:160px}
.t-info{margin:0;color:var(--muted);font-size:12px}
.t-info:empty{display:none}
.t-info[data-tone=error]{color:var(--danger)}
`;

// ANSI 16 色与 Desktop 原生终端相同（mygo 终端插件的亮、暗两套）。
const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const ANSI_LIGHT = ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"];
const ANSI_DARK = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
const FALLBACK_SURFACE = "#19191c";
const FALLBACK_TEXT = "#f4f4f5";
const FONT_FAMILY = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace';

function channels(color: string): [number, number, number] | undefined {
  const short = /^#([0-9a-f]{3})$/i.exec(color.trim())?.[1];
  const hex = short ? [...short].map(digit => digit + digit).join("") : /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return undefined;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

// 终端的底色、文字和光标取面板自己的 token（与 Desktop 原生终端一致），亮暗由底色的明度决定。
function theme(theme: Record<string, string>) {
  const style = getComputedStyle(document.documentElement);
  const token = (key: string, name: string, fallback: string) => {
    const value = theme[key] ?? style.getPropertyValue(name).trim();
    return channels(value) ? value : fallback;
  };
  const background = token("content-surface", "--surface", FALLBACK_SURFACE);
  const foreground = token("text-primary", "--text", FALLBACK_TEXT);
  const [r, g, b] = channels(background)!;
  const dark = 299 * r + 587 * g + 114 * b < 128_000;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  const palette = dark ? ANSI_DARK : ANSI_LIGHT;
  const ansi: Record<string, string> = {};
  ANSI_NAMES.forEach((name, index) => {
    ansi[name] = palette[index];
    ansi[`bright${name[0].toUpperCase()}${name.slice(1)}`] = palette[index + 8];
  });
  const [tr, tg, tb] = channels(foreground)!;
  return {
    ...ansi, background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: `rgba(${tr},${tg},${tb},${dark ? 0.24 : 0.16})`,
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { className, textContent: text });
}

function actionButton(text: string, className = ""): HTMLButtonElement {
  return Object.assign(element("button", `x-btn small ghost${className ? ` ${className}` : ""}`, text), { type: "button" });
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
    if (controlText) {
      controlText.textContent = controlEnded ? "已结束" : control ? "正在控制" : "观察中";
      controlText.className = `x-badge${control && !controlEnded ? " success" : ""}`;
    }
    // 只显示当前状态下用得上的操作：观察时是获取控制和接管，控制时是释放和终止。
    if (acquireButton) acquireButton.hidden = Boolean(control) || controlEnded;
    if (takeoverButton) takeoverButton.hidden = Boolean(control) || controlEnded;
    if (releaseButton) releaseButton.hidden = !control || controlEnded;
    if (closeButton) closeButton.hidden = !control || controlEnded;
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
    const wasOpen = terminalList.childNodes.length > 0;
    terminalList.replaceChildren();
    if (wasOpen) return;
    try {
      const result = await call("xsec.terminal.list", {});
      for (const handle of result.items ?? []) {
        const button = Object.assign(actionButton(`${handle.title ?? handle.terminal_id} · ${handle.state}`), { className: "x-btn small" });
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
      const app = element("main", "t-app");
      const bar = element("div", "t-bar");
      controlText = element("span", "x-badge");
      controlText.setAttribute("role", "status");
      stateText = element("span", "t-title");
      const actions = element("div", "t-actions");
      const list = actionButton("终端列表");
      list.onclick = () => void showTerminalList();
      const reveal = actionButton("显示");
      reveal.title = "在工作区中显示这个终端";
      reveal.onclick = () => {
        console.info("system-terminal.reveal", { terminalId });
        if (terminalId) void call("xsec.terminal.reveal", { terminalId }).catch(showError);
      };
      acquireButton = Object.assign(actionButton("获取控制"), { disabled: true });
      acquireButton.onclick = () => void changeControl("acquire");
      takeoverButton = Object.assign(actionButton("接管"), { disabled: true });
      takeoverButton.title = "从当前控制方接管这个终端";
      takeoverButton.onclick = () => void changeControl("takeover");
      releaseButton = Object.assign(actionButton("释放控制"), { disabled: true, hidden: true });
      releaseButton.onclick = () => void changeControl("release");
      closeButton = Object.assign(actionButton("终止终端", "t-danger"), { disabled: true, hidden: true });
      closeButton.onclick = () => void changeControl("close");
      reconnectButton = Object.assign(actionButton("重新连接"), { disabled: true });
      reconnectButton.dataset.idle = "";
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
      error = element("div", "x-notice danger t-error");
      error.setAttribute("role", "alert");
      terminalList = element("div", "t-list");
      const screen = element("div", "t-screen");
      actions.append(reconnectButton, list, reveal, element("span", "t-sep"), acquireButton, takeoverButton, releaseButton, closeButton);
      bar.append(controlText, stateText, actions); app.append(bar, terminalList, error, screen); root.append(app);
      terminal = new Terminal({ allowProposedApi: true, disableStdin: true, cursorBlink: true, fontSize: 13, fontFamily: FONT_FAMILY, scrollback: 8_000, theme: theme({}) });
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
  let dispose = () => {};
  return {
    async mount(root: HTMLElement) {
      root.replaceChildren(); root.append(Object.assign(document.createElement("style"), { textContent: css }));
      theme({});
      const themeSubscription = host.onTheme?.((value) => { theme(value); });
      dispose = () => themeSubscription?.dispose();
      const panel = element("main", "x-panel");
      const head = element("header", "x-head");
      head.append(element("strong", "x-title", "系统终端"));
      const body = element("div", "x-body");
      const card = element("section", "x-card t-settings");
      const field = element("label", "x-field");
      const row = element("div", "t-settings-row");
      const select = element("select", "x-select");
      const save = Object.assign(element("button", "x-btn primary", "保存"), { type: "button", disabled: true });
      const info = element("p", "t-info");
      info.setAttribute("role", "status");
      const note = (text: string, failed = false) => { info.textContent = text; info.dataset.tone = failed ? "error" : ""; };
      row.append(select, save);
      field.append(element("span", "x-label", "新建终端的默认 Shell"), row);
      card.append(field, info); body.append(card); panel.append(head, body); root.append(panel);
      try {
        const settings = await host.request("xsec.terminal.settings.get", {});
        const profiles = settings.profiles ?? [];
        select.append(Object.assign(document.createElement("option"), { value: "", textContent: "系统默认" }));
        for (const profile of profiles) select.append(Object.assign(document.createElement("option"), { value: profile.id, textContent: profile.label ?? profile.id }));
        select.value = settings.configuredProfileId ?? "";
        save.disabled = settings.platform !== "windows";
        if (save.disabled) select.disabled = true;
        note(save.disabled ? "macOS 和 Linux 使用当前帐户的系统登录 Shell。" : `当前默认 Shell：${settings.effectiveProfileId ?? "系统默认"}`);
        save.onclick = () => void host.request("xsec.terminal.settings.set", { profileId: select.value || null })
          .then(() => { note("默认 Shell 已保存，仅影响后续新建终端。"); })
          .catch((reason) => { note(`保存设置失败：${String(reason)}`, true); });
      } catch (reason) { note(`读取设置失败：${String(reason)}`, true); }
    },
    dispose() { dispose(); },
  };
}

export function activate(host: Host) {
  console.debug("system-terminal-mcp.activate", { kind: host.context?.kind });
  return host.context?.kind === "settings-page" ? settingsView(host) : terminalView(host);
}
