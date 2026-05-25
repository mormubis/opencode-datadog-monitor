import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { loadPluginConfig, type ResolvedPluginConfig } from "./config.js";

// ──────────────────────────────────────────────────────────────────────────────
// HTTP API span types (matches Datadog LLM Obs intake format)
// ──────────────────────────────────────────────────────────────────────────────

interface SpanMeta {
  kind: "agent" | "workflow" | "llm" | "tool" | "task" | "embedding" | "retrieval";
  input?: { value?: string; messages?: Array<{ role: string; content: string }> };
  output?: { value?: string; messages?: Array<{ role: string; content: string }> };
  model_name?: string;
  model_provider?: string;
  metadata?: Record<string, string | number | boolean>;
  error?: { message: string; type: string };
}

interface Span {
  name: string;
  span_id: string;
  trace_id: string;
  parent_id: string;
  start_ns: number;
  duration: number;
  meta: SpanMeta;
  status?: "ok" | "error";
  metrics?: Record<string, number>;
  session_id?: string;
  tags?: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Session and span state
// ──────────────────────────────────────────────────────────────────────────────

interface SessionState {
  sessionID: string;
  traceID: string;
  agentSpanID: string;
  agentStartNs: number;
  providerID: string;
  modelID: string;
  completedMessages: Set<string>;
  lastUserInput?: string;
  lastAssistantOutput?: string;
}

interface ToolContext {
  startNs: number;
  spanID: string;
  args: unknown;
}

const sessions = new Map<string, SessionState>();
const toolContexts = new Map<string, ToolContext>();
const messageRoles = new Map<string, string>();
const pendingSpans: Span[] = [];

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function nowNs(): number {
  return Math.floor(Date.now() * 1_000_000);
}

function newID(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function getProjectName(
  config: { mlApp?: string },
  input: Pick<PluginInput, "directory">,
): string {
  if (config.mlApp) return config.mlApp;
  const worktree = (input as unknown as { worktree?: string }).worktree;
  if (worktree) {
    const name = basename(worktree);
    if (name.length > 0) return name;
  }
  const dirName = basename(input.directory);
  if (dirName.length > 0) return dirName;
  return "opencode";
}

function getSessionState(sessionID: string): SessionState {
  let state = sessions.get(sessionID);
  if (!state) {
    const traceID = newID();
    state = {
      sessionID,
      traceID,
      agentSpanID: newID(),
      agentStartNs: nowNs(),
      providerID: "",
      modelID: "",
      completedMessages: new Set(),
    };
    sessions.set(sessionID, state);
  }
  return state;
}

function getToolSpanKey(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}

function toolOutputIndicatesError(output: {
  title: string;
  metadata?: Record<string, unknown>;
}): boolean {
  if (output.metadata?.["error"]) return true;
  if (output.metadata?.["status"] === "error") return true;
  if (/error/i.test(output.title)) return true;
  return false;
}

function isCompletedAssistantMessage(info: unknown): info is {
  id: string;
  role: "assistant";
  sessionID: string;
  modelID: string;
  providerID: string;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  time: { created: number; completed: number };
} {
  if (typeof info !== "object" || info === null) return false;
  const msg = info as Record<string, unknown>;
  const time = msg["time"] as Record<string, unknown> | undefined;
  return (
    msg["role"] === "assistant" &&
    typeof msg["id"] === "string" &&
    typeof msg["sessionID"] === "string" &&
    typeof msg["modelID"] === "string" &&
    typeof msg["providerID"] === "string" &&
    typeof time?.["completed"] === "number"
  );
}

function buildTags(config: ResolvedPluginConfig): string[] {
  const tags: string[] = [];
  if (config.env) tags.push(`env:${config.env}`);
  if (config.service) tags.push(`service:${config.service}`);
  for (const [k, v] of Object.entries(config.tags)) {
    tags.push(`${k}:${v}`);
  }
  return tags;
}

// ──────────────────────────────────────────────────────────────────────────────
// Flush — POST spans to Datadog LLM Obs intake
// ──────────────────────────────────────────────────────────────────────────────

let flushInFlight: Promise<void> | null = null;

async function flush(
  apiKey: string,
  site: string,
  mlApp: string,
  tags: string[],
): Promise<void> {
  if (pendingSpans.length === 0) return;

  // Coalesce concurrent flushes
  if (flushInFlight) {
    await flushInFlight;
    return;
  }

  const spans = pendingSpans.splice(0, pendingSpans.length);

  flushInFlight = (async () => {
    const url = `https://api.${site}/api/intake/llm-obs/v1/trace/spans`;
    const body = JSON.stringify({
      data: {
        type: "span",
        attributes: {
          ml_app: mlApp,
          tags,
          spans,
        },
      },
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "DD-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[opencode-datadog-monitor] Flush failed: ${res.status} ${text}`);
      }
    } catch (error) {
      console.warn("[opencode-datadog-monitor] Flush error", error);
    }
  })();

  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin export
// ──────────────────────────────────────────────────────────────────────────────

export const DatadogLLMObsPlugin: Plugin = async (input) => {
  const loaded = await loadPluginConfig(input);
  if (!loaded) {
    console.info("[opencode-datadog-monitor] DD_API_KEY not set. Plugin disabled.");
    return {};
  }

  const config = loaded.config;
  const mlApp = getProjectName(config, input);
  const apiKey = process.env["DD_API_KEY"]!;
  const site = config.site;
  const tags = buildTags(config);

  console.info(`[opencode-datadog-monitor] Plugin enabled (${mlApp} → ${site})`);

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

    "tool.execute.before": async (hookInput, hookOutput) => {
      try {
        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        toolContexts.set(key, {
          startNs: nowNs(),
          spanID: newID(),
          args: config.recordInputs ? (hookOutput.args as unknown) : undefined,
        });
      } catch (error) {
        console.warn("[opencode-datadog-monitor] tool.execute.before error", error);
      }
    },

    "tool.execute.after": async (hookInput, hookOutput) => {
      try {
        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        const ctx = toolContexts.get(key);
        toolContexts.delete(key);
        if (!ctx) return;

        const state = getSessionState(hookInput.sessionID);
        const endNs = nowNs();
        const isError = toolOutputIndicatesError(hookOutput);

        const meta: SpanMeta = { kind: "tool" };
        if (config.recordInputs && ctx.args !== undefined) {
          meta.input = { value: JSON.stringify(ctx.args) };
        }
        if (config.recordOutputs || isError) {
          meta.output = { value: JSON.stringify(hookOutput.output) };
        }

        pendingSpans.push({
          name: hookInput.tool,
          span_id: ctx.spanID,
          trace_id: state.traceID,
          parent_id: state.agentSpanID,
          start_ns: ctx.startNs,
          duration: endNs - ctx.startNs,
          meta,
          status: isError ? "error" : "ok",
          session_id: hookInput.sessionID,
          tags,
        });
      } catch (error) {
        console.warn("[opencode-datadog-monitor] tool.execute.after error", error);
      }
    },

    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "session.created": {
            getSessionState(event.properties.info.id);
            break;
          }

          case "session.idle": {
            // End the agent span and flush
            const sessionID = event.properties.sessionID;
            const state = sessions.get(sessionID);
            if (state) {
              const endNs = nowNs();
              const agentMeta: SpanMeta = { kind: "agent" };
              if (state.lastUserInput) {
                agentMeta.input = { value: state.lastUserInput };
              }
              if (state.lastAssistantOutput) {
                agentMeta.output = { value: state.lastAssistantOutput };
              }
              pendingSpans.push({
                name: "opencode",
                span_id: state.agentSpanID,
                trace_id: state.traceID,
                parent_id: "undefined",
                start_ns: state.agentStartNs,
                duration: endNs - state.agentStartNs,
                meta: agentMeta,
                status: "ok",
                session_id: sessionID,
                tags,
              });
              // Reset for next turn — new agent span
              state.agentSpanID = newID();
              state.agentStartNs = nowNs();
              state.lastUserInput = undefined;
              state.lastAssistantOutput = undefined;
            }
            await flush(apiKey, site, mlApp, tags);
            break;
          }

          case "session.deleted": {
            const sessionID = event.properties.info.id;
            for (const key of toolContexts.keys()) {
              if (key.startsWith(`${sessionID}:`)) {
                toolContexts.delete(key);
              }
            }
            sessions.delete(sessionID);
            await flush(apiKey, site, mlApp, tags);
            break;
          }

          case "session.error": {
            console.error("[opencode-datadog-monitor] session.error", event.properties.error);
            await flush(apiKey, site, mlApp, tags);
            break;
          }

          case "message.part.updated": {
            const part = event.properties.part;
            if (!part || typeof part !== "object") break;
            const p = part as Record<string, unknown>;
            if (p["type"] !== "text" || typeof p["text"] !== "string") break;
            if (p["synthetic"] || p["ignored"]) break;

            const pSessionID = p["sessionID"] as string | undefined;
            const pMessageID = p["messageID"] as string | undefined;
            if (!pSessionID || !pMessageID) break;

            const role = messageRoles.get(pMessageID);
            if (role === "user") {
              const st = getSessionState(pSessionID);
              st.lastUserInput = p["text"] as string;
            } else if (role === "assistant") {
              const st = getSessionState(pSessionID);
              st.lastAssistantOutput = p["text"] as string;
            }
            break;
          }

          case "message.updated": {
            const info = event.properties.info;
            if (!info || typeof info !== "object") break;
            const msgInfo = info as Record<string, unknown>;
            if (typeof msgInfo["sessionID"] !== "string") break;

            // Track message roles so we can map parts to user/assistant
            if (typeof msgInfo["id"] === "string" && typeof msgInfo["role"] === "string") {
              messageRoles.set(msgInfo["id"] as string, msgInfo["role"] as string);
            }

            if (!isCompletedAssistantMessage(info)) break;

            const msgState = getSessionState(info.sessionID);
            if (msgState.completedMessages.has(info.id)) break;
            msgState.completedMessages.add(info.id);

            msgState.providerID = info.providerID;
            msgState.modelID = info.modelID;

            const startNs = Math.floor(info.time.created * 1_000_000);
            const endNs = Math.floor(info.time.completed * 1_000_000);

            pendingSpans.push({
              name: info.modelID,
              span_id: newID(),
              trace_id: msgState.traceID,
              parent_id: msgState.agentSpanID,
              start_ns: startNs,
              duration: endNs - startNs,
              meta: {
                kind: "llm",
                model_name: info.modelID,
                model_provider: info.providerID,
              },
              metrics: {
                input_tokens: info.tokens.input,
                output_tokens: info.tokens.output,
                total_tokens: info.tokens.input + info.tokens.output,
              },
              status: "ok",
              session_id: info.sessionID,
              tags,
            });
            break;
          }

          default:
            break;
        }
      } catch (error) {
        console.warn("[opencode-datadog-monitor] event error", error);
      }
    },
  };
};

export default DatadogLLMObsPlugin;
