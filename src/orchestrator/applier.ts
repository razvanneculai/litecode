import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import type { Task } from "./planner.js";
import type { ExecutionResult } from "./scheduler.js";
import type { Display } from "../ui/display.js";

function applySection(
  original: string,
  newContent: string,
  sections: { start: number; end: number }
): string {
  const originalLines = original.split("\n");
  const newLines = newContent.split("\n");
  const stripped = newLines.map(line => line.replace(/^\d+: /, ""));
  const before = originalLines.slice(0, sections.start - 1);
  const after = originalLines.slice(sections.end);
  return [...before, ...stripped, ...after].join("\n");
}

function stripFences(content: string): string {
  // Remove opening fence (```lang or ```) and closing ```
  return content.replace(/^```[a-zA-Z]*\r?\n/, "").replace(/\n```\s*$/, "").trim();
}

export async function apply(
  results: ExecutionResult[],
  tasks: Task[],
  projectRoot: string,
  display?: Display
): Promise<void> {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  for (const result of results) {
    const task = taskMap.get(result.taskId);

    if (!task) {
      display?.fileFail(result.file, result.error ?? "unknown error");
      continue;
    }

    const absFile = resolve(projectRoot, task.file);

    // Handle delete tasks (no LLM content involved)
    if (task.action_type === "delete") {
      if (!result.success) {
        display?.fileFail(task.file, result.error ?? "unknown error");
        continue;
      }
      try {
        if (existsSync(absFile)) {
          unlinkSync(absFile);
          display?.fileWrite(task.file, "deleted");
        } else {
          display?.warn(`${task.file}: already absent — nothing to delete`);
        }
      } catch (err) {
        display?.fileFail(task.file, (err as Error).message);
      }
      continue;
    }

    if (!result.success || !result.content) {
      display?.fileFail(result.file, result.error ?? "unknown error");
      continue;
    }

    try {
      mkdirSync(dirname(absFile), { recursive: true });
      const cleaned = stripFences(result.content);
      if (task.load_sections) {
        const original = readFileSync(absFile, "utf-8");
        const updated = applySection(original, cleaned, task.load_sections);
        writeFileSync(absFile, updated, "utf-8");
        display?.fileWrite(task.file, `lines ${task.load_sections.start}–${task.load_sections.end}`);
      } else {
        writeFileSync(absFile, cleaned, "utf-8");
        display?.fileWrite(task.file);
      }
    } catch (err) {
      display?.fileFail(task.file, (err as Error).message);
    }
  }
}
