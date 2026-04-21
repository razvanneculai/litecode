import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import type { Task } from "./planner.js";
import type { ExecutionResult } from "./scheduler.js";
import type { Display } from "../ui/display.js";
import { computePatch, computeNewFilePatch, computeDeletePatch } from "../ui/differ.js";

export interface ApplyOptions {
  yes?: boolean;
}

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
  display?: Display,
  options?: ApplyOptions
): Promise<string[]> {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const skipConfirm = options?.yes ?? false;
  const applied: string[] = [];

  // Pre-pass: capture all original file contents before any writes
  const originals = new Map<string, string>();
  for (const result of results) {
    const task = taskMap.get(result.taskId);
    if (!task) continue;
    const absFile = resolve(projectRoot, task.file);
    originals.set(absFile, existsSync(absFile) ? readFileSync(absFile, "utf-8") : "");
  }

  let acceptAll = false;

  for (const result of results) {
    const task = taskMap.get(result.taskId);

    if (!task) {
      display?.fileFail(result.file, result.error ?? "unknown error");
      continue;
    }

    const absFile = resolve(projectRoot, task.file);
    const originalContent = originals.get(absFile) ?? "";

    // Handle delete tasks (no LLM content involved)
    if (task.action_type === "delete") {
      if (!result.success) {
        display?.fileFail(task.file, result.error ?? "unknown error");
        continue;
      }
      if (display && existsSync(absFile)) {
        const patch = computeDeletePatch(task.file, originalContent);
        display.diffHeader(task.file, "deleted");
        display.diffLines(patch);
      }
      if (!skipConfirm && !acceptAll && display) {
        const choice = await display.confirm(task.file);
        if (choice === "quit") return applied;
        if (choice === "all") acceptAll = true;
        if (choice === "no") { display.warn(`Skipped ${task.file}`); continue; }
      }
      try {
        if (existsSync(absFile)) {
          unlinkSync(absFile);
          display?.fileWrite(task.file, "deleted");
          applied.push(task.file);
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
      const cleaned = stripFences(result.content);
      let finalContent: string;
      if (task.load_sections) {
        finalContent = applySection(originalContent, cleaned, task.load_sections);
      } else {
        finalContent = cleaned;
      }

      // Show diff
      if (display) {
        if (!originalContent) {
          display.diffHeader(task.file, "new file");
          display.diffLines(computeNewFilePatch(task.file, finalContent));
        } else {
          display.diffHeader(task.file, "modified");
          display.diffLines(computePatch(task.file, originalContent, finalContent));
        }
      }

      // Confirm
      if (!skipConfirm && !acceptAll && display) {
        const choice = await display.confirm(task.file);
        if (choice === "quit") return applied;
        if (choice === "all") acceptAll = true;
        if (choice === "no") { display.warn(`Skipped ${task.file}`); continue; }
      }

      // Write
      mkdirSync(dirname(absFile), { recursive: true });
      writeFileSync(absFile, finalContent, "utf-8");
      applied.push(task.file);
      if (task.load_sections) {
        display?.fileWrite(task.file, `lines ${task.load_sections.start}–${task.load_sections.end}`);
      } else {
        display?.fileWrite(task.file);
      }
    } catch (err) {
      display?.fileFail(task.file, (err as Error).message);
    }
  }

  return applied;
}
