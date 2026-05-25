import type { PluginInput } from "@opencode-ai/plugin";
export type PluginConfig = {
    site?: string;
    mlApp?: string;
    env?: string;
    service?: string;
    recordInputs?: boolean;
    recordOutputs?: boolean;
    tags?: Record<string, string>;
};
export type ResolvedPluginConfig = {
    site: string;
    mlApp?: string;
    env?: string;
    service?: string;
    recordInputs: boolean;
    recordOutputs: boolean;
    tags: Record<string, string>;
};
export type LoadedPluginConfig = {
    source: string;
    config: ResolvedPluginConfig;
};
export declare const CONFIG_FILE_NAMES: readonly ["datadog-monitor.json", "datadog-monitor.jsonc"];
export declare const DEFAULTS: ResolvedPluginConfig;
export declare function getCandidatePaths(input: Pick<PluginInput, "directory">): string[];
export declare function addEnvOverrides(config: PluginConfig): PluginConfig;
export declare function normalizeConfig(raw: PluginConfig): ResolvedPluginConfig;
export declare function loadPluginConfig(input: Pick<PluginInput, "directory">): Promise<LoadedPluginConfig | null>;
//# sourceMappingURL=config.d.ts.map