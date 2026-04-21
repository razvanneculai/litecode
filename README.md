# LiteCode v1.0

> The AI coding agent built for the models everyone actually has — free tiers, local models, and 8k context windows.

LiteCode lets you describe a code change in plain English and have an AI execute it across your entire project. No paid subscription. No 200k-token model required. Works right now with a free Groq account, a free OpenRouter key, or just Ollama on your laptop.

> **Warning:** LiteCode is experimental software. It shows a diff and asks for confirmation before touching any file — but it may still produce incorrect edits depending on the model you use. **Always commit or back up your work before running it.** The author takes no responsibility for data loss or file corruption. Use at your own risk.

---

## What it does

- **Multi-file edits from one instruction** — "rename validateToken to verifyToken everywhere" touches every file that needs changing, in the right order
- **Never exceeds 8k tokens** — token budget is enforced in code before every single LLM call, not by hoping the model behaves
- **Runs edits in parallel** — independent file changes happen at the same time; sequential ones wait for their dependencies
- **Short-term memory** — LiteCode remembers the last 2 things it did in your project. Say "undo the last change" or "also add a goodbye() function" and it knows exactly what you mean *(new in v1.0)*
- **Auto-sequential for local models** — when the configured provider is on `localhost`, executors run one at a time automatically, eliminating the parallel connection pressure that causes Ollama to drop requests
- **Interactive TUI with scroll + mouse wheel** — persistent chat session, live token sidebar, scrollable history, diff viewer. Run `litecode` with no arguments, or use `--ansi` for the plain terminal mode
- **Works with any free model** — Groq, OpenRouter, Ollama, LM Studio, Gemini, DeepSeek — all supported out of the box
- **Context maps are plain Markdown** — readable by humans, cheap on tokens, safe to commit to git
- **Diff preview before every write** — see exactly what the AI wants to change, file by file, before anything touches disk

---

## Short-Term Memory

As of v1.0, LiteCode remembers the last 2 actions it performed in each project. This memory is stored in `.litecode/memory.json` inside your project and is injected into the planner's prompt on every request so the AI can reason about what it previously did.

**What this enables:**

```bash
litecode "add a hello() function that logs 'hi' to utils.js"
# → Planner adds hello(), applies, saves memory

litecode "undo the last change"
# → Planner reads memory, knows hello() was added to utils.js, removes it

litecode "also add a goodbye() function"
# → Planner sees recent context and makes the right decision
```

**How it works:**

1. After the planner produces a task list, it also outputs a one-sentence `synthesis` describing what the plan will do (e.g. `"Added a hello() function in utils.js"`).
2. After at least one file is successfully written to disk, LiteCode saves an entry with the user's original request, the synthesis, the files that were written, and a timestamp.
3. The memory is a **ring buffer of 2** — the oldest entry is evicted when a third is added. This keeps the token cost negligible (~80–90 tokens per entry).
4. On every subsequent request, the memory block is prepended to the planner's system prompt so it can reason about "last time", "undo", "revert", "previous", etc.

**Token cost:** ~80–90 tokens per entry. The budget check (`canFit`) accounts for memory — if the project context is very large, folder context is dropped first, then memory, to ensure the planner always fits within your configured token limit.

**Storage:** `.litecode/memory.json` — per-project, not global. You can add `.litecode/` to your `.gitignore` if you don't want it committed.

---

## TUI by default (and how to opt out)

LiteCode ships with a full TUI (terminal user interface) enabled by default, built on Ink + React. You get a two-pane layout — a scrollable chat/diff view on the left and a live token/model sidebar on the right — plus per-task spinners, inline diff previews, and mouse-wheel scrolling. The TUI auto-activates whenever stdout is a TTY.

If you prefer the older plain-ANSI REPL — for piping, logging, recording sessions, or running inside environments where the TUI misbehaves — pass `--ansi`:

```bash
litecode --ansi "add a test for foo"
litecode --ansi chat
```

