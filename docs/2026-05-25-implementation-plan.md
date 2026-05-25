# opencode-datadog-monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenCode plugin that sends session, tool, and LLM usage traces to Datadog LLM Observability.

**Architecture:** `dd-trace` initialized with `plugins: false` and `llmobs` in agentless mode. Plugin hooks map OpenCode events to LLM Obs spans (agent/tool/llm). Config loaded from sidecar JSON file with env var overrides.

**Tech Stack:** TypeScript, dd-trace, @opencode-ai/plugin, strip-json-comments

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `LICENSE`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "opencode-datadog-monitor",
  "version": "0.1.0",
  "description": "Datadog LLM Observability plugin for OpenCode sessions and tool calls",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "prepublishOnly": "npm run typecheck && npm run build"
  },
  "keywords": [
    "opencode",
    "plugin",
    "datadog",
    "llm-observability",
    "observability"
  ],
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
  "dependencies": {
    "dd-trace": "^5.0.0",
    "strip-json-comments": "^5.0.1"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "@types/node": "^22.13.10",
    "typescript": "^5.8.2"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": [
      "node"
    ]
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
*.tgz
```

- [ ] **Step 4: Create LICENSE**

MIT license with current year.

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore LICENSE package-lock.json
git commit -m "chore: project scaffolding"
```

---

### Task 2: Config loading

**Files:**
- Create: `src/config.ts`

- [ ] **Step 1: Create config types and defaults**

```typescript
import type { PluginInput } from "@opencode-ai/plugin";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";

const CONFIG_FILE_NAMES = [
  "datadog-monitor.json",
  "datadog-monitor.jsonc",
] as const;

const DEFAULTS = {
  site: "datadoghq.com",
  recordInputs: true,
  recordOutputs: true,
  tags: {} as Record<string, string>,
} as const;

export interface PluginConfig {
  site?: string;
  mlApp?: string;
  env?: string;
  service?: string;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  tags?: Record<string, string>;
}

export interface ResolvedPluginConfig {
  site: string;
  mlApp?: string;
  env?: string;
  service?: string;
  recordInputs: boolean;
  recordOutputs: boolean;
  tags: Record<string, string>;
}

export interface LoadedPluginConfig {
  source: string;
  config: ResolvedPluginConfig;
}
```

- [ ] **Step 2: Add config file discovery**

```typescript
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function addUnique(list: string[], value: string | undefined): void {
  if (!value || list.includes(value)) return;
  list.push(value);
}

async function getCandidatePaths(input: PluginInput): Promise<string[]> {
  const candidates: string[] = [];

  const explicitPath = process.env.OPENCODE_DD_CONFIG;
  if (explicitPath) {
    const resolved = isAbsolute(explicitPath)
      ? explicitPath
      : resolve(input.directory, explicitPath);
    addUnique(candidates, resolved);
  }

  const configDirs: string[] = [];
  addUnique(configDirs, join(input.directory, ".opencode"));

  if (process.env.OPENCODE_CONFIG_DIR) {
    addUnique(configDirs, resolve(process.env.OPENCODE_CONFIG_DIR));
  }
  if (process.env.OPENCODE_CONFIG) {
    addUnique(configDirs, dirname(resolve(process.env.OPENCODE_CONFIG)));
  }

  const home = homedir();
  if (home) {
    addUnique(configDirs, join(home, ".config", "opencode"));
  }

  for (const dir of configDirs) {
    for (const fileName of CONFIG_FILE_NAMES) {
      addUnique(candidates, join(dir, fileName));
    }
  }

  return candidates;
}
```

- [ ] **Step 3: Add validation and env overrides**

