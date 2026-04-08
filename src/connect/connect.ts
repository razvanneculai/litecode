import { createInterface } from "readline";
import { saveConfig } from "../config/config.js";

interface ProviderPreset {
  name: string;
  baseURL: string;
  requiresKey: boolean;
  tokenLimit: number;
  fetchModelsPath: string; // path to append to baseURL for model list
  category: string;        // grouping header shown in the menu
}

const PRESETS: ProviderPreset[] = [
  // ── Local ────────────────────────────────────────────────────────────────
  {
    name: "Ollama",
    baseURL: "http://localhost:11434/v1",
    requiresKey: false,
    tokenLimit: 8192,
    fetchModelsPath: "/api/tags",
    category: "Local",
  },
  {
    name: "LM Studio",
    baseURL: "http://localhost:1234/v1",
    requiresKey: false,
    tokenLimit: 8192,
    fetchModelsPath: "/v1/models",
    category: "Local",
  },
  // ── Free / cheap cloud ────────────────────────────────────────────────────
  {
    name: "Groq  (free tier, fast inference)",
    baseURL: "https://api.groq.com/openai/v1",
    requiresKey: true,
    tokenLimit: 32768,
    fetchModelsPath: "/models",
    category: "Free / Cheap Cloud",
  },
  {
    name: "Google Gemini  (free tier available)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    tokenLimit: 1000000,
    fetchModelsPath: "/models",
    category: "Free / Cheap Cloud",
  },
  {
    name: "DeepSeek  (strong coder models, very cheap)",
    baseURL: "https://api.deepseek.com/v1",
    requiresKey: true,
    tokenLimit: 65536,
    fetchModelsPath: "/models",
    category: "Free / Cheap Cloud",
  },
  {
    name: "Together AI  (open-source model hosting)",
    baseURL: "https://api.together.xyz/v1",
    requiresKey: true,
    tokenLimit: 32768,
    fetchModelsPath: "/models",
    category: "Free / Cheap Cloud",
  },
  {
    name: "Fireworks AI  (fast open-source hosting)",
    baseURL: "https://api.fireworks.ai/inference/v1",
    requiresKey: true,
    tokenLimit: 32768,
    fetchModelsPath: "/models",
    category: "Free / Cheap Cloud",
  },
  // ── Big labs ──────────────────────────────────────────────────────────────
  {
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    requiresKey: true,
    tokenLimit: 128000,
    fetchModelsPath: "/models",
    category: "Big Labs",
  },
  {
    name: "Anthropic Claude  (via OpenRouter)",
    baseURL: "https://openrouter.ai/api/v1",
    requiresKey: true,
    tokenLimit: 200000,
    fetchModelsPath: "/models",
    category: "Big Labs",
  },
  {
    name: "Mistral AI",
    baseURL: "https://api.mistral.ai/v1",
    requiresKey: true,
    tokenLimit: 32768,
    fetchModelsPath: "/models",
    category: "Big Labs",
  },
  {
    name: "xAI Grok",
    baseURL: "https://api.x.ai/v1",
    requiresKey: true,
    tokenLimit: 131072,
    fetchModelsPath: "/models",
    category: "Big Labs",
  },
  {
    name: "Perplexity AI",
    baseURL: "https://api.perplexity.ai",
    requiresKey: true,
    tokenLimit: 128000,
    fetchModelsPath: "/models",
    category: "Big Labs",
  },
  // ── Aggregators ───────────────────────────────────────────────────────────
  {
    name: "OpenRouter  (routes to 200+ models)",
    baseURL: "https://openrouter.ai/api/v1",
    requiresKey: true,
    tokenLimit: 8192,
    fetchModelsPath: "/models",
    category: "Aggregators",
  },
  // ── Custom ────────────────────────────────────────────────────────────────
  {
    name: "Custom endpoint",
    baseURL: "",
    requiresKey: false,
    tokenLimit: 8192,
    fetchModelsPath: "/models",
    category: "Custom",
  },
];

