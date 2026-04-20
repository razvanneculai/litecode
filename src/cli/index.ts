#!/usr/bin/env node
import { createInterface } from "readline";
import { resolve } from "path";
import { program } from "commander";
import { loadConfig } from "../config/config.js";
import { runConnect } from "../connect/connect.js";
import { initEncoder } from "../tokens/counter.js";
import { initContextMaps, deepInit } from "../context/mapper.js";
import { analyzeFile } from "../context/analyzer.js";
import { plan } from "../orchestrator/planner.js";
import { schedule } from "../orchestrator/scheduler.js";
import { apply } from "../orchestrator/applier.js";
import { Display } from "../ui/display.js";
import { loadFileForEdit } from "../context/loader.js";
import { buildQueryPrompt } from "../llm/prompts.js";
import { callLLM } from "../llm/client.js";

const cwd = process.cwd();

function isLocalProvider(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return /localhost|127\.0\.0\.1/.test(baseURL);
  }
}

function shouldRunSequential(baseURL: string | undefined): boolean {
  const opts = program.opts();
  if (opts.parallel) return false;
  if (opts.sequential) return true;
  return isLocalProvider(baseURL);
}

program
  .name("litecode")
  .description("CLI coding agent for 8k-context LLMs")
  .version("0.2.0")
  .option("-v, --verbose", "Show token counts and debug info")
  .option("-y, --yes", "Apply all changes without confirmation")
  .option("-s, --sequential", "Run tasks one at a time (default for local models)")
  .option("-p, --parallel", "Force parallel task execution, even for local models")
  .option("--ansi", "Use plain ANSI terminal instead of the TUI");

// ─── litecode connect ─────────────────────────────────────────────────────────

program
  .command("connect")
  .description("Interactively select LLM provider and model")
  .action(() => runConnect(cwd));

// ─── litecode init / map ──────────────────────────────────────────────────────

async function runMap(label: string, fast = false): Promise<void> {
  const display = new Display();
  display.section(label + (fast ? " (fast mode)" : ""));

  let count = 0;
  const onFile = (filePath: string) => {
    display.mapFile(filePath, cwd);
    count++;
  };

  if (fast) {
    await initContextMaps(cwd, onFile);
  } else {
    const config = loadConfig(cwd);
    await initEncoder();
    await deepInit(cwd, config, onFile);
  }

  display.blank();
  display.success(`${count} context file${count === 1 ? "" : "s"} written`);
}

program
  .command("init")
  .description("Scan project and generate deep LLM-powered context maps")
  .option("--fast", "Skip LLM analysis — use fast pattern-matching only")
  .action((opts: { fast?: boolean }) => runMap("Initialising context maps", opts.fast ?? false));

program
  .command("map")
  .description("Regenerate all context maps")
  .option("--fast", "Skip LLM analysis — use fast pattern-matching only")
  .action((opts: { fast?: boolean }) => runMap("Rebuilding context maps", opts.fast ?? false));

// ─── litecode analyze <file> ──────────────────────────────────────────────────

program
  .command("analyze <file>")
  .description("Generate a file_analysis.md for the specified file")
  .action(async (file: string) => {
    const display = new Display();
    const config = loadConfig(cwd);
    await initEncoder();

    const absFile = resolve(cwd, file);
    display.section(`Analyzing ${file}`);
    display.startSpinner("Sending chunks to LLM…");

    const outPath = await analyzeFile(absFile, config);

    display.stopSpinner("Analysis complete");
    display.fileWrite(outPath);
  });

// ─── litecode chat ────────────────────────────────────────────────────────────

program
  .command("chat")
  .description("Start interactive chat mode")
  .action(() => startInteractive());

// ─── litecode "<prompt>" (default) ───────────────────────────────────────────

