# LiteCode

> The AI coding agent built for the models everyone actually has — free tiers, local models, and 8k context windows.

LiteCode lets you describe a code change in plain English and have an AI execute it across your entire project. No paid subscription. No 200k-token model required. Works right now with a free Groq account, a free OpenRouter key, or just Ollama on your laptop.

> **Early development warning:** LiteCode is experimental software. It writes directly to your files with no built-in undo. It may produce incorrect edits, overwrite content unexpectedly, or behave unpredictably depending on the model you use. **Always commit or back up your work before running it.** The author takes no responsibility for data loss or file corruption. Use at your own risk.

---

## What it does

- **Multi-file edits from one instruction** — "rename validateToken to verifyToken everywhere" touches every file that needs changing, in the right order
- **Never exceeds 8k tokens** — token budget is enforced in code before every single LLM call, not by hoping the model behaves
- **Runs edits in parallel** — independent file changes happen at the same time; sequential ones wait for their dependencies
- **Works with any free model** — Groq, OpenRouter, Ollama, LM Studio, Gemini, DeepSeek — all supported out of the box
- **Context maps are plain Markdown** — readable by humans, cheap on tokens, safe to commit to git
- **No data leaves your machine** unless you choose a cloud provider — and even then, only the specific files being edited are sent

---

## Why LiteCode?

Most AI coding tools assume you have access to a 200k-token model. In practice, the free tiers and local models most developers actually use have **8k context windows** — barely enough for one large file, let alone a whole project.

LiteCode was built from the ground up for this constraint. It never sends your entire codebase to the AI at once. Instead, it uses a three-stage system:

```
You: "rename the login function to authenticate everywhere"
         │
         ▼
┌─────────────────────────────┐
│  PLANNER (1 AI call)        │
│                             │
│  Reads your project map     │
│  Figures out which files    │
│  need to change and in      │
│  what order.                │
│                             │
│  Output: a task list        │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  ORCHESTRATOR (pure code)   │
│                             │
│  Reads the task list.       │
│  Figures out what can run   │
│  in parallel vs. in order.  │
│  Loads just the right code. │
│  Checks token budgets.      │
└──┬──────────┬───────────────┘
   │          │
   ▼          ▼
┌──────┐   ┌──────┐   ← One AI call per file, running in parallel
│ auth │   │login │
│ .js  │   │ .js  │
└──┬───┘   └──┬───┘
   │          │
   ▼          ▼
  Edit       Edit       ← Pure code writes results back to disk
```

The key insight: **only one file's worth of code ever goes to the AI at a time.** The AI doesn't need to see the whole project — it just needs to know what to change in this one file.

---

## Understanding the Context Map System

Before editing, LiteCode needs to understand your project. Running `litecode init --fast` generates plain Markdown files alongside your code:

```
your-project/
├── project_context.md          ← "What is this project?" (~300–500 tokens)
│                                  Tech stack, entry points, folder descriptions
├── src/
│   ├── folder_context.md       ← "What's in src/?" (~200–400 tokens)
│   │                              Every file, one-line description, key imports/exports
│   ├── auth.js
│   ├── auth.js.file_analysis.md  ← Only for files >150 lines
│   │                               Line-range index: what lives on which lines
│   └── ...
└── routes/
    ├── folder_context.md
    └── ...
```

**Layer 1 — `project_context.md`:** The 30-second overview. Tech stack, which folder does what, entry points. The AI reads this first on every request.

**Layer 2 — `folder_context.md`:** One per folder. Lists every file with a one-liner description. The AI uses this to know exactly which file to open.

**Layer 3 — `*.file_analysis.md`:** Generated only for large files (over ~150 lines). Contains a line-by-line index so the AI can request only the section it needs — fitting even huge files into an 8k window.

These files are plain Markdown. You can read them. They're safe to commit to git — they act as a persistent memory of your project that persists between sessions.

---

## Token Budget

Every LLM call is budgeted like this:

```
Total context window:           8192 tokens
─────────────────────────────────────────────
System prompt + instructions:  ~1000 tokens
Reserved for AI response:      ~2000 tokens
─────────────────────────────────────────────
Available for your code:       ~5000 tokens  (≈ 150–200 lines)
```

The token counter runs **before every LLM call**. If the code doesn't fit, LiteCode automatically falls back to loading just the relevant section using the file's analysis index. This check never gets skipped.

---

## Requirements

