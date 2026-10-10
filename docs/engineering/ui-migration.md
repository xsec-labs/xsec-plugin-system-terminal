# 系统终端公共 UI

任务起点为 `b51148f766557098beb9088b218aadf84f99caf0`，插件版本为 4.0.0。
终端工具栏、状态、列表、空态、错误、终止确认与 Shell 设置采用公共组件。
主题同步覆盖 Host 明暗、密度、字号、代码字体与减少动效；窄屏和触控按钮
至少 44×44px。浅色与深色终端分别配置 ANSI 16 色。

## 状态与运行边界

`TerminalController` 持有终端连接和唯一业务快照；React 订阅快照。
会话、资源与可见状态变化会使先前 epoch 失效。迟到创建、获取控制和重新连接
结果按当前绑定处理，卸载释放控制并 detach，PTY 由 Runtime 会话继续持有。
终止需要显式确认并携带当前租约。获取、接管、释放、输入及尺寸变更继续通过
受权限和绑定校验的 Host API。读取失败显示错误与操作 ID，重新连接由用户触发。

Shell 设置使用真实 Host 读取；Windows 保存后再次读取并核对配置和生效值。
macOS/Linux 使用系统登录 Shell。输入和输出仍使用 xterm 6、Fit 0.11、Unicode11
0.9、游标读取及有界历史。MCP、Skill、11 个 Agent Tool 绑定和持久化格式沿用起点。

## 依赖与制品

React/React DOM 18.3.1、ui-react 0.1.7、design tokens 0.1.2、Lucide 0.468.0
由锁文件固定；公共包 vendor 中的 SHA-256 在构建前校验。
输出包含单一 ESM 入口、第三方许可证和 CycloneDX 1.6 SBOM。
`check:generated` 重新生成并逐字节核对这三项制品。构建目标为 Safari 16、
Chrome 105、ES2022；最低版本运行仍需要对应浏览器验收。

## 验证范围

构建、类型、静态契约和真实 Host/浏览器检查通过工作区资源控制器执行。
本机验收采用隔离 macOS arm64 Host、真实 PTY、真实设置以及 Chromium。
既有结果包括 17 项业务流程、8 项生命周期和 40 组视觉场景，覆盖 320、375、
768、1280、1920px，明暗、comfortable/compact、14/18px 字号。
补充的 5 项真实 Runtime 竞态检查通过：open/acquire/release/close 响应延迟时卸载、
重复 dispose 的 Promise 身份、卸载后调用拒绝、迟到旧状态跨释放与重新获取。
Host 等待已受理的所有权操作，再释放其留下的租约；释放和终止各执行一次。
原生最终入口通过真实 PTY 中文与 emoji 输出、macOS Shell 设置和开发日志验收。

## 性能与成本

同一真实 PTY 下采用 4 组 ABBA，每侧 8 个新 Chromium context。就绪中位数
109.05→104.15ms；列表提交 4.70→7.85ms、绘制 36.40→34.15ms；输入提交
47.50→46.10ms、绘制 80.45→78.95ms。提交增加 3.15ms，最终绘制维持原场景水平。
gzip 104,389→211,279 bytes；GC 后稳定、列表、交互堆分别为
14,203,670→15,795,932、14,240,706→15,904,900、15,503,740→17,351,700 bytes。
超过 10% 的项已调查：包体主要来自 React DOM、Base UI 与公共组件，单一 ESM
只包含一份 React 运行时。为统一交互和主题接受 106,890 bytes gzip 与约
1.59–1.85 MB JS 堆增量。JS 堆与浏览器计时不代表原生进程 RSS 或原生性能。

最终产品门禁 `33fea002-cb14-4bde-a786-89332c80fe02` 包含类型、生成物逐字节、
5 项静态契约、CLI validate/pack 与 Host 包完整性检查。耗时 4.013s，采样峰值
RSS 337,330,176 bytes，物理卷增量 3,297,280 bytes，swap 61,603,840 bytes 前后一致。
性能入口 `4c8df4eb-339a-4b65-9261-402d2b44eb12` 耗时 21.704s，采样峰值 RSS
797,507,584 bytes，卷增量 2,482,176 bytes。编译缓存按仓库 diagnostic 档共享。

证据目录：
`/Users/xiaosong/.codex/visualizations/2026/10/02/01a0faad-6517-7cd3-90b5-b818bc64660d/plugin-system-terminal-ui`。

Windows x64、Linux x64、macOS Intel、Safari 16、输入法、屏幕阅读器、
长会话、原生性能、正式安装和发布未验证。跨平台 Host Smoke 按仓库风险规则选择。

## 回滚

回滚本批提交时同时恢复前端源码、vendor、锁文件、构建脚本和三个生成物。
本批未改变插件版本、MCP/Skill 协议或持久化数据格式；Host 生命周期修复按其
独立提交回滚。发布和生产安装分别执行对应流程。