```typescript
function parseBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseTagsEnv(name: string): Record<string, string> | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const tags: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const idx = pair.indexOf(":");
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (key.length > 0 && val.length > 0) {
        tags[key] = val;
      }
    }
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function normalizeConfig(raw: Record<string, unknown>): ResolvedPluginConfig {
  return {
    site:
      (typeof raw.site === "string" ? raw.site.trim() : undefined) ||
      DEFAULTS.site,
    mlApp: typeof raw.mlApp === "string" ? raw.mlApp.trim() : undefined,
    env: typeof raw.env === "string" ? raw.env.trim() : undefined,
    service: typeof raw.service === "string" ? raw.service.trim() : undefined,
    recordInputs:
      typeof raw.recordInputs === "boolean"
        ? raw.recordInputs
        : DEFAULTS.recordInputs,
    recordOutputs:
      typeof raw.recordOutputs === "boolean"
        ? raw.recordOutputs
        : DEFAULTS.recordOutputs,
    tags:
      raw.tags && typeof raw.tags === "object" && !Array.isArray(raw.tags)
        ? (raw.tags as Record<string, string>)
        : DEFAULTS.tags,
  };
}

function addEnvOverrides(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const withEnv = { ...raw };

  if (process.env.DD_SITE) withEnv.site = process.env.DD_SITE;
  if (process.env.DD_LLMOBS_ML_APP) withEnv.mlApp = process.env.DD_LLMOBS_ML_APP;
  if (process.env.DD_ENV) withEnv.env = process.env.DD_ENV;
  if (process.env.DD_SERVICE) withEnv.service = process.env.DD_SERVICE;

  const recordInputs = parseBooleanEnv("OPENCODE_DD_RECORD_INPUTS");
  if (recordInputs !== undefined) withEnv.recordInputs = recordInputs;

  const recordOutputs = parseBooleanEnv("OPENCODE_DD_RECORD_OUTPUTS");
  if (recordOutputs !== undefined) withEnv.recordOutputs = recordOutputs;

  const tags = parseTagsEnv("OPENCODE_DD_TAGS");
  if (tags) {
    withEnv.tags = {
      ...(withEnv.tags as Record<string, string> | undefined),
      ...tags,
    };
  }

  return withEnv;
}
```

- [ ] **Step 4: Add the main loadPluginConfig export**

```typescript
export async function loadPluginConfig(
  input: PluginInput,
): Promise<LoadedPluginConfig | null> {
  if (!process.env.DD_API_KEY) {
    return null;
  }

  const candidates = await getCandidatePaths(input);
  let source = "environment";
  let raw: Record<string, unknown> = {};

  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    const content = await readFile(candidate, "utf-8");
    try {
      const parsed = JSON.parse(stripJsonComments(content));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
        source = candidate;
        break;
      }
    } catch {
      // skip invalid config files
    }
  }

  raw = addEnvOverrides(raw);
  const config = normalizeConfig(raw);
  return { source, config };
}
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors. (May need a stub `src/index.ts` for this — create an empty `export {}` if needed.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts
git commit -m "feat: config loading with file discovery and env overrides"
```

---

### Task 3: Plugin core — tracer init and session lifecycle

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Create the plugin entry point with tracer initialization**

```typescript
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { basename } from "node:path";
import { loadPluginConfig, type ResolvedPluginConfig } from "./config.js";

interface SessionState {
  sessionID: string;
  providerID: string;
  modelID: string;
  completedMessages: Set<string>;
}

const sessions = new Map<string, SessionState>();
const toolSpans = new Map<string, unknown>();

let tracer: typeof import("dd-trace").default | null = null;
let llmobs: ReturnType<typeof import("dd-trace").default["llmobs"]> | null = null;

function getProjectName(
  config: ResolvedPluginConfig,
  input: PluginInput,
): string {
  if (config.mlApp) return config.mlApp;
  if (input.project?.worktree) {
    const name = basename(input.project.worktree);
    if (name.length > 0) return name;
  }
  const guessed = basename(input.directory);
  return guessed.length > 0 ? guessed : "opencode";
}

function getSessionState(sessionID: string): SessionState {
  const existing = sessions.get(sessionID);
  if (existing) return existing;
  const created: SessionState = {
    sessionID,
    providerID: "unknown",
    modelID: "unknown",
    completedMessages: new Set(),
  };
  sessions.set(sessionID, created);
  return created;
}

function getToolSpanKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}
```

- [ ] **Step 2: Add the plugin export with tracer init and chat.params hook**

```typescript
export const DatadogLLMObsPlugin: Plugin = async (input) => {
  const loaded = await loadPluginConfig(input);

  if (!loaded) {
    console.info(
      "[opencode-datadog-monitor] DD_API_KEY not set. Plugin disabled.",
    );
    return {};
  }

  const config = loaded.config;
  const mlApp = getProjectName(config, input);

  // Dynamic import to avoid issues if dd-trace isn't available
  const ddTrace = await import("dd-trace");
  tracer = ddTrace.default;

  tracer.init({
    llmobs: {
      mlApp,
      agentlessEnabled: true,
    },
    site: config.site,
    env: config.env,
    service: config.service,
    plugins: false,
  });

  llmobs = tracer.llmobs;

  console.info("[opencode-datadog-monitor] Plugin enabled", {
    source: loaded.source,
    mlApp,
    site: config.site,
    recordInputs: config.recordInputs,
    recordOutputs: config.recordOutputs,
  });

  return {
    "chat.params": async (hookInput) => {
      try {
        const state = getSessionState(hookInput.sessionID);
        state.providerID = hookInput.model.providerID;
        state.modelID = hookInput.model.id;
      } catch (error) {
        console.warn("[opencode-datadog-monitor] chat.params error", error);
      }
    },
  };
};

export default DatadogLLMObsPlugin;
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors.

Note: `dd-trace` types may be imprecise. If there are type issues with the `llmobs` property or `tracer.init()` options, use type assertions where needed and document them with comments.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: plugin entry point with tracer init and chat.params hook"
```

