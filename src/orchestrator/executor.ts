import { resolve } from "path";
import type { Config } from "../config/config.js";
import { callLLM } from "../llm/client.js";
import { buildExecutorPrompt } from "../llm/prompts.js";
import { canFit } from "../tokens/budget.js";
import { loadFileForEdit } from "../context/loader.js";
import type { Task } from "./planner.js";
import type { Display } from "../ui/display.js";

export async function execute(
  task: Task,
  projectRoot: string,
  config: Config,
  display?: Display,
  originalRequest = ""
): Promise<string> {
  const absFile = resolve(projectRoot, task.file);

  let fileContent = loadFileForEdit(absFile, task.load_sections ?? undefined);
  const isNewFile = fileContent === "";

  let referenceFiles: { name: string; content: string }[] = task.needs_context_from.map(ref => {
    const absRef = resolve(projectRoot, ref);
    try {
      return { name: ref, content: loadFileForEdit(absRef) };
    } catch {
      return { name: ref, content: `(could not load ${ref})` };
    }
  });

  const systemPrompt = isNewFile
    ? "You are a code generator. Create a new file from scratch. Output ONLY the complete file content. " +
      "No markdown fences. No explanations. Just the code."
    : "You are a code editor. Output ONLY the complete modified file content. " +
      "No markdown fences. No explanations. Just the code.";

  let budget = canFit(
    systemPrompt,
    task.action,
    [fileContent, ...referenceFiles.map(r => r.content)],
    config
  );

  if (!budget.fits && !task.load_sections) {
    const totalLines = fileContent.split("\n").length;
    const halfLines = Math.floor(totalLines / 2);
    display?.thinking(`${task.file}: still over budget — loading first half (lines 1–${halfLines})`);
    fileContent = loadFileForEdit(absFile, { start: 1, end: halfLines });

    budget = canFit(
      systemPrompt,
      task.action,
      [fileContent, ...referenceFiles.map(r => r.content)],
      config
    );

    if (!budget.fits) {
      display?.warn(`${task.file}: still over budget (${budget.totalTokens} tok) — proceeding anyway`);
    }
  }

  display?.taskStart(task.id, task.file, budget.totalTokens);

  const messages = buildExecutorPrompt(task.action, fileContent, referenceFiles, isNewFile, task.file, originalRequest);
  return callLLM(messages, config);
}
