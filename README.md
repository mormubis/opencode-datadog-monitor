# opencode-datadog-monitor

Datadog LLM Observability plugin for OpenCode. Captures OpenCode session lifecycle, tool execution spans, and LLM token usage into Datadog using the LLM Observability SDK.

## Features

- Session-level `agent` spans
- Tool-level `tool` spans with optional input/output recording
- LLM token usage spans via `message.updated` events
- Agentless mode (no Datadog Agent required)
- Custom tags on all spans
- Sidecar config file support (JSON and JSONC)

## Install

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["opencode-datadog-monitor"]
}
```

## Setup

Set your Datadog API key:

```sh
export DD_API_KEY=your-api-key
```

Optionally create a config file at `.opencode/datadog-monitor.json` (project-level) or `~/.config/opencode/datadog-monitor.json` (global).

## Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `site` | string | `datadoghq.com` | Datadog site |
| `mlApp` | string | project name | Application name in LLM Observability |
| `env` | string | — | Environment tag |
| `service` | string | — | Service name |
| `recordInputs` | boolean | `true` | Record tool inputs |
| `recordOutputs` | boolean | `true` | Record tool outputs |
| `tags` | object | `{}` | Custom tags added to all spans |

## Environment variables

| Variable | Description |
|---|---|
| `DD_API_KEY` | **Required.** Datadog API key |
| `DD_SITE` | Datadog site (overrides `site`) |
| `DD_LLMOBS_ML_APP` | Application name (overrides `mlApp`) |
| `DD_ENV` | Environment tag (overrides `env`) |
| `DD_SERVICE` | Service name (overrides `service`) |
| `OPENCODE_DD_RECORD_INPUTS` | Record tool inputs (`true`/`false`) |
| `OPENCODE_DD_RECORD_OUTPUTS` | Record tool outputs (`true`/`false`) |
| `OPENCODE_DD_TAGS` | Comma-separated `key:value` tags |

## Config resolution order

The plugin searches for a config file in this order and uses the first one found:

1. `OPENCODE_DD_CONFIG` env var (explicit path)
2. `{project}/.opencode/datadog-monitor.json[c]`
3. `$OPENCODE_CONFIG_DIR/datadog-monitor.json[c]`
4. `dirname($OPENCODE_CONFIG)/datadog-monitor.json[c]`
5. `~/.config/opencode/datadog-monitor.json[c]`

Environment variables always override file config values.

## Example config

```json
{
  "site": "datadoghq.com",
  "mlApp": "my-opencode-project",
  "env": "development",
  "service": "opencode",
  "recordInputs": true,
  "recordOutputs": false,
  "tags": {
    "team": "platform",
    "project": "my-project"
  }
}
```

## License

MIT
