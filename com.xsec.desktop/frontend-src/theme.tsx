import { useLayoutEffect, useState, type ReactNode } from 'react';
import { ControlThemeProvider, ErrorState } from '@xsec/ui-react';
import { themeAttributes, type ThemeSettings } from '@xsec/design-tokens';
import type { ITheme } from '@xterm/xterm';
import { failure, text, type Host, type UiError } from './core';

export interface DisplayTheme { settings: ThemeSettings; terminal: ITheme; fontSize: number; fontFamily: string }
const keys = ['color-mode', 'ui-density', 'reduce-motion', 'ui-font-size', 'code-font-size', 'font-code', 'surface-base', 'text-primary', 'accent', 'accent-soft'];
// ANSI colors keep Shell output readable in both Host color modes.
const ansiPalette: Record<'light' | 'dark', ITheme> = {
  light: { black: '#202636', red: '#b42335', green: '#226b34', yellow: '#806100', blue: '#2256b8', magenta: '#883f92', cyan: '#006d77', white: '#475569',
    brightBlack: '#566476', brightRed: '#b91c32', brightGreen: '#1d6a2f', brightYellow: '#916900', brightBlue: '#2455a4', brightMagenta: '#84388c', brightCyan: '#006975', brightWhite: '#334155' },
  dark: { black: '#7f8aa3', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
    brightBlack: '#9aa5ce', brightRed: '#ff8fa3', brightGreen: '#b5df8a', brightYellow: '#f2c583', brightBlue: '#98b9ff', brightMagenta: '#d0b2ff', brightCyan: '#a5e1ff', brightWhite: '#e0e7ff' },
};
function size(value: unknown, label: string) {
  const raw = text(value, label);
  if (!/^\d+(?:\.\d+)?px$/.test(raw)) throw Error(label + '无效');
  const result = Number(raw.slice(0, -2));
  if (!Number.isFinite(result) || result < 8 || result > 32) throw Error(label + '超出支持范围');
  return result;
}
function color(value: unknown, label: string) {
  const raw = text(value, label);
  if (!CSS.supports('color', raw)) throw Error(label + '无效');
  return raw;
}
function parseTheme(theme: Record<string, string>): DisplayTheme {
  const mode = theme['color-mode'], density = theme['ui-density'], motion = theme['reduce-motion'];
  if (mode !== 'light' && mode !== 'dark') throw Error('Host 颜色模式无效');
  if (density !== 'compact' && density !== 'comfortable') throw Error('Host UI 密度无效');
  if (motion !== 'true' && motion !== 'false') throw Error('Host 减少动效设置无效');
  const settings: ThemeSettings = { colorMode: mode, density, reducedMotion: motion === 'true',
    fontScale: size(theme['ui-font-size'], 'Host UI 字号') / 14, locale: 'zh-CN' };
  themeAttributes(settings);
  const fontFamily = text(theme['font-code'], 'Host 代码字体');
  if (!CSS.supports('font-family', fontFamily)) throw Error('Host 代码字体无效');
  return { settings, fontSize: size(theme['code-font-size'], 'Host 代码字号'), fontFamily,
    terminal: { ...ansiPalette[mode], background: color(theme['surface-base'], '终端背景'), foreground: color(theme['text-primary'], '终端文字'),
      cursor: color(theme.accent, '终端光标'), selectionBackground: color(theme['accent-soft'], '终端选中背景') } };
}
export function readTheme() {
  const style = getComputedStyle(document.documentElement);
  return parseTheme(Object.fromEntries(keys.map(key => [key, style.getPropertyValue('--xsec-' + key).trim()])));
}
export function PluginTheme({ host, initial, onTheme, onFailure, children }: {
  host: Host; initial: DisplayTheme; onTheme?: (value: DisplayTheme) => void;
  onFailure: () => void | Promise<void>; children: ReactNode;
}) {
  const [display, setDisplay] = useState(initial), [error, setError] = useState<UiError>();
  useLayoutEffect(() => {
    onTheme?.(initial);
    let failed = false, active = true;
    const subscription = host.onTheme(theme => {
      if (failed) return;
      try { const next = parseTheme(theme); onTheme?.(next); setDisplay(next); }
      catch (cause) {
        failed = true;
        const operationId = crypto.randomUUID();
        console.error('system_terminal.theme.failed', { operation_id: operationId });
        setError(failure(cause, operationId, 'theme.decode'));
        Promise.resolve(onFailure()).catch(cleanup => {
          console.error('system_terminal.theme.cleanup.failed', { operation_id: operationId });
          if (active) setError(failure(new AggregateError([cause, cleanup], '主题解析与终端释放失败'), operationId, 'theme.cleanup'));
        });
      }
    });
    return () => { active = false; subscription.dispose(); };
  }, [host, initial, onTheme, onFailure]);
  return <ControlThemeProvider settings={display.settings} className="st-theme">{error ?
    <div className="st-theme-error"><ErrorState title="显示设置无效" description={error.message} errorId={error.operationId}/>
      <p className="st-note">请修正应用外观设置后重新载入插件。</p></div> : children}</ControlThemeProvider>;
}