program
  .argument("[prompt]", "Single prompt to run and exit")
  .action(async (prompt: string | undefined) => {
    if (prompt) {
      await runPipeline(prompt);
    } else {
      await startInteractive();
    }
  });

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipelineWithDisplay(
  userRequest: string,
  display: Display | import("../tui/TuiDisplay.js").TuiDisplay,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  display.section(`"${userRequest}"`);

  let tasks;
  try {
    tasks = await plan(userRequest, cwd, config, display as Display);
  } catch (err) {
    display.error((err as Error).message);
    return;
  }

  if (tasks.length === 0) {
    display.warn("Planner returned no tasks.");
    return;
  }

  const queryTasks = tasks.filter(t => t.action_type === "query");
  const editTasks = tasks.filter(t => t.action_type !== "query");

  for (const task of queryTasks) {
    const absFile = resolve(cwd, task.file);
    let fileContent: string;
    try {
      fileContent = loadFileForEdit(absFile, task.load_sections ?? undefined);
    } catch {
      display.warn(`Could not read ${task.file} to answer query.`);
      continue;
    }
    const messages = buildQueryPrompt(task.action, fileContent, task.file);
    display.startSpinner(`Reading ${task.file}…`);
    let answer: string;
    try {
      const result = await callLLM(messages, config);
      answer = result.content;
      display.onUsage?.(result.usage);
    } catch (err) {
      display.stopSpinner("Query failed", false);
      display.error((err as Error).message);
      continue;
    }
    display.stopSpinner("Done");
    display.blank();
    display.info(answer);
  }

  if (editTasks.length === 0) return;

  display.taskList(editTasks);

  const opts = program.opts();
  if (shouldRunSequential(config.provider?.baseURL)) config.maxParallelExecutors = 1;
  if (opts.verbose) {
    display.info(`Executor mode: ${config.maxParallelExecutors === 1 ? "sequential" : `parallel (max ${config.maxParallelExecutors})`}`);
  }
  const results = await schedule(editTasks, cwd, config, display as Display, userRequest);

  display.blank();
  await apply(results, editTasks, cwd, display as Display, { yes: opts.yes ?? false });

  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;
  display.blank();
  if (failed === 0) {
    display.success(`${succeeded} file${succeeded === 1 ? "" : "s"} updated`);
  } else {
    display.warn(`${succeeded} succeeded, ${failed} failed`);
  }
}

async function runPipeline(userRequest: string): Promise<void> {
  const display = new Display();
  const config = loadConfig(cwd);
  await initEncoder();
  await runPipelineWithDisplay(userRequest, display, config);
}

// ─── TUI interactive ──────────────────────────────────────────────────────────

async function runTuiInteractive(): Promise<void> {
  await initEncoder();
  const config = loadConfig(cwd);

  const { TuiStore } = await import("../tui/store.js");
  const { TuiDisplay } = await import("../tui/TuiDisplay.js");
  const { render } = await import("ink");
  const { default: App } = await import("../tui/App.js");

  const store = new TuiStore();
  const display = new TuiDisplay(store);

  const handleSubmit = async (text: string) => {
    if (text === "/connect") {
      await runConnect(cwd);
      return;
    }
    const freshConfig = loadConfig(cwd);
    if (shouldRunSequential(freshConfig.provider?.baseURL)) freshConfig.maxParallelExecutors = 1;
    await runPipelineWithDisplay(text, display, freshConfig);
  };

  const React = await import("react");
  render(React.default.createElement(App, { store, config, onSubmit: handleSubmit }));
}

// ─── Entry point selector ─────────────────────────────────────────────────────

async function startInteractive(): Promise<void> {
  const opts = program.opts();
  if (opts.ansi || !process.stdout.isTTY) {
    await runInteractive();
  } else {
    await runTuiInteractive();
  }
}

// ─── Interactive REPL (ANSI fallback) ────────────────────────────────────────

async function runInteractive(): Promise<void> {
  await initEncoder();

  const config = loadConfig(cwd);
  const display = new Display();
  display.banner(config.provider.model || undefined, config.provider.baseURL || undefined);
  display.info('Type a request, \x1b[33m/connect\x1b[0m to change model, or \x1b[2mexit\x1b[0m to quit.');
  display.blank();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = (): Promise<string> =>
    new Promise(res => rl.question("\x1b[36m>\x1b[0m ", res));

  while (true) {
    const input = (await ask()).trim();
    if (!input) continue;
    if (input === "exit" || input === "quit") {
      rl.close();
      break;
    }
    if (input === "/connect") {
      rl.close();
      await runConnect(cwd);
      // Re-open REPL after connect
      return runInteractive();
    }
    await runPipeline(input);
    display.blank();
  }
}

program.parse(process.argv);