// Fetch model list from provider.
// Tries OpenAI-compat GET /models first, then Ollama GET /api/tags.
export async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  // Remove trailing /v1 for Ollama's /api/tags endpoint
  const ollamaBase = baseURL.replace(/\/v1$/, "");

  const attempts: { url: string; parser: (data: unknown) => string[] }[] = [
    {
      url: `${baseURL}/models`,
      parser: (data) => {
        const d = data as { data?: { id: string }[] };
        return (d.data ?? []).map(m => m.id);
      },
    },
    {
      url: `${ollamaBase}/api/tags`,
      parser: (data) => {
        const d = data as { models?: { name: string }[] };
        return (d.models ?? []).map(m => m.name);
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey && apiKey !== "ollama") headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(attempt.url, { headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data: unknown = await res.json();
      const models = attempt.parser(data);
      if (models.length > 0) return models;
    } catch {
      // try next
    }
  }
  return [];
}

function rl(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout, terminal: true });
}

function ask(iface: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => iface.question(question, answer => resolve(answer.trim())));
}

function print(msg: string): void {
  process.stdout.write(msg + "\n");
}

export async function runConnect(cwd: string): Promise<void> {
  const iface = rl();

  const W = 52;
  const line = "─".repeat(W);
  print(`\n  \x1b[1;36m╭${line}╮\x1b[0m`);
  print(`  \x1b[1;36m│\x1b[0m  \x1b[1mConnect to LLM Provider\x1b[0m${" ".repeat(W - 26)}\x1b[1;36m│\x1b[0m`);
  print(`  \x1b[1;36m╰${line}╯\x1b[0m\n`);

  // Step 1: choose provider — grouped by category
  let lastCategory = "";
  PRESETS.forEach((p, i) => {
    if (p.category !== lastCategory) {
      if (lastCategory) print("");
      print(`  \x1b[2m${p.category}\x1b[0m`);
      lastCategory = p.category;
    }
    print(`    \x1b[36m${String(i + 1).padStart(2)}.\x1b[0m  ${p.name}`);
  });
  print("");

  let preset: ProviderPreset | undefined;
  while (!preset) {
    const choice = await ask(iface, "Select provider (1-" + PRESETS.length + "): ");
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < PRESETS.length) {
      preset = PRESETS[idx];
    } else {
      print("  Invalid choice, try again.");
    }
  }

  // Step 2: base URL (pre-filled, user can edit)
  let baseURL = preset.baseURL;
  if (preset.name === "Custom endpoint") {
    baseURL = await ask(iface, "Base URL (e.g. http://localhost:11434/v1): ");
  } else {
    const edited = await ask(iface, `Base URL [${preset.baseURL}]: `);
    if (edited) baseURL = edited;
  }

  // Step 3: API key
  let apiKey = "ollama";
  if (preset.requiresKey) {
    apiKey = await ask(iface, "API key: ");
  } else {
    const keyInput = await ask(iface, "API key (leave blank for none): ");
    if (keyInput) apiKey = keyInput;
  }

  // Step 4: fetch models and let user pick
  print("\n  Fetching available models…");
  const models = await fetchModels(baseURL, apiKey);

  let model = "";
  if (models.length > 0) {
    print("\n  Models found:");
    const display = models.slice(0, 20); // cap at 20 for readability
    display.forEach((m, i) => print(`    ${i + 1}. ${m}`));
    if (models.length > 20) print(`    … and ${models.length - 20} more`);
    print("");

    while (!model) {
      const choice = await ask(iface, `Select model (1-${display.length}) or type name: `);
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < display.length) {
        model = display[idx];
      } else if (choice) {
        model = choice; // user typed a model name directly
      } else {
        print("  Model name cannot be empty.");
      }
    }
  } else {
    print("  Could not fetch model list. Enter model name manually.");
    while (!model) {
      model = await ask(iface, "Model name: ");
      if (!model) print("  Model name cannot be empty.");
    }
  }

  // Step 5: token limit
  const tokenLimitInput = await ask(iface, `Token limit [${preset.tokenLimit}]: `);
  const tokenLimit = tokenLimitInput ? parseInt(tokenLimitInput, 10) : preset.tokenLimit;

  iface.close();

  // Save
  saveConfig(cwd, {
    provider: { baseURL, apiKey, model },
    tokenLimit,
  });

  print(`\n  \x1b[32m✓\x1b[0m  \x1b[1mSaved to litecode.json\x1b[0m`);
  print(`  \x1b[2mProvider\x1b[0m  ${baseURL}`);
  print(`  \x1b[2mModel\x1b[0m     \x1b[96m${model}\x1b[0m`);
  print(`  \x1b[2mTokens\x1b[0m    ${tokenLimit}\n`);
}
