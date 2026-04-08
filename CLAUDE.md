# LiteCode — AI Coding Agent for Small Context Models

## What This Is

LiteCode is an open-source CLI coding agent (like OpenCode/Claude Code) designed specifically for LLMs with 8k token context windows. It enables full agentic coding workflows on free API tiers and local models (Ollama, LM Studio) that most developers actually have access to.

## Core Architecture: Orchestrator + Workers

This is NOT a single-model-tries-to-do-everything system. The architecture is:

1. **Orchestrator** — pure code, zero AI. Manages token budgets, dependency graphs, file loading, and request sequencing.
2. **Planner** — one 8k LLM call that sees the project map + user request, outputs a structured JSON task list.
3. **Executors** — independent 8k LLM calls, one per file edit. Each gets full context budget for just one job.

The models are disposable workers. All intelligence about *what* to do and *in what order* lives in the orchestrator.

## Token Budget (8k model)

```
System prompt + tool defs:  ~1000 tokens
User message:               ~200-400 tokens  
Reserved for output:        ~1500-2000 tokens
═══════════════════════════════════════════
Usable context for code:    ~4500-5000 tokens (~150-200 lines)
```

The token counter must enforce this BEFORE every LLM call. No exceptions.

## Three-Layer Context Map System

```
project/
├── project_context.md          # Layer 1: root map (~300-500 tokens)
│                                # Tech stack, entry points, folder descriptions
├── src/
│   ├── folder_context.md       # Layer 2: folder map (~200-400 tokens each)
│   │                            # File list, 1-line descriptions, cross-deps
│   ├── auth.js
│   ├── auth.file_analysis.md   # Layer 3: ONLY for files >150 lines
│   │                            # Line-range index with deps
│   └── ...
├── routes/
│   ├── folder_context.md
│   └── ...
```

- Layer 1 (`project_context.md`): What you'd tell a dev in 60 seconds. Every top-level folder, one sentence each.
- Layer 2 (`folder_context.md`): Every file in that folder, one-line description, imports/exports, coupling notes.
- Layer 3 (`*.file_analysis.md`): Only generated for files >150 lines. Structured line-range index.

## File Analysis Format (Layer 3)

When a file exceeds ~150 lines, analyze it in ~120-line chunks and produce:

```markdown
# auth.js (287 lines)

## Lines 1-15: Imports and config
- Imports: jsonwebtoken, bcrypt, ../utils/crypto
- Exports: authenticateUser, refreshToken, hashPassword

## Lines 17-89: authenticateUser()
- Takes (email, password), returns JWT or throws
- Calls: hashPassword, db.users.findByEmail
- Called by: routes/login.js

## Lines 91-158: refreshToken()
- Takes (token), returns new JWT
- Calls: jwt.verify, db.tokens.findValid
- Called by: routes/refresh.js
```

This format is rigid and predictable. The model reads it and requests exact line ranges.

## Orchestrator Workflow

### For a typical user request:

```
User: "Rename validateToken to verifyToken everywhere"
                    │
                    ▼
         ┌─────────────────┐
         │  PLANNER (1 LLM │
         │  call, sees      │
         │  project_context │
         │  + request)      │
         └────────┬────────┘
                  │ outputs JSON task list
                  ▼
         ┌─────────────────┐
         │  ORCHESTRATOR    │
         │  (pure code)     │
         │  - parse tasks   │
         │  - build dep     │
         │    graph         │
         │  - load files    │
         │  - check token   │
         │    budgets       │
         └────────┬────────┘
                  │ fires executor requests
                  ▼
    ┌─────────┬─────────┬─────────┐
    │Executor │Executor │Executor │  (parallel if independent)
    │auth.js  │login.js │refresh.js│
    │(8k)     │(8k)     │(8k)     │
    └────┬────┴────┬────┴────┬────┘
         │         │         │
         ▼         ▼         ▼
    Apply edits to disk (pure code)
```

### Planner Output Schema:

```json
{
  "tasks": [
    {
      "id": "task_1",
      "file": "src/auth.js",
      "action": "rename validateToken to verifyToken in function declaration",
      "load_sections": null,
      "needs_context_from": ["types/auth.d.ts"],
      "depends_on": []
    },
    {
      "id": "task_2", 
      "file": "routes/login.js",
      "action": "update import and all calls from validateToken to verifyToken",
      "load_sections": null,
      "needs_context_from": [],
      "depends_on": []
    }
  ]
}
```

