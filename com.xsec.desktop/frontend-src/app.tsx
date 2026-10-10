import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Badge, ControlButton, Dialog, EmptyState, ErrorState, Field, PageHeader, Section, Select, Spinner, Toolbar } from '@xsec/ui-react';
import { List, Maximize2, RefreshCw, TerminalSquare } from 'lucide-react';
import type { SettingsController, TerminalController } from './controller';

export function TerminalApp({ controller }: { controller: TerminalController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const screen = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [confirmId, setConfirmId] = useState<string>();
  useLayoutEffect(() => {
    if (!screen.current) throw Error('终端显示区域缺失');
    controller.attachScreen(screen.current);
    return controller.detachScreen;
  }, [controller]);
  const busy = Boolean(state.pending), unavailable = state.phase === 'loading' || state.phase === 'paused' || !state.terminalId;
  const closeOpen = confirmId !== undefined && confirmId === state.terminalId && state.controlling && !state.ended;
  return <main className="st-terminal">
    <header className="st-heading"><TerminalSquare size={18} aria-hidden="true"/><h1 title={state.title}>{state.title}</h1>
      <Badge tone={state.ended ? 'neutral' : state.controlling ? 'success' : 'neutral'}>
        {state.phase === 'paused' ? '已暂停' : state.ended ? '已结束' : state.controlling ? '正在控制' : '观察中'}</Badge></header>
    <Toolbar className="st-toolbar" aria-label="终端操作">
      <div className="st-actions"><ControlButton variant="ghost" size="sm" disabled={unavailable} aria-expanded={state.listOpen}
        aria-controls="st-terminal-list" onClick={controller.toggleList}><List size={15} aria-hidden="true"/>终端列表</ControlButton>
        <ControlButton variant="ghost" size="sm" disabled={unavailable} onClick={() => void controller.reveal()}><Maximize2 size={15} aria-hidden="true"/>显示</ControlButton></div>
      <div className="st-actions">
        {state.controlling ? <ControlButton variant="outline" size="sm" loading={state.pending === 'release'} disabled={busy || state.ended}
          onClick={() => void controller.changeControl('release')}>释放控制</ControlButton> : <>
          <ControlButton size="sm" loading={state.pending === 'acquire'} disabled={unavailable || busy || state.ended}
            onClick={() => void controller.changeControl('acquire')}>获取控制</ControlButton>
          <ControlButton variant="outline" size="sm" loading={state.pending === 'takeover'} disabled={unavailable || busy || state.ended}
            onClick={() => void controller.changeControl('takeover')}>接管</ControlButton></>}
        <ControlButton ref={closeButton} variant="ghost" size="sm" disabled={unavailable || busy || !state.controlling || state.ended}
          onClick={() => setConfirmId(state.terminalId)}>终止终端</ControlButton>
      </div>
    </Toolbar>
    {state.listOpen ? <section className="st-list" id="st-terminal-list" aria-label="当前会话终端">
      <div className="st-list-heading"><h2>当前会话终端</h2><ControlButton variant="ghost" size="sm" loading={state.listLoading}
        onClick={() => void controller.loadList()}><RefreshCw size={15} aria-hidden="true"/>刷新</ControlButton></div>
      {state.listLoading ? <Spinner label="正在读取终端列表"/> : state.listError ? <ErrorState title="读取终端列表失败"
        description={state.listError.message} errorId={state.listError.operationId}
        action={<ControlButton variant="outline" onClick={() => void controller.loadList()}>重新读取</ControlButton>}/> : state.items?.length === 0 ?
        <EmptyState title="当前会话没有终端"/> : <ul>{state.items?.map(item => <li key={item.terminal_id}>
          <ControlButton variant="ghost" className="st-terminal-row" aria-current={item.terminal_id === state.terminalId ? 'true' : undefined}
            onClick={() => void controller.reveal(item.terminal_id)}><span title={item.title}>{item.title}</span>
            <Badge tone={item.state === 'running' ? 'success' : 'neutral'}>{item.state === 'running' ? '运行中' : item.state === 'exited' ? '已退出' : '已终止'}</Badge></ControlButton></li>)}</ul>}
    </section> : null}
    {state.error ? <div className="st-feedback"><ErrorState title="终端操作失败" description={state.error.message} errorId={state.error.operationId}
      action={state.phase === 'failed' ? <ControlButton variant="outline" loading={state.pending === 'reconnect'} disabled={busy}
        onClick={() => void controller.reconnect()}>重新连接</ControlButton> : undefined}/></div> : null}
    <div className="st-screen-container"><div ref={screen} className="st-screen" aria-label="终端屏幕"/>
      {state.phase === 'loading' ? <div className="st-screen-message"><Spinner label="正在连接终端"/></div> :
        state.phase === 'paused' ? <div className="st-screen-message"><EmptyState title="终端显示已暂停" description="重新显示页面后继续读取终端输出。"/></div> : null}</div>
    {state.ended ? <p className="st-note st-footer" role="status">终端已结束。可通过终端列表查看其他终端。</p> :
      state.phase === 'ready' && !state.controlling ? <p className="st-note st-footer">获取控制后可输入；接管会替换当前控制者。</p> : null}
    <Dialog className="st-close-dialog" open={closeOpen} onOpenChange={open => { if (!open) setConfirmId(undefined); }} title="终止当前终端"
      description="此操作将结束 Shell 和正在运行的进程。" finalFocus={closeButton} preventOutsideDismissal={busy}
      footer={<><ControlButton variant="outline" disabled={busy} onClick={() => setConfirmId(undefined)}>返回终端</ControlButton>
        <ControlButton variant="danger" loading={state.pending === 'close'} disabled={busy || !closeOpen} onClick={() => {
          setConfirmId(undefined); void controller.changeControl('close');
        }}>终止终端</ControlButton></>}><p className="st-confirm-title">{state.title}</p></Dialog>
  </main>;
}
export function SettingsApp({ controller }: { controller: SettingsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot), settings = state.settings;
  return <main className="st-settings"><PageHeader title="系统终端" description="设置之后新建终端使用的 Shell。"/>
    {state.paused ? <EmptyState title="终端设置已暂停" description="重新显示页面后读取当前设置。"/> : null}
    {state.loading ? <Spinner label="正在读取终端设置"/> : null}
    {state.error ? <ErrorState title={settings ? '保存终端设置失败' : '读取终端设置失败'} description={state.error.message}
      errorId={state.error.operationId} action={!settings ? <ControlButton variant="outline" onClick={() => void controller.load()}>重新读取</ControlButton> : undefined}/> : null}
    {settings ? <Section title={settings.platform === 'windows' ? 'Windows 默认终端' : '系统登录 Shell'}>
      <Field label="默认 Shell" hint={settings.platform === 'windows' ? '保存后仅影响之后新建的终端。' : 'macOS 和 Linux 使用当前账户的系统登录 Shell。'}>
        {props => <Select {...props} value={state.profileId ?? ''} disabled={state.saving || settings.platform !== 'windows'}
          onValueChange={value => { if (value === null) throw Error('Shell 选择值无效'); controller.select(value === '' ? null : value); }}
          options={[{ value: '', label: '跟随系统默认 Shell' }, ...settings.profiles.map(profile => ({ value: profile.id,
            label: profile.label + (profile.is_default ? '（系统默认）' : '') }))]}/>}</Field>
      <p className="st-note">当前 Shell：{settings.profiles.find(profile => profile.id === settings.effectiveProfileId)?.label ?? '系统默认'}</p>
      {settings.platform === 'windows' ? <div className="st-settings-actions"><ControlButton loading={state.saving}
        disabled={state.profileId === settings.configuredProfileId} onClick={() => void controller.save()}>保存默认 Shell</ControlButton>
        {state.saved ? <span role="status" className="st-saved">默认 Shell 已保存</span> : null}</div> : null}
    </Section> : null}
  </main>;
}
