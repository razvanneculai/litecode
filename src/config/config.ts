import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const GLOBAL_CONFIG_DIR = join(homedir(), ".litecode");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");

export interface Config {
  provider: {
    baseURL: string;
    apiKey: string;
    model: string;
  };
  tokenLimit: number;
  reservedOutputTokens: number;
  systemPromptBudget: number;
  maxParallelExecutors: number;
  rateLimitDelayMs?: number; // Delay between LLM calls to avoid rate limits
}

const DEFAULTS: Config = {
  provider: {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: "qwen2.5-coder:7b",
  },
  tokenLimit: 8192,
  reservedOutputTokens: 2000,
  systemPromptBudget: 1000,
  maxParallelExecutors: 1, // Reduced from 3 to be conservative with rate limits
  rateLimitDelayMs: 5000, // 5 seconds default between calls
};

function mergeConfig(existing: Partial<Config>, updates: Partial<Config>): Record<string, unknown> {
  return {
    ...existing,
    ...updates,
    provider: { ...(existing.provider ?? {}), ...(updates.provider ?? {}) },
  };
}

export function saveConfig(cwd: string, updates: Partial<Config>): void {
  // Always save to global config
  if (!existsSync(GLOBAL_CONFIG_DIR)) mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  let globalExisting: Partial<Config> = {};
  try { globalExisting = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")) as Partial<Config>; } catch { /* fresh */ }
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(mergeConfig(globalExisting, updates), null, 2), "utf-8");

  // Also save to local litecode.json if one already exists in the project
  const localPath = join(cwd, "litecode.json");
  if (existsSync(localPath)) {
    let localExisting: Partial<Config> = {};
    try { localExisting = JSON.parse(readFileSync(localPath, "utf-8")) as Partial<Config>; } catch { /* fresh */ }
    writeFileSync(localPath, JSON.stringify(mergeConfig(localExisting, updates), null, 2), "utf-8");
  }
}

export function loadConfig(cwd?: string): Config {
  const dir = cwd ?? process.cwd();
  const localPath = join(dir, "litecode.json");

  // Load global config first, then overlay local project config on top
  let userConfig: Partial<Config> = {};

  try {
    userConfig = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")) as Partial<Config>;
  } catch { /* no global config yet */ }

  try {
    const local = JSON.parse(readFileSync(localPath, "utf-8")) as Partial<Config>;
    userConfig = mergeConfig(userConfig, local) as Partial<Config>;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`litecode.json is invalid JSON: ${err.message}`);
    }
    // No local config — global config (if any) is used as-is
  }

  return {
    provider: { ...DEFAULTS.provider, ...(userConfig.provider ?? {}) },
    tokenLimit: userConfig.tokenLimit ?? DEFAULTS.tokenLimit,
    reservedOutputTokens:
      userConfig.reservedOutputTokens ?? DEFAULTS.reservedOutputTokens,
    systemPromptBudget:
      userConfig.systemPromptBudget ?? DEFAULTS.systemPromptBudget,
    maxParallelExecutors:
      userConfig.maxParallelExecutors ?? DEFAULTS.maxParallelExecutors,
    rateLimitDelayMs:
      userConfig.rateLimitDelayMs ?? DEFAULTS.rateLimitDelayMs,
  };
}