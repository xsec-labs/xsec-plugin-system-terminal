from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_SOURCE = ROOT / "com.xsec.desktop" / "frontend-src" / "index.ts"
FRONTEND_ARTIFACT = ROOT / "com.xsec.desktop" / "frontend" / "index.js"
EXPECTED_TOOLS = {
    "terminal-profiles": "terminal_profiles",
    "terminal-open": "terminal_open",
    "terminal-list": "terminal_list",
    "terminal-read": "terminal_read",
    "terminal-write": "terminal_write",
    "terminal-resize": "terminal_resize",
    "terminal-reveal": "terminal_reveal",
    "terminal-close": "terminal_close",
    "terminal-control-status": "terminal_control_status",
    "terminal-control-acquire": "terminal_control_acquire",
    "terminal-control-release": "terminal_control_release",
}
CONTROL_MUTATIONS = {
    "xsec.terminal.write",
    "xsec.terminal.resize",
    "xsec.terminal.close",
    "xsec.terminal.control.release",
}


class SystemTerminalMcpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
        self.mcp = json.loads((ROOT / "mcp.json").read_text(encoding="utf-8"))
        self.source = FRONTEND_SOURCE.read_text(encoding="utf-8")

    def test_plugin_declares_one_mcp_one_skill_and_eleven_parent_sub_tools(self) -> None:
        extension = self.manifest["extensions"]["com.xsec.desktop"]
        metadata = json.loads((ROOT / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(self.manifest["name"], "com.xsec.system-terminal")
        self.assertEqual(self.manifest["version"], "4.0.0")
        self.assertEqual(metadata["name"], self.manifest["name"])
        self.assertEqual(metadata["version"], self.manifest["version"])
        self.assertEqual(extension["displayName"], "系统终端 MCP")
        self.assertEqual(extension["engines"]["pluginApi"], "^1.7.0")
        self.assertTrue((ROOT / "skills/system-terminal/SKILL.md").is_file())
        bindings = extension["contributes"]["agentTools"]
        self.assertEqual(
            {binding: value["mcpTool"] for binding, value in bindings.items()},
            EXPECTED_TOOLS,
        )
        for binding in bindings.values():
            self.assertEqual(binding["roles"], ["parent", "sub"])
            self.assertEqual(binding["mcpServer"], "system-terminal")
            self.assertEqual(binding["workspaceToolId"], "system-terminal")
            self.assertEqual(binding["permission"], "terminal.shell:session.agent")
            self.assertIn(binding["permission"], extension["permissions"])

    def test_mcp_entrypoint_is_the_platform_native_sidecar(self) -> None:
        server = self.mcp["mcpServers"]["system-terminal"]
        self.assertEqual(server["type"], "stdio")
        self.assertEqual(server["command"], "./bin/system-terminal-mcp")
        self.assertEqual(server["cwd"], "${PLUGIN_DATA}")

    def test_frontend_uses_cursor_reads_and_detaches_without_terminating(self) -> None:
        self.assertIn('call("xsec.terminal.attach", { terminalId: existing })', self.source)
        self.assertIn('call("xsec.terminal.read", {', self.source)
        self.assertIn("cursor = result.next_cursor", self.source)
        self.assertIn("result.truncated", self.source)
        dispose = self.source.split("async dispose()", 1)[1]
        self.assertIn('call("xsec.terminal.detach", { terminalId })', dispose)
        self.assertIn('call("xsec.terminal.control.release",', dispose)
        self.assertNotIn('call("xsec.terminal.close"', dispose)

    def test_frontend_uses_host_validated_terminal_operations(self) -> None:
        methods = set(re.findall(r'(?:call|host\.request)\("(xsec\.terminal\.[^"]+)"', self.source))
        declared = self.manifest["extensions"]["com.xsec.desktop"]["frontendApi"]["methods"]
        self.assertTrue(methods <= set(declared))
        checked = set()
        # This is a source contract gate; Host/PTY/browser tests prove execution.
        for method_expression, payload in re.findall(r'call\(([^,\n]+),\s*\{([^{}]*)\}\)', self.source):
            targets = set(re.findall(r'"(xsec\.terminal\.[^"]+)"', method_expression))
            mutations = targets & CONTROL_MUTATIONS
            if mutations:
                self.assertRegex(payload, r"\bterminalId\b")
                self.assertRegex(payload, r"\bcontrol\s*:")
                checked.update(mutations)
        self.assertEqual(checked, CONTROL_MUTATIONS)
        for method in CONTROL_MUTATIONS | {
            "xsec.terminal.control.acquire", "xsec.terminal.control.status"
        }:
            self.assertEqual(declared[method], {"capability": "terminal.shell", "binding": "session"})
        self.assertIn('call("xsec.terminal.reveal", { terminalId })', self.source)

    def test_built_frontend_and_skill_follow_the_declared_contract(self) -> None:
        self.assertTrue(FRONTEND_ARTIFACT.is_file())
        self.assertGreater(FRONTEND_ARTIFACT.stat().st_size, 10_000)
        skill = (ROOT / "skills/system-terminal/SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(skill.startswith("---\nname: system-terminal\n"))
        self.assertIn("tools/list", skill)
        self.assertIn("terminal_reveal", skill)
        self.assertIn("terminal_control_acquire", skill)
        self.assertIn("terminal_control_release", skill)


if __name__ == "__main__":
    unittest.main()
