import type { Config } from "../config/config.js";
import type { Task } from "./planner.js";
import { execute } from "./executor.js";
import type { Display } from "../ui/display.js";

export interface ExecutionResult {
  taskId: string;
  file: string;
  success: boolean;
  content?: string;
  error?: string;
}

function buildWaves(tasks: Task[]): Task[][] {
  const completed = new Set<string>();
  const waves: Task[][] = [];
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const wave = remaining.filter(t =>
      t.depends_on.every(dep => completed.has(dep))
    );

    if (wave.length === 0) {
      wave.push(...remaining);
      // Will be surfaced via display in the caller
    }

    waves.push(wave);
    for (const t of wave) completed.add(t.id);
    remaining = remaining.filter(t => !completed.has(t.id));
  }

  return waves;
}

async function runBatch(
  tasks: Task[],
  projectRoot: string,
  config: Config,
  display?: Display,
  originalRequest = ""
): Promise<ExecutionResult[]> {
  const limit = config.maxParallelExecutors;
  const results: ExecutionResult[] = [];

  for (let i = 0; i < tasks.length; i += limit) {
    const batch = tasks.slice(i, i + limit);
    // Delete tasks bypass the LLM entirely — applier handles them directly.
    const settled = await Promise.allSettled(
      batch.map(task =>
        task.action_type === "delete"
          ? Promise.resolve("")
          : execute(task, projectRoot, config, display, originalRequest)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const task = batch[j];
      const outcome = settled[j];
      if (outcome.status === "fulfilled") {
        display?.taskDone(task.id, task.file);
        results.push({ taskId: task.id, file: task.file, success: true, content: outcome.value });
      } else {
        const msg = (outcome.reason as Error).message ?? String(outcome.reason);
        display?.taskFailed(task.id, task.file, msg);
        results.push({ taskId: task.id, file: task.file, success: false, error: msg });
      }
    }

    // Delay between batches to avoid rate limits (e.g., Groq = 20 req/min)
    if (i + limit < tasks.length) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  return results;
}

export async function schedule(
  tasks: Task[],
  projectRoot: string,
  config: Config,
  display?: Display,
  originalRequest = ""
): Promise<ExecutionResult[]> {
  const waves = buildWaves(tasks);
  const allResults: ExecutionResult[] = [];

  display?.startSpinner("Executing tasks…");

  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    display?.wave(wi + 1, waves.length, wave.map(t => t.file));
    const waveResults = await runBatch(wave, projectRoot, config, display, originalRequest);
    allResults.push(...waveResults);
  }

  display?.stopSpinner("Execution complete");
  return allResults;
}