- `load_sections`: null means load full file. If file is too big: `{"start": 17, "end": 89}`
- `depends_on`: empty = can run in parallel. `["task_1"]` = must wait for task_1 to finish first.
- `needs_context_from`: read-only reference files loaded alongside the target file.

### Task Dependency Types:

- **Independent** (parallel): renaming across files, formatting, adding imports. `depends_on: []`
- **Sequential** (ordered): extract function to new file, then update imports. `depends_on: ["task_1"]`

## Token Counter (No AI)

The token counter is a pure code utility. It uses the tokenizer matching the target model (tiktoken for OpenAI-compat, SentencePiece for Llama-family, character-based fallback).

```
canFit(systemPrompt, userMessage, files[]) → {
  fits: boolean,
  totalTokens: number,
  remaining: number,
  suggestion: "load_full" | "load_section" | "needs_analysis"
}
```

This runs BEFORE every LLM call. If it says no, the orchestrator falls back to loading sections or generating an analysis file first.

## Tech Stack

- **Language**: TypeScript (Node.js)
- **CLI framework**: Commander.js
- **LLM communication**: Plain HTTP fetch to OpenAI-compatible API endpoints (works with Ollama, LM Studio, OpenRouter, any provider)
- **Token counting**: tiktoken (for OpenAI-compat) + fallback character estimation (~3.5 chars/token)
- **Storage**: filesystem only (markdown files for maps/analysis, JSON for config)
- **No database**: everything is files in the project directory

## Project Structure

```
litecode/
├── src/
│   ├── cli/                 # CLI entry point, argument parsing
│   │   └── index.ts
│   ├── orchestrator/        # Core orchestration logic
│   │   ├── planner.ts       # Builds and sends planner prompt
│   │   ├── executor.ts      # Builds and sends per-file edit prompts
│   │   ├── scheduler.ts     # Dependency graph, parallel/sequential dispatch
│   │   └── applier.ts       # Writes LLM outputs back to files
│   ├── context/             # Context map system
│   │   ├── mapper.ts        # Generates project_context.md, folder_context.md
│   │   ├── analyzer.ts      # Generates file_analysis.md for large files
│   │   └── loader.ts        # Reads maps/files, respects token budgets
│   ├── tokens/              # Token counting
│   │   ├── counter.ts       # Token count for any string
│   │   └── budget.ts        # canFit() logic, budget allocation
│   ├── llm/                 # LLM communication
│   │   ├── client.ts        # HTTP client for OpenAI-compatible APIs
│   │   └── prompts.ts       # System prompts for planner and executors
│   └── config/              # Configuration
│       └── config.ts        # Read/write litecode.json
├── package.json
├── tsconfig.json
├── CLAUDE.md                # This file
└── README.md
```

## Commands

- `litecode init` — scan project, generate context maps
- `litecode` or `litecode chat` — interactive mode  
- `litecode "do something"` — single prompt mode
- `litecode map` — regenerate all context maps
- `litecode analyze <file>` — force-generate analysis for a specific file

## Key Development Rules

1. **Token counter runs before EVERY LLM call.** No call goes out without a budget check.
2. **The orchestrator never calls the LLM directly.** It always goes through planner.ts or executor.ts.
3. **One executor = one file.** Never send two files to edit in a single executor call.
4. **Context maps are markdown.** Not JSON, not YAML. Markdown is readable by humans AND cheap on tokens.
5. **Fail gracefully.** If one executor fails, report it and continue. Don't crash the whole operation.
6. **No streaming required.** Wait for full responses. Simpler and more reliable with small models.
7. **Test with the worst case.** Always validate against 4k context too. If it works on 4k, it flies on 8k.

## LLM Provider Config (litecode.json)

```json
{
  "provider": {
    "baseURL": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "model": "qwen2.5-coder:7b"
  },
  "tokenLimit": 8192,
  "reservedOutputTokens": 2000,
  "systemPromptBudget": 1000,
  "maxParallelExecutors": 3
}
```

## What NOT To Build (Yet)

- No TUI (terminal UI). Start with simple stdin/stdout. TUI is a later feature.
- No database. Files only.
- No streaming. Full responses only.  
- No multi-provider support initially. Just OpenAI-compatible endpoint (covers Ollama, LM Studio, OpenRouter, and most free tiers).
- No git integration initially. Just edit files. The user handles git.