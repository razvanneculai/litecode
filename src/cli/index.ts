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

const cwd = process.cwd();

program
  .name("litecode")
  .description("CLI coding agent for 8k-context LLMs")
  .version("0.1.0")
  .option("-v, --verbose", "Show token counts and debug info");

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
  .action(() => runInteractive());

// ─── litecode "<prompt>" (default) ───────────────────────────────────────────

program
  .argument("[prompt]", "Single prompt to run and exit")
  .action(async (prompt: string | undefined) => {
    if (prompt) {
      await runPipeline(prompt);
    } else {
      await runInteractive();
    }
  });

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(userRequest: string): Promise<void> {
  const display = new Display();
  const config = loadConfig(cwd);
  await initEncoder();

  display.section(`"${userRequest}"`);

  // Plan
  let tasks;
  try {
    tasks = await plan(userRequest, cwd, config, display);
  } catch (err) {
    display.error((err as Error).message);
    return;
  }

  if (tasks.length === 0) {
    display.warn("Planner returned no tasks.");
    return;
  }

  display.taskList(tasks);

  // Execute
  const results = await schedule(tasks, cwd, config, display, userRequest);

  // Apply
  display.blank();
  await apply(results, tasks, cwd, display);

  // Summary
  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;
  display.blank();
  if (failed === 0) {
    display.success(`${succeeded} file${succeeded === 1 ? "" : "s"} updated`);
  } else {
    display.warn(`${succeeded} succeeded, ${failed} failed`);
  }
}

// ─── Interactive REPL ─────────────────────────────────────────────────────────

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
