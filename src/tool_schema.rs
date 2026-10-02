use rmcp::model::Tool;
use serde_json::{json, Map, Value};

const TOOLS: &[(&str, &str)] = &[
    (
        "terminal_profiles",
        "Return the Host platform and available shell profiles.",
    ),
    (
        "terminal_open",
        "Create a session-shared PTY and reveal it in the user bottom dock.",
    ),
    (
        "terminal_list",
        "List all system terminals in the current session.",
    ),
    (
        "terminal_read",
        "Read non-consuming UTF-8 terminal output from an independent cursor.",
    ),
    (
        "terminal_write",
        "Write raw terminal input, including control characters, without retries.",
    ),
    (
        "terminal_resize",
        "Resize the PTY using the exact control lease.",
    ),
    (
        "terminal_control_status",
        "Inspect the terminal controller and current generation.",
    ),
    (
        "terminal_control_acquire",
        "Acquire terminal control; takeover must be explicitly selected.",
    ),
    (
        "terminal_control_release",
        "Release the exact terminal control lease while preserving the PTY.",
    ),
    (
        "terminal_reveal",
        "Reveal an existing hidden session terminal in the user bottom dock.",
    ),
    (
        "terminal_close",
        "Explicitly terminate a terminal process and return its final state.",
    ),
];

pub fn tool_descriptors() -> Vec<Tool> {
    TOOLS
        .iter()
        .map(|(name, description)| Tool::new(*name, *description, schema(name)))
        .collect()
}

pub fn host_method(tool: &str) -> Result<&'static str, String> {
    match tool {
        "terminal_profiles" => Ok("xsec.terminal.profiles"),
        "terminal_open" => Ok("xsec.terminal.open"),
        "terminal_list" => Ok("xsec.terminal.list"),
        "terminal_read" => Ok("xsec.terminal.read"),
        "terminal_write" => Ok("xsec.terminal.write"),
        "terminal_resize" => Ok("xsec.terminal.resize"),
        "terminal_control_status" => Ok("xsec.terminal.control.status"),
        "terminal_control_acquire" => Ok("xsec.terminal.control.acquire"),
        "terminal_control_release" => Ok("xsec.terminal.control.release"),
        "terminal_reveal" => Ok("xsec.terminal.reveal"),
        "terminal_close" => Ok("xsec.terminal.close"),
        _ => Err(format!("unknown system-terminal MCP tool: {tool}")),
    }
}

fn control_schema() -> Value {
    json!({
        "type": "object", "additionalProperties": false,
        "required": ["version", "instanceId", "accountContext", "epoch", "kind", "resourceId", "clientId", "leaseId", "generation"],
        "properties": {
            "version": { "const": 1 }, "instanceId": { "type": "string", "format": "uuid" },
            "accountContext": { "type": "string", "minLength": 1 }, "epoch": { "type": "integer", "minimum": 1 },
            "kind": { "const": "terminal" }, "resourceId": { "type": "string", "minLength": 1, "maxLength": 256 },
            "clientId": { "type": "string", "format": "uuid" }, "leaseId": { "type": "string", "format": "uuid" },
            "generation": { "type": "integer", "minimum": 1 }
        }
    })
}

fn schema(tool: &str) -> Map<String, Value> {
    let value = match tool {
        "terminal_profiles" | "terminal_list" => {
            json!({ "type": "object", "additionalProperties": false })
        }
        "terminal_open" => json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "title": { "type": "string", "maxLength": 256 },
                "cwd": { "type": "string", "maxLength": 4096 },
                "profile_id": { "type": "string", "maxLength": 128 },
                "cols": { "type": "integer", "minimum": 20, "maximum": 400 },
                "rows": { "type": "integer", "minimum": 2, "maximum": 200 }
            }
        }),
        "terminal_read" => json!({
            "type": "object", "additionalProperties": false, "required": ["terminal_id"],
            "properties": {
                "terminal_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "cursor": { "type": "integer", "minimum": 0 },
                "max_bytes": { "type": "integer", "minimum": 1, "maximum": 65536 },
                "wait_ms": { "type": "integer", "minimum": 0, "maximum": 5000 }
            }
        }),
        "terminal_write" => json!({
            "type": "object", "additionalProperties": false, "required": ["terminal_id", "data", "control"],
            "properties": {
                "terminal_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "data": { "type": "string", "minLength": 1, "maxLength": 65536 }, "control": control_schema()
            }
        }),
        "terminal_resize" => json!({
            "type": "object", "additionalProperties": false, "required": ["terminal_id", "cols", "rows", "control"],
            "properties": {
                "terminal_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "cols": { "type": "integer", "minimum": 20, "maximum": 400 },
                "rows": { "type": "integer", "minimum": 2, "maximum": 200 }, "control": control_schema()
            }
        }),
        "terminal_reveal" | "terminal_control_status" => json!({
            "type": "object", "additionalProperties": false, "required": ["terminal_id"],
            "properties": { "terminal_id": { "type": "string", "minLength": 1, "maxLength": 128 } }
        }),
        "terminal_control_acquire" => json!({
            "type": "object", "additionalProperties": false, "required": ["terminal_id", "takeover"],
            "properties": {
                "terminal_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "takeover": { "type": "boolean" }
            }
        }),
        "terminal_close" | "terminal_control_release" => json!({
            "type": "object", "additionalProperties": false, "required": ["terminal_id", "control"],
            "properties": {
                "terminal_id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "control": control_schema()
            }
        }),
        _ => unreachable!("tool descriptor table is fixed"),
    };
    value
        .as_object()
        .cloned()
        .expect("system terminal schemas are objects")
}

#[cfg(test)]
mod tests {
    use super::{host_method, tool_descriptors};

    #[test]
    fn exposes_session_terminal_and_control_tools() {
        let names = tool_descriptors()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "terminal_profiles",
                "terminal_open",
                "terminal_list",
                "terminal_read",
                "terminal_write",
                "terminal_resize",
                "terminal_control_status",
                "terminal_control_acquire",
                "terminal_control_release",
                "terminal_reveal",
                "terminal_close",
            ]
        );
        assert_eq!(host_method("terminal_read").unwrap(), "xsec.terminal.read");
    }
}