No other behavior changes — memory, diffs, and confirmation prompts all work identically in both modes.

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
│  + last 2 memory entries.   │
│  Figures out which files    │
│  need to change and in      │
│  what order.                │
│                             │
│  Output: { synthesis, tasks }
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
             │
             ▼
    ┌─────────────────┐
    │ memory.json     │  ← Synthesis + files saved after successful apply
    └─────────────────┘
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

These files are plain Markdown. You can read them. They're safe to commit to git — they act as a persistent record of your project's structure between sessions.

---

## Token Budget

Every LLM call is budgeted like this:

```
Total context window:           8192 tokens
─────────────────────────────────────────────
System prompt + instructions:  ~1000 tokens
Reserved for AI response:      ~2000 tokens
Memory (up to 2 entries):       ~180 tokens
─────────────────────────────────────────────
Available for your code:       ~5000 tokens  (≈ 150–200 lines)
```

The token counter runs **before every LLM call**. If the code doesn't fit, LiteCode automatically falls back to loading just the relevant section using the file's analysis index. This check never gets skipped.

Priority when budget is tight: folder context is dropped first, then memory, to preserve the most recent history as long as possible.

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

LiteCode will plan the tasks, execute them, then show you a colored diff for each file and ask before writing anything:

```
  src/auth.js  modified ─────────────────────────────
  --- src/auth.js
  +++ src/auth.js
  @@ -12,6 +12,10 @@
   async function fetchUser(id) {
  +  if (!id) throw new Error('id is required');
     const res = await db.users.findById(id);
  +  if (!res) throw new Error('user not found');
     return res;
   }

  src/auth.js — apply? [y]es [n]o [a]ll [q]uit :
```

Type `y` to apply, `n` to skip, `a` to apply all remaining files without prompting, or `q` to stop.

To skip all prompts (e.g. in scripts or CI):

```bash
litecode --yes "add error handling to the fetchUser function"
```

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
| `litecode "your request"` | Run one request and exit (shows diff + prompts before each write) |
| `litecode --yes "your request"` | Same, but applies all changes without prompting |
| `litecode --sequential "your request"` | Force tasks to run one at a time (default for local providers) |
| `litecode --parallel "your request"` | Force parallel execution even for local providers |
| `litecode --verbose "your request"` | Print the chosen executor mode and token counts |
| `litecode` | Start the interactive TUI (persistent chat, scroll, sidebar) |
| `litecode --ansi` | Start the plain-terminal interactive mode (no TUI) |
| `litecode chat` | Same as `litecode` |

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

**Memory-aware requests** (v1.0+):

| Request | What LiteCode does |
|---|---|
| `"undo the last change"` | Reverses whatever it did in the previous run |
| `"revert what you did to auth.js"` | Uses memory to find the specific change and reverses it |
| `"also add X"` | Treats the current request as a continuation of the last one |

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
│   │   ├── planner.ts        # Sends project map + memory + request → gets { synthesis, tasks }
│   │   ├── executor.ts       # Sends one file + one task to LLM → gets edited content
│   │   ├── scheduler.ts      # Builds dependency graph, runs waves in parallel
│   │   ├── applier.ts        # Writes LLM output to disk (or deletes files), returns applied paths
│   │   └── memory.ts         # loadMemory / appendMemory / formatMemoryForPrompt (ring buffer of 2)
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
│   ├── tui/
│   │   ├── App.tsx           # Ink root component (two-pane layout)
│   │   ├── store.ts          # Shared state for TUI (messages, spinners, usage)
│   │   └── TuiDisplay.ts     # Display adapter that drives the TUI store
│   │
│   └── config/
│       └── config.ts         # Reads litecode.json, merges with ~/.litecode/config.json
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
- Memory is written only after at least one file is actually applied to disk — failed or skipped runs don't pollute history.
- No streaming. Full responses only — simpler and more reliable with small models.

---

## `.litecode/` directory

When you run LiteCode in a project, it creates a `.litecode/` folder:

```
.litecode/
└── memory.json    ← Ring buffer of last 2 completed actions
```

You can safely add this to `.gitignore` if you don't want it committed:

```
# .gitignore
.litecode/
litecode.json
```