---

### Task 4: Tool span hooks

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add toolOutputIndicatesError helper**

Add before the plugin export:

```typescript
function toolOutputIndicatesError(output: {
  title: string;
  metadata: unknown;
}): boolean {
  const metadata =
    output.metadata && typeof output.metadata === "object"
      ? (output.metadata as Record<string, unknown>)
      : undefined;
  if (metadata?.error) return true;
  if (
    typeof metadata?.status === "string" &&
    metadata.status.toLowerCase() === "error"
  ) return true;
  return /error/i.test(output.title);
}
```

- [ ] **Step 2: Add tool.execute.before hook**

Inside the returned hooks object from the plugin function, add:

```typescript
    "tool.execute.before": async (hookInput, hookOutput) => {
      try {
        if (!llmobs) return;

        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);

        const span = llmobs.trace(
          {
            kind: "tool",
            name: hookInput.tool,
            sessionId: hookInput.sessionID,
          },
          (span: unknown) => {
            if (config.recordInputs) {
              llmobs.annotate({
                span,
                inputData: JSON.stringify(hookOutput.args),
                tags: config.tags,
              });
            }

            // Store span reference for later completion
            toolSpans.set(key, span);

            // Return span to keep trace context open
            // The span will be finished in tool.execute.after
            return span;
          },
        );
      } catch (error) {
        console.warn("[opencode-datadog-monitor] tool.execute.before error", error);
      }
    },
```

Note: The `llmobs.trace()` callback-based API may not support keeping a span open across separate hooks. If this doesn't work at implementation time, the alternative is to use `tracer.startSpan()` directly with LLM Obs tags, or to investigate `llmobs` internals for a `startSpan`/`finishSpan` pattern. This is the key implementation risk flagged in the design spec. If `llmobs.trace()` finishes the span when the callback returns, we'll need to restructure — likely wrapping the tool execution in a promise that resolves in `tool.execute.after`.

- [ ] **Step 3: Add tool.execute.after hook**

```typescript
    "tool.execute.after": async (hookInput, hookOutput) => {
      try {
        if (!llmobs) return;

        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        const span = toolSpans.get(key);
        toolSpans.delete(key);

        if (!span) return;

        const isError = toolOutputIndicatesError(hookOutput);

        if (config.recordOutputs || isError) {
          llmobs.annotate({
            span,
            outputData: JSON.stringify(hookOutput.output),
            tags: config.tags,
          });
        }
      } catch (error) {
        console.warn("[opencode-datadog-monitor] tool.execute.after error", error);
      }
    },
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: tool execution span hooks"
```

---

### Task 5: Event handler — sessions and LLM spans

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add helper to check assistant message completion**

Add before the plugin export:

```typescript
function isCompletedAssistantMessage(info: unknown): info is {
  id: string;
  role: "assistant";
  sessionID: string;
  modelID: string;
  providerID: string;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: { created: number; completed: number };
} {
  if (!info || typeof info !== "object") return false;
  const msg = info as Record<string, unknown>;
  const time = msg.time as Record<string, unknown> | undefined;
  return (
    msg.role === "assistant" &&
    typeof msg.id === "string" &&
    typeof msg.sessionID === "string" &&
    typeof msg.modelID === "string" &&
    typeof msg.providerID === "string" &&
    typeof time?.completed === "number"
  );
}
```

- [ ] **Step 2: Add event handler**

Inside the returned hooks object, add:

```typescript
    event: async ({ event }) => {
      try {
        if (!llmobs) return;

        switch (event.type) {
          case "session.created": {
            const sessionID = event.properties.info.id;
            getSessionState(sessionID);
            break;
          }

          case "session.idle": {
            const sessionID = event.properties.sessionID;
            llmobs.flush();
            break;
          }

          case "session.deleted": {
            const sessionID = event.properties.info.id;

            // Clean up dangling tool spans
            for (const [key] of toolSpans) {
              if (key.startsWith(`${sessionID}:`)) {
                toolSpans.delete(key);
              }
            }

            sessions.delete(sessionID);
            llmobs.flush();
            break;
          }

          case "session.error": {
            console.error(
              "[opencode-datadog-monitor] session.error",
              event.properties.error,
            );
            llmobs.flush();
            break;
          }

          case "message.updated": {
            const info = event.properties.info;
            if (!isCompletedAssistantMessage(info)) break;

            const state = getSessionState(info.sessionID);
            if (state.completedMessages.has(info.id)) break;
            state.completedMessages.add(info.id);

            state.providerID = info.providerID;
            state.modelID = info.modelID;

            // Create an LLM span for this completed assistant message
            llmobs.trace(
              {
                kind: "llm",
                name: info.modelID,
                modelName: info.modelID,
                modelProvider: info.providerID,
                sessionId: info.sessionID,
              },
              () => {
                llmobs.annotate({
                  metrics: {
                    input_tokens: info.tokens.input,
                    output_tokens: info.tokens.output,
                    total_tokens: info.tokens.input + info.tokens.output,
                  },
                  tags: config.tags,
                });
              },
            );
            break;
          }

          default:
            break;
        }
      } catch (error) {
        console.warn("[opencode-datadog-monitor] event error", error);
      }
    },
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: event handler for sessions and LLM spans"
```

