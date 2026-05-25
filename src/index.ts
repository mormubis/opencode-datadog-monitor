import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { AssistantMessage } from "@opencode-ai/sdk";
import { basename } from "node:path";
import { loadPluginConfig } from "./config.js";

// ──────────────────────────────────────────────────────────────────────────────
// Session state
// ──────────────────────────────────────────────────────────────────────────────

interface SessionState {
  sessionID: string;
  providerID: string;
  modelID: string;
  completedMessages: Set<string>;
}

const sessions = new Map<string, SessionState>();

// Stores the tool start time and input args to construct the span in .after.
// We can't keep an llmobs.trace() callback open across hooks (it closes on
// callback return), so we record context in .before and emit the span in .after.
interface ToolContext {
  startTime: number;
  args: unknown;
}

const toolContexts = new Map<string, ToolContext>();

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function getProjectName(
  config: { mlApp?: string },
  input: Pick<PluginInput, "directory">,
): string {
  if (config.mlApp) return config.mlApp;
  // PluginInput exposes `worktree` at the top level; cast to access it
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
    state = { sessionID, providerID: "", modelID: "", completedMessages: new Set() };
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

/**
 * Type guard that narrows a Message info object to a completed AssistantMessage.
 * We check all fields required for LLM span creation at runtime, since the
 * event payload is typed as `Message` (union) and we need the `completed` timestamp.
 */
function isCompletedAssistantMessage(
  info: unknown,
): info is AssistantMessage & { time: { created: number; completed: number } } {
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

// ──────────────────────────────────────────────────────────────────────────────
// Plugin export
// ──────────────────────────────────────────────────────────────────────────────

export const DatadogLLMObsPlugin: Plugin = async (input) => {
  // 1. Load config — returns null if DD_API_KEY is not set
  const loaded = await loadPluginConfig(input);
  if (!loaded) {
    console.info("[opencode-datadog-monitor] DD_API_KEY not set. Plugin disabled.");
    return {};
  }

  const config = loaded.config;
  const mlApp = getProjectName(config, input);

  // 2. dd-trace reads DD_SITE from the environment; TracerOptions does not
  //    expose a `site` field. Set it before init so agentless mode routes correctly.
  if (!process.env["DD_SITE"]) {
    process.env["DD_SITE"] = config.site;
  }

  // 3. Dynamically import dd-trace to defer the side-effectful require until we
  //    know the plugin is actually enabled (DD_API_KEY is set).
  const ddTrace = await import("dd-trace");
  const tracer = ddTrace.default;

  tracer.init({
    llmobs: {
      mlApp,
      agentlessEnabled: true,
    },
    env: config.env,
    service: config.service,
    // Disable all APM auto-instrumentation; we only use llmobs in agentless mode.
    plugins: false,
  });

  const llmobs = tracer.llmobs;

  console.info("[opencode-datadog-monitor] Plugin enabled", {
    source: loaded.source,
    mlApp,
    site: config.site,
  });

  // 4. Return plugin hooks
  return {
    // ── chat.params ──────────────────────────────────────────────────────────
    // Capture per-session model info before each LLM call so we can tag spans.
    "chat.params": async (hookInput) => {
      try {
        const state = getSessionState(hookInput.sessionID);
        state.providerID = hookInput.model.providerID;
        state.modelID = hookInput.model.id;
      } catch (error) {
        console.warn("[opencode-datadog-monitor] chat.params error", error);
      }
    },

    // ── tool.execute.before ──────────────────────────────────────────────────
    // Record start time and args. The actual span is created in .after because
    // llmobs.trace() finishes the span when its callback returns.
    "tool.execute.before": async (hookInput, hookOutput) => {
      try {
        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        toolContexts.set(key, {
          startTime: Date.now(),
          // Only capture args if the user opted in to recording inputs
          args: config.recordInputs ? (hookOutput.args as unknown) : undefined,
        });
      } catch (error) {
        console.warn("[opencode-datadog-monitor] tool.execute.before error", error);
      }
    },

    // ── tool.execute.after ───────────────────────────────────────────────────
    // Create the tool span using context captured in .before.
    "tool.execute.after": async (hookInput, hookOutput) => {
      try {
        const key = getToolSpanKey(hookInput.sessionID, hookInput.callID);
        const ctx = toolContexts.get(key);
        toolContexts.delete(key);

        if (!ctx) return;

        const isError = toolOutputIndicatesError(hookOutput);

        llmobs.trace(
          {
            kind: "tool",
            name: hookInput.tool,
            sessionId: hookInput.sessionID,
          },
          // llmobs.trace's callback signature is (span, done) => T; we ignore
          // both params since annotate() reads the active span from context.
          (_span, _done) => {
            const annotateData: {
              inputData?: string;
              outputData?: string;
              tags?: Record<string, string>;
            } = {};

            if (config.recordInputs && ctx.args !== undefined) {
              annotateData.inputData = JSON.stringify(ctx.args);
            }
            if (config.recordOutputs || isError) {
              annotateData.outputData = JSON.stringify(hookOutput.output);
            }
            if (Object.keys(config.tags).length > 0) {
              annotateData.tags = config.tags;
            }

            if (Object.keys(annotateData).length > 0) {
              // annotate() with one argument uses the current active span.
              // The type narrowed above is compatible with AnnotationOptions.
              llmobs.annotate(annotateData);
            }
          },
        );
      } catch (error) {
        console.warn("[opencode-datadog-monitor] tool.execute.after error", error);
      }
    },

    // ── event ────────────────────────────────────────────────────────────────
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "session.created": {
            // Pre-create session state so it's ready before hooks fire
            getSessionState(event.properties.info.id);
            break;
          }

          case "session.idle": {
            // Flush pending spans when the session goes idle between turns
            llmobs.flush();
            break;
          }

          case "session.deleted": {
            const sessionID = event.properties.info.id;
            // Clean up any dangling tool contexts for this session
            for (const key of toolContexts.keys()) {
              if (key.startsWith(`${sessionID}:`)) {
                toolContexts.delete(key);
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

            // Only process completed assistant messages with full token info
            if (!isCompletedAssistantMessage(info)) break;

            const state = getSessionState(info.sessionID);

            // Deduplicate: message.updated fires multiple times as the message
            // streams in. Record the span only once on the final completed event.
            if (state.completedMessages.has(info.id)) break;
            state.completedMessages.add(info.id);

            // Keep session model info up-to-date in case chat.params was not called
            state.providerID = info.providerID;
            state.modelID = info.modelID;

            llmobs.trace(
              {
                kind: "llm",
                name: info.modelID,
                modelName: info.modelID,
                modelProvider: info.providerID,
                sessionId: info.sessionID,
              },
              (_span, _done) => {
                const annotateData: {
                  metrics: Record<string, number>;
                  tags?: Record<string, string>;
                } = {
                  metrics: {
                    input_tokens: info.tokens.input,
                    output_tokens: info.tokens.output,
                    total_tokens: info.tokens.input + info.tokens.output,
                  },
                };

                if (Object.keys(config.tags).length > 0) {
                  annotateData.tags = config.tags;
                }

                llmobs.annotate(annotateData);
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
  };
};

export default DatadogLLMObsPlugin;