Or commit it if you want memory to persist across machines and teammates. It's plain JSON — readable and diffable.

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

**"Undo" doesn't target the right file**
Memory stores the last 2 completed runs. If more than 2 runs have passed since the change you want to undo, memory won't have it — name the file explicitly instead: `"remove the hello() function from utils.js"`.

**Edits are wrong or incomplete**
- Be more specific in your request (name the function, describe the exact change).
- Run `litecode analyze src/yourfile.js` to give the agent a better line-level index before editing a large file.

**Ollama drops connections**
As of v0.4, LiteCode detects local providers and runs tasks sequentially by default. If you're still hitting drops, confirm your `baseURL` is `http://localhost:11434/v1`. Use `--parallel` only if you've confirmed Ollama can handle concurrent requests.

**Output has markdown fences (triple backticks) in the code**
The model wrapped its response in code blocks despite being told not to. LiteCode strips these automatically, but if it persists, switch to a model with stronger instruction-following (Qwen2.5-Coder or DeepSeek-Coder).

---

## Known Issues

- **Weak models misclassify complex requests** — Models with poor instruction-following occasionally output non-JSON from the planner or generate markdown fences in executor output. Use Qwen2.5-Coder or DeepSeek-Coder for best results.
- **Large binary files in project** — If your project contains large binary files (images, compiled assets) in the same directory, context map generation may be slow. Add them to a `.litecode_ignore` file (future feature) for now.
- **Sequential task chains > 5 deep** — Very deep dependency chains may hit the planner's task limit on some small models. Break the request into smaller steps.

---

## Changelog

### v1.0.0

- **Short-term memory** — LiteCode now remembers the last 2 completed actions per project in `.litecode/memory.json`. The planner receives this history on every call and can reason about "undo", "revert", "last time", and contextual follow-ups like "also add X". Memory is only written after at least one file is successfully applied to disk — failed or query-only runs don't count.
- **Planner synthesis** — The planner now outputs a `synthesis` field alongside `tasks`: a one-sentence plain-text description of what the plan will do (e.g. `"Added a hello() function in utils.js"`). This is stored in memory and used to inform the next request.
- **Ring buffer eviction** — The memory file never grows beyond 2 entries. Each new successful run evicts the oldest entry automatically.
- **Version bumped to 1.0.0.**

### v0.4.0

- **TUI by default** — Full Ink + React terminal UI with two-pane layout, live token sidebar, per-task spinners, and inline diff previews. Use `--ansi` to opt out.
- **Mouse wheel + keyboard scroll** — Arrow keys, PgUp/PgDn, `g`/`G` for top/bottom, xterm SGR mouse wheel support.
- **Auto-sequential for local models** — Any provider on `localhost` / `127.0.0.1` / `0.0.0.0` / `::1` defaults to `maxParallelExecutors=1`. Use `--parallel` to override.

### v0.3.0

- **`--sequential` flag** — Force tasks to run one at a time (useful for Ollama and LM Studio).

### v0.2.0

- **Diff preview before every write** — Colored unified diff, per-file `[y]es / [n]o / [a]ll / [q]uit` prompts.
- **`--yes` flag** — Skip all prompts.
- **`action_type: query`** — Read-only questions no longer write to files.

### v0.1.x

- **Stale map guard** — Explicit error when a mentioned file path isn't on disk, rather than silently misrouting the action.

---

## Contributing

Pull requests welcome. Before opening one:
- Run `npm run build` to verify the TypeScript compiles clean.
- Test against a small project with `litecode init --fast` followed by a simple edit request.
- Keep the token-budget rules intact — every LLM call must go through `canFit()` before firing.
- Memory must only be written when `appliedFiles.length > 0 && synthesis` — do not save memory for failed or query-only runs.
- Copy `litecode.example.json` to `litecode.json` and fill in your own key for local testing. Never commit `litecode.json`.

---

## License

ISC — do whatever you want with it.

Legal Disclaimer: LiteCode is an independent open-source project. It is not affiliated with, endorsed by, or in any way connected to any other company or product sharing the same name.
