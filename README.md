# opencode-datadog-monitor

Datadog LLM Observability plugin for OpenCode. Captures session lifecycle, tool executions, and LLM token usage as traces in [Datadog LLM Observability](https://docs.datadoghq.com/llm_observability/).

## Features

- Session-level `agent` spans with user input and assistant output
- Tool-level `tool` spans with optional input/output recording
- LLM token usage spans (input, output, total tokens)
- No Datadog Agent required (sends directly to the LLM Observability API)
- Custom tags on all spans
- Sidecar config file support (JSON and JSONC)

## Install

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-datadog-monitor"]
}
```

## Setup

1. Set your [Datadog API key](https://app.datadoghq.com/organization-settings/api-keys):

```sh
export DD_API_KEY=your-api-key
```

2. If you're not on `datadoghq.com`, set your site:

```sh
export DD_SITE=datadoghq.eu
```

3. Optionally create a config file at `.opencode/datadog-monitor.json` or `~/.config/opencode/datadog-monitor.json`:

```json
{
  "site": "datadoghq.eu",
  "mlApp": "my-project",
  "env": "dev"
}
```

4. Restart OpenCode.

Traces appear on the [LLM Observability Traces](https://app.datadoghq.com/llm/traces) page in Datadog.

## Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `site` | string | `datadoghq.com` | Datadog site |
| `mlApp` | string | project directory name | Application name in LLM Observability |
| `env` | string | — | Environment tag |
| `service` | string | — | Service name |
| `recordInputs` | boolean | `true` | Record tool inputs and user messages |
| `recordOutputs` | boolean | `true` | Record tool outputs and assistant responses |
| `tags` | object | `{}` | Custom tags added to all spans |

## Environment Variables

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

## Config Resolution Order

1. `OPENCODE_DD_CONFIG` env var (explicit path)
2. `{project}/.opencode/datadog-monitor.json[c]`
3. `$OPENCODE_CONFIG_DIR/datadog-monitor.json[c]`
4. `dirname($OPENCODE_CONFIG)/datadog-monitor.json[c]`
5. `~/.config/opencode/datadog-monitor.json[c]`

Environment variables always override file config values.

## How It Works

The plugin hooks into OpenCode's event system and sends traces to the [LLM Observability HTTP API](https://docs.datadoghq.com/llm_observability/instrumentation/api). Each session turn produces a trace with:

- An **agent** root span representing the full turn (user prompt → assistant response)
- **tool** child spans for each tool execution (bash, read, edit, etc.)
- **llm** child spans for each model call with token metrics

No Datadog Agent or `dd-trace` dependency is required. The plugin uses `fetch()` to POST spans directly to the intake API.

## License

MIT