---

### Task 6: Build, README, and publish prep

**Files:**
- Create: `README.md`
- Verify: build output

- [ ] **Step 1: Verify full build**

Run: `npm run build`
Expected: `dist/` directory created with `index.js`, `index.d.ts`, `config.js`, `config.d.ts` and their sourcemaps.

- [ ] **Step 2: Create README.md**

```markdown
# opencode-datadog-monitor

Datadog LLM Observability plugin for OpenCode.

Captures OpenCode session lifecycle, tool execution spans, and LLM token usage into Datadog using the LLM Observability SDK.

## Features

- Session-level `agent` spans
- Tool-level `tool` spans with optional input/output recording
- LLM token usage spans via `message.updated` events
- Agentless mode (no Datadog Agent required)
- Custom tags on all spans
- Sidecar config file support

## Install

1. Add the plugin to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-datadog-monitor"]
}
```

2. Set your Datadog API key:

```shell
export DD_API_KEY=your-api-key
```

3. Optionally create a config file:

```jsonc
// .opencode/datadog-monitor.json
{
  "site": "datadoghq.com",
  "mlApp": "my-project",
  "env": "dev",
  "tags": {
    "team": "platform"
  }
}
```

4. Restart OpenCode.

Traces appear on the [LLM Observability page](https://app.datadoghq.com/llm/traces) in Datadog.

## Config

Config is loaded from the first file found:

1. `OPENCODE_DD_CONFIG` environment variable (explicit path)
2. `.opencode/datadog-monitor.json` (project-level)
3. `~/.config/opencode/datadog-monitor.json` (global)

JSONC (JSON with comments) is supported.

### Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `site` | string | `datadoghq.com` | Datadog site |
| `mlApp` | string | project name | Application name in LLM Obs |
| `env` | string | — | Environment tag |
| `service` | string | — | Service name |
| `recordInputs` | boolean | `true` | Record tool inputs |
| `recordOutputs` | boolean | `true` | Record tool outputs |
| `tags` | object | `{}` | Custom tags |

### Environment Variables

| Variable | Description |
|---|---|
| `DD_API_KEY` | Datadog API key (required) |
| `DD_SITE` | Datadog site |
| `DD_LLMOBS_ML_APP` | Application name |
| `DD_ENV` | Environment |
| `DD_SERVICE` | Service name |
| `OPENCODE_DD_RECORD_INPUTS` | Record tool inputs |
| `OPENCODE_DD_RECORD_OUTPUTS` | Record tool outputs |
| `OPENCODE_DD_TAGS` | Custom tags (`key:value,key:value`) |

## License

MIT
```

- [ ] **Step 3: Verify typecheck one more time**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

### Task 7: Integration testing

**Files:**
- No new files — manual testing in OpenCode

- [ ] **Step 1: Link the plugin locally**

From the project directory, run:

```bash
npm link
```

Then in any OpenCode project, add to `opencode.json`:

```json
{
  "plugin": ["opencode-datadog-monitor"]
}
```

And link it:

```bash
npm link opencode-datadog-monitor
```

- [ ] **Step 2: Run OpenCode with DD_API_KEY set**

```bash
DD_API_KEY=your-key opencode
```

- [ ] **Step 3: Verify traces appear in Datadog**

1. Send a prompt in OpenCode.
2. Wait for the session to idle.
3. Check https://app.datadoghq.com/llm/traces for traces.
4. Verify: agent root span exists, tool child spans exist, LLM spans have token counts.

- [ ] **Step 4: Verify disabled mode**

Run OpenCode without `DD_API_KEY`. Verify the plugin logs "Plugin disabled" and no errors occur.

- [ ] **Step 5: Fix any issues found during testing and commit**

```bash
git add -A
git commit -m "fix: integration testing fixes"
```
