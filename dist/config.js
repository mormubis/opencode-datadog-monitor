import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────
export const CONFIG_FILE_NAMES = [
    "datadog-monitor.json",
    "datadog-monitor.jsonc",
];
export const DEFAULTS = {
    site: "datadoghq.com",
    recordInputs: true,
    recordOutputs: true,
    tags: {},
};
// ──────────────────────────────────────────────────────────────────────────────
// Candidate path discovery
// ──────────────────────────────────────────────────────────────────────────────
export function getCandidatePaths(input) {
    const paths = [];
    // 1. Explicit path via OPENCODE_DD_CONFIG
    const explicitPath = process.env["OPENCODE_DD_CONFIG"];
    if (explicitPath) {
        paths.push(isAbsolute(explicitPath)
            ? explicitPath
            : resolve(input.directory, explicitPath));
    }
    // 2. {input.directory}/.opencode/{CONFIG_FILE_NAMES}
    for (const name of CONFIG_FILE_NAMES) {
        paths.push(join(input.directory, ".opencode", name));
    }
    // 3. OPENCODE_CONFIG_DIR env var + CONFIG_FILE_NAMES
    const configDir = process.env["OPENCODE_CONFIG_DIR"];
    if (configDir) {
        for (const name of CONFIG_FILE_NAMES) {
            paths.push(join(configDir, name));
        }
    }
    // 4. dirname of OPENCODE_CONFIG env var + CONFIG_FILE_NAMES
    const opencodeConfig = process.env["OPENCODE_CONFIG"];
    if (opencodeConfig) {
        const dir = dirname(isAbsolute(opencodeConfig)
            ? opencodeConfig
            : resolve(input.directory, opencodeConfig));
        for (const name of CONFIG_FILE_NAMES) {
            paths.push(join(dir, name));
        }
    }
    // 5. ~/.config/opencode/{CONFIG_FILE_NAMES}
    for (const name of CONFIG_FILE_NAMES) {
        paths.push(join(homedir(), ".config", "opencode", name));
    }
    return paths;
}
// ──────────────────────────────────────────────────────────────────────────────
// Boolean parsing
// ──────────────────────────────────────────────────────────────────────────────
function parseBoolean(value) {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
// ──────────────────────────────────────────────────────────────────────────────
// Environment variable overrides
// ──────────────────────────────────────────────────────────────────────────────
export function addEnvOverrides(config) {
    const result = { ...config };
    const site = process.env["DD_SITE"];
    if (site !== undefined)
        result.site = site;
    const mlApp = process.env["DD_LLMOBS_ML_APP"];
    if (mlApp !== undefined)
        result.mlApp = mlApp;
    const env = process.env["DD_ENV"];
    if (env !== undefined)
        result.env = env;
    const service = process.env["DD_SERVICE"];
    if (service !== undefined)
        result.service = service;
    const recordInputsRaw = process.env["OPENCODE_DD_RECORD_INPUTS"];
    if (recordInputsRaw !== undefined) {
        const parsed = parseBoolean(recordInputsRaw);
        if (parsed !== undefined)
            result.recordInputs = parsed;
    }
    const recordOutputsRaw = process.env["OPENCODE_DD_RECORD_OUTPUTS"];
    if (recordOutputsRaw !== undefined) {
        const parsed = parseBoolean(recordOutputsRaw);
        if (parsed !== undefined)
            result.recordOutputs = parsed;
    }
    const tagsRaw = process.env["OPENCODE_DD_TAGS"];
    if (tagsRaw !== undefined) {
        const parsedTags = {};
        for (const pair of tagsRaw.split(",")) {
            const colonIndex = pair.indexOf(":");
            if (colonIndex > 0) {
                const key = pair.slice(0, colonIndex).trim();
                const value = pair.slice(colonIndex + 1).trim();
                if (key)
                    parsedTags[key] = value;
            }
        }
        result.tags = { ...result.tags, ...parsedTags };
    }
    return result;
}
// ──────────────────────────────────────────────────────────────────────────────
// Normalization / validation
// ──────────────────────────────────────────────────────────────────────────────
export function normalizeConfig(raw) {
    const site = typeof raw.site === "string" && raw.site.length > 0
        ? raw.site
        : DEFAULTS.site;
    const mlApp = typeof raw.mlApp === "string" && raw.mlApp.length > 0
        ? raw.mlApp
        : undefined;
    const env = typeof raw.env === "string" && raw.env.length > 0 ? raw.env : undefined;
    const service = typeof raw.service === "string" && raw.service.length > 0
        ? raw.service
        : undefined;
    const recordInputs = typeof raw.recordInputs === "boolean"
        ? raw.recordInputs
        : DEFAULTS.recordInputs;
    const recordOutputs = typeof raw.recordOutputs === "boolean"
        ? raw.recordOutputs
        : DEFAULTS.recordOutputs;
    const tags = raw.tags !== null &&
        typeof raw.tags === "object" &&
        !Array.isArray(raw.tags)
        ? raw.tags
        : DEFAULTS.tags;
    return { site, mlApp, env, service, recordInputs, recordOutputs, tags };
}
// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────
export async function loadPluginConfig(input) {
    // Plugin is disabled when no API key is present
    if (!process.env["DD_API_KEY"]) {
        return null;
    }
    const candidates = getCandidatePaths(input);
    let source = "<env>";
    let raw = {};
    // Find first readable config file
    for (const candidate of candidates) {
        try {
            await access(candidate, fsConstants.R_OK);
            const content = await readFile(candidate, "utf8");
            const parsed = JSON.parse(stripJsonComments(content));
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                raw = parsed;
                source = candidate;
            }
            break;
        }
        catch {
            // File doesn't exist or isn't readable — try next candidate
        }
    }
    const withEnv = addEnvOverrides(raw);
    const config = normalizeConfig(withEnv);
    return { source, config };
}
//# sourceMappingURL=config.js.map