- **Node.js** v18 or later
- **npm**
- An LLM provider (pick any — free options listed below):
  - [Ollama](https://ollama.com) — local, free, no account needed
  - [LM Studio](https://lmstudio.ai) — local, free, no account needed
  - [Groq](https://groq.com) — cloud, free tier, very fast
  - [OpenRouter](https://openrouter.ai) — cloud, free tier, 100+ models
  - [Google Gemini](https://aistudio.google.com) — cloud, generous free tier
  - [DeepSeek](https://platform.deepseek.com) — cloud, very cheap, strong coder
  - Any OpenAI-compatible endpoint

---

## Installation

```bash
git clone https://github.com/razvanneculai/litecode.git
cd litecode
npm install
npm run build
npm link
```

After `npm link`, the `litecode` command is available globally in your terminal.

> **Without installing globally:** Replace `litecode` with `npm run dev --` in all commands below.

---

## Quick Start (5 minutes)

### Step 1 — Go to your project

```bash
cd /path/to/your/project
```

LiteCode always operates on the **current directory**. Run all commands from inside the project you want to edit.

### Step 2 — Connect to an LLM

```bash
litecode connect
```

An interactive menu will guide you through:
- Selecting a provider (Ollama, Groq, OpenRouter, etc.)
- Entering your API key (or leaving it blank for local models)
- Picking a model from the live list
- Setting your token limit

This saves a `litecode.json` file in your project directory. That file contains your API key — it is listed in `.gitignore` by default and will not be committed to git.

### Step 3 — Map your project

```bash
litecode init --fast
```

This scans your project and writes the context map files. The `--fast` flag uses pattern matching to build maps instantly without any LLM calls. Use `litecode init` (without `--fast`) if you want AI-generated descriptions for every file.

### Step 4 — Make a change

```bash
litecode "add error handling to the fetchUser function"
```

That's it. LiteCode will plan the tasks, run them, and write the changes to disk.

Or start an interactive session:

```bash
litecode
```

---

## All Commands

| Command | What it does |
|---|---|
| `litecode connect` | Choose your LLM provider, model, and API key |
| `litecode init` | Scan project, generate AI-powered context maps |
| `litecode init --fast` | Same, but instant — pattern matching only, no LLM |
| `litecode map` | Regenerate all context maps |
| `litecode map --fast` | Regenerate without LLM |
| `litecode analyze <file>` | Force-generate a detailed line-index for one specific file |
| `litecode "your request"` | Run one request and exit |
| `litecode` | Start interactive mode (send multiple requests) |
| `litecode chat` | Same as above |

---

## Writing Good Requests

LiteCode works best with specific, concrete instructions:

| Too vague | Better |
|---|---|
| `"fix the bug"` | `"fix the null pointer crash in the login function in src/auth.js"` |
| `"update the API"` | `"rename the POST /user endpoint to POST /users in routes/api.js"` |
| `"add logging"` | `"add a console.log at the start of every exported function in src/utils.js"` |
| `"refactor this"` | `"extract the database connection code from server.js into its own file src/db.js"` |

You don't need to name files if you don't know them — the Planner reads your project map and figures it out. But the more specific you are, the better the result.

---

## Config Reference (`litecode.json`)

```json
{
  "provider": {
    "baseURL": "https://api.groq.com/openai/v1",
    "apiKey": "gsk_...",
    "model": "llama-3.3-70b-versatile"
  },
  "tokenLimit": 8192,
  "reservedOutputTokens": 2000,
  "systemPromptBudget": 1000,
  "maxParallelExecutors": 3
}
```

| Field | What it controls |
|---|---|
| `provider.baseURL` | API endpoint. Must be OpenAI-compatible. |
| `provider.apiKey` | Your API key. Set to `"ollama"` for local Ollama. |
| `provider.model` | Model identifier as the provider expects it. |
| `tokenLimit` | Hard cap per LLM call. Set to what your model actually supports. |
| `reservedOutputTokens` | How many tokens to leave for the model's response. Default: 2000. |
| `systemPromptBudget` | Tokens reserved for instructions. Default: 1000. |
| `maxParallelExecutors` | How many file edits can run at the same time. Default: 3. |

Usable code context per call = `tokenLimit - reservedOutputTokens - systemPromptBudget`

At the defaults (8192 / 2000 / 1000) = **~5192 tokens** for code.

> **Note:** `litecode.json` is automatically added to `.gitignore` — it contains your API key and should never be committed. See `litecode.example.json` for the expected shape of this file.

---

## Free Provider Setup

### Ollama (local, no account needed)

```bash
# Install Ollama from https://ollama.com then:
ollama pull qwen2.5-coder:7b
ollama serve

# In your project:
litecode connect   # Select "Ollama"
```

Recommended models:
- `qwen2.5-coder:7b` — best instruction following for code edits
- `codellama:7b` — solid, widely used
- `deepseek-coder:6.7b` — great at structured JSON output (important for the planner)

### Groq (cloud, free)

1. Sign up at [groq.com](https://groq.com)
2. Create an API key
3. `litecode connect` → select **Groq**
4. Paste your key, pick `llama-3.3-70b-versatile`

### OpenRouter (cloud, free tier, most models)

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create a free API key
3. `litecode connect` → select **OpenRouter**
4. Any model with `:free` in the name is free

### Google Gemini (cloud, generous free tier)

1. Get a key from [aistudio.google.com](https://aistudio.google.com)
2. `litecode connect` → select **Google Gemini**
3. Use `gemini-1.5-flash` for the best free tier limits

---

## Internal Architecture (for contributors)

```
litecode/
├── src/
│   ├── cli/
│   │   └── index.ts          # Entry point, command definitions (Commander.js)
│   │
│   ├── orchestrator/
│   │   ├── planner.ts        # Sends project map + request to LLM → gets task list
│   │   ├── executor.ts       # Sends one file + one task to LLM → gets edited content
│   │   ├── scheduler.ts      # Builds dependency graph, runs waves in parallel
│   │   └── applier.ts        # Writes LLM output back to disk (or deletes files)
│   │
│   ├── context/
│   │   ├── mapper.ts         # Generates project_context.md and folder_context.md
│   │   ├── analyzer.ts       # Generates *.file_analysis.md for large files
│   │   └── loader.ts         # Reads maps and files, respects token budgets
│   │
│   ├── tokens/
│   │   ├── counter.ts        # Counts tokens for any string (tiktoken + fallback)
│   │   └── budget.ts         # canFit() — checks if content fits before every LLM call
│   │
│   ├── llm/
│   │   ├── client.ts         # HTTP client for OpenAI-compatible APIs (plain fetch)
│   │   └── prompts.ts        # System prompts for Planner and Executor roles
│   │
│   └── config/
│       └── config.ts         # Reads litecode.json, merges with global ~/.litecode/config.json
│
├── package.json
├── tsconfig.json
└── litecode.example.json     # Template config — copy to litecode.json and fill in your key
```

**Key design rules:**
- The token counter runs before every LLM call. No exceptions.
- The orchestrator never calls the LLM directly — only through `planner.ts` or `executor.ts`.
- One executor = one file. Never two files in a single call.
- Context maps are plain Markdown — readable by humans, cheap on tokens.
- If one executor fails, the rest continue. Nothing crashes the whole run.
- No streaming. Full responses only — simpler and more reliable with small models.

---

## Troubleshooting

**"No model configured"**
Run `litecode connect` in your project directory first.

**"Could not fetch model list"**
Your provider URL or API key is wrong. Run `litecode connect` again. You can also type a model name manually at the prompt.

**Planner returns no tasks**
The project context maps are missing or empty. Run `litecode init --fast` first.

**"You mentioned 'X' but it doesn't exist on disk"**
You referred to a file that doesn't exist yet. If you just created or renamed it, run `litecode init --fast` to refresh the maps, then retry.

**Edits are wrong or incomplete**
- Be more specific in your request (name the function, describe the exact change).
- Run `litecode analyze src/yourfile.js` to give the agent a better line-level index before editing a large file.

**Ollama drops connections**
A known Ollama stability issue under rapid sequential calls. Set `"maxParallelExecutors": 1` in `litecode.json`, or switch to a cloud provider for multi-file edits.

**Output has markdown fences (triple backticks) in the code**
The model wrapped its response in code blocks despite being told not to. LiteCode strips these automatically, but if it still happens, try a model with stronger instruction-following (Qwen2.5-Coder or DeepSeek-Coder).

---

## Known Issues

These are confirmed bugs or limitations that have not yet been fixed:

- **Weak models misclassify complex requests** — Models with poor instruction-following (some Llama 2 variants, older Mistral) occasionally output non-JSON from the planner or generate markdown fences in executor output. Use Qwen2.5-Coder or DeepSeek-Coder for best results.
- **Large binary files in project** — If your project contains large binary files (images, compiled assets) in the same directory, context map generation may be slow. Add them to a `.litecode_ignore` file (future feature) for now.
- **Sequential task chains > 5 deep** — Very deep dependency chains (task A → B → C → D → E → F) may hit the planner's task limit on some small models. Break the request into smaller steps.

---

## Solved Issues

Bugs that were present and have been fixed:

| Issue | Fixed in | Description |
|---|---|---|
| **Questions overwrote files** | `0.1.1` | Asking "how many lines does X have?" caused the executor to write the answer *into* the file instead of printing it. The planner now uses `action_type: "query"` for read-only questions, which routes them through a dedicated answer path that never touches disk. |
| **Stale map silent misroute** | `0.1.0` | If the user named a file in their request that wasn't in the context map, the planner would silently route the action to the wrong file. The orchestrator now validates that mentioned file paths match the planner's output and throws a clear error if they don't. |

---

## Contributing

Pull requests welcome. Before opening one:
- Run `npm run build` to verify the TypeScript compiles clean.
- Test against a small project with `litecode init --fast` followed by a simple edit request.
- Keep the token-budget rules intact — every LLM call must go through `canFit()` before firing.
- Copy `litecode.example.json` to `litecode.json` and fill in your own key for local testing. Never commit `litecode.json`.

---

## License

ISC — do whatever you want with it.

Legal Disclaimer: LiteCode is an independent open-source project. It is not affiliated with, endorsed by, or in any way connected to any other company or product sharing the same name.
