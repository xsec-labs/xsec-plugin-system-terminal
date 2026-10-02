# 系统终端 MCP

`com.xsec.system-terminal` 4.0.0 交付共享 PTY 的 xterm 界面、原生 stdio MCP Server
和 `system-terminal` Skill。Desktop/Web 用户与 Agent 访问同一 Runtime 会话；Host
持有 Shell、工作目录、进程组、权限和审计。

源码位于 [xsec-labs/xsec-plugin-system-terminal](https://github.com/xsec-labs/xsec-plugin-system-terminal)。
市场制品与 Factory 发布记录位于 [xsec-labs/xsec-plugins](https://github.com/xsec-labs/xsec-plugins)。
源码仓库保持 `beta` 开发、审查验证后合并 `main` 的发布流程。

## 包与契约

版本组合为 Terminal Host Service 2.0.0、Plugin API 1.7.0、插件 4.0.0。
`plugin.json` 声明 `^1.7.0`、一个 MCP Server、一个 Skill、11 个 parent/sub Agent Tool
绑定，以及安装和升级所需权限。`.codex-plugin/plugin.json` 与 Cargo package 使用相同插件版本。

工具为 `terminal_profiles`、`terminal_open`、`terminal_list`、`terminal_read`、
`terminal_write`、`terminal_resize`、`terminal_reveal`、`terminal_close`、
`terminal_control_status`、`terminal_control_acquire`、`terminal_control_release`。
参数 schema 以 MCP `tools/list` 为准。

`terminal_open` 返回完整 control lease。write、resize、close 携带动作触发时的租约；
显式 acquire、takeover 和 release 管理控制权，过期租约在副作用前被 Host 拒绝。
observer 通过 attach 与独立 cursor read 读取；界面卸载释放控制并 detach，PTY 继续运行。
close 终止 PTY；会话结束、插件撤销或 Runtime 退出按 Host 生命周期回收资源。

## 构建与验证

前端源码位于 `com.xsec.desktop/frontend-src/`，交付模块位于
`com.xsec.desktop/frontend/index.js`。`mcp.json` 引用平台匹配的
`bin/system-terminal-mcp`（Windows 为 `.exe`），执行上下文由 Host 提供。

在工作区先运行资源控制器的 status 与 changed plan，再通过统一构建槽执行所选命令。
复用 pnpm store 和共享 Cargo target。包的实际构建入口为：

```sh
rtk pnpm build:frontend
rtk pnpm build:mcp
```

开发 sidecar 与发布制品分别由对应构建流程生成。Desktop 的
`plugin:system-terminal:pack` 和 `test:system-terminal-artifact` 负责平台包与完整性检查。
Host/API 与插件成套升级。Windows、Linux、macOS arm64/x86_64 按受影响边界选择实际验收目标。
当前导入候选的验证状态见迁移预检记录；发布前须完成接收仓库的门禁与实际 Host/Agent 验收。
