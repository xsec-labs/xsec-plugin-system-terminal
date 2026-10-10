import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import tokenStyles from '@xsec/design-tokens/styles.css';
import componentStyles from '@xsec/ui-react/styles.css';
import xtermStyles from '@xterm/xterm/css/xterm.css';
import styles from './styles.css';
import { SettingsApp, TerminalApp } from './app';
import { SettingsController, TerminalController } from './controller';
import { PluginTheme, readTheme } from './theme';
import type { Context, Host } from './core';

export function createController(host: Host) {
  if (host.apiVersion !== 2) throw Error('系统终端需要 Host frontend API 2');
  const settingsPage = host.context?.kind === 'settings-page';
  const controller = settingsPage ? new SettingsController(host) : new TerminalController(host);
  let root: Root | undefined;
  console.debug('system_terminal.activate', { kind: host.context?.kind, apiVersion: host.apiVersion });
  return {
    mount(element: HTMLElement, context: Context | null = host.context) {
      if (root) throw Error('系统终端页面已经挂载');
      const initial = readTheme();
      root = createRoot(element);
      flushSync(() => root!.render(<><style>{tokenStyles + componentStyles + xtermStyles + styles}</style>
        <PluginTheme host={host} initial={initial} onTheme={controller instanceof TerminalController ? controller.setTheme : undefined} onFailure={controller.dispose}>
          {controller instanceof SettingsController ? <SettingsApp controller={controller}/> : <TerminalApp controller={controller}/>}
        </PluginTheme></>));
      console.info('system_terminal.mount', { settingsPage });
      return controller.update(context);
    },
    update(context: Context | null = host.context) {
      if ((context?.kind === 'settings-page') !== settingsPage) throw Error('系统终端页面类型改变，需要重新载入');
      return controller.update(context);
    },
    async dispose() {
      try { await controller.dispose(); }
      finally { root?.unmount(); root = undefined; }
    },
  };
}
