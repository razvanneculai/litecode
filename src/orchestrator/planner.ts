import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { Config } from "../config/config.js";
import { callLLM } from "../llm/client.js";
import { buildPlannerPrompt, buildRetryPlannerPrompt } from "../llm/prompts.js";
import { canFit } from "../tokens/budget.js";
import { loadProjectMap, loadFolderMap } from "../context/loader.js";
import type { Display } from "../ui/display.js";

export interface Task {
  id: string;
  file: string;
  action: string;
  action_type?: "edit" | "create" | "delete";
  load_sections: { start: number; end: number } | null;
  needs_context_from: string[];
  depends_on: string[];
}

// Extract path-like tokens from a freeform user request
// Matches things like "src/foo.ts", "routes\\api.js", "utils.py"
function extractMentionedFiles(text: string): string[] {
  const matches = text.match(/[\w./\\-]+\.[a-zA-Z][\w]{0,5}/g) ?? [];
  return matches
    .map(m => m.replace(/\\/g, "/"))
    .filter(m => /[a-zA-Z]/.test(m) && !m.startsWith(".") && m.length > 2);
}

function pathsMatch(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").replace(/^\.\//, "");
  const nb = b.replace(/\\/g, "/").replace(/^\.\//, "");
  return na === nb || na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

interface PlannerResponse {
  tasks: Task[];
}

function extractJSON(raw: string): string {
  // Strip markdown fences
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1].trim() : raw.trim();

  // Try object first {"tasks":[...]}
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1) return text.slice(objStart, objEnd + 1);

  // Model returned a bare array [...] — wrap it
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd !== -1) {
    return `{"tasks":${text.slice(arrStart, arrEnd + 1)}}`;
  }

  return text;
}

function validateTasks(tasks: Task[], projectRoot: string): string[] {
  const errors: string[] = [];
  const ids = new Set(tasks.map(t => t.id));

  for (const task of tasks) {
    if (!task.id) errors.push(`Task missing 'id'`);
    if (!task.file) errors.push(`Task ${task.id} missing 'file'`);
    if (!task.action) errors.push(`Task ${task.id} missing 'action'`);

    // Note: Don't validate file existence - new files won't exist yet
    // The executor will create them

    for (const dep of task.depends_on ?? []) {
      if (!ids.has(dep)) {
        errors.push(`Task ${task.id}: depends_on unknown task '${dep}'`);
      }
    }
  }

  return errors;
}

function loadAllFolderMaps(projectRoot: string): string {
  let entries: import("fs").Dirent[];
  try { entries = readdirSync(projectRoot, { withFileTypes: true }) as import("fs").Dirent[]; } catch { return ""; }
  const parts: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const map = loadFolderMap(join(projectRoot, entry.name));
    if (map) parts.push(map);
  }
  return parts.join("\n\n");
}

export async function plan(
  userRequest: string,
  projectRoot: string,
  config: Config,
  display?: Display
): Promise<Task[]> {
  display?.startSpinner("Reading project map…");

  let projectContext = loadProjectMap(projectRoot);

  let folderCtx = loadAllFolderMaps(projectRoot);

  const budget = canFit(
    "You are a coding task planner.",
    userRequest,
    [projectContext + folderCtx],
    config
  );

  if (!budget.fits && folderCtx) {
    folderCtx = "";
    display?.thinking("Folder context too large — dropped to fit token budget");
  }

  const context = (projectContext + folderCtx).trim();

  display?.thinking(
    `Context: ${budget.totalTokens} tokens  (${config.tokenLimit - config.reservedOutputTokens - config.systemPromptBudget - budget.totalTokens} remaining for output)`
  );

  display?.updateSpinner("Asking LLM to plan tasks…");

  const messages = buildPlannerPrompt(context, userRequest);
  let raw = await callLLM(messages, config);

  let parsed: PlannerResponse;
  try {
    parsed = JSON.parse(extractJSON(raw)) as PlannerResponse;
  } catch {
    display?.thinking("Response wasn't valid JSON — retrying with stricter prompt…");
    const retryMessages = buildRetryPlannerPrompt(context, userRequest);
    raw = await callLLM(retryMessages, config);
    try {
      parsed = JSON.parse(extractJSON(raw)) as PlannerResponse;
    } catch (err) {
      display?.stopSpinner("Planner failed", false);
      throw new Error(
        `Planner failed to produce valid JSON after retry: ${(err as Error).message}\nRaw: ${raw.slice(0, 500)}`
      );
    }
  }

  const tasks = parsed.tasks ?? [];
  display?.stopSpinner("Plan ready");

  const errors = validateTasks(tasks, projectRoot);
  if (errors.length > 0) {
    for (const e of errors) display?.warn(e);
    const validIds = new Set(
      tasks.filter(t => existsSync(resolve(projectRoot, t.file))).map(t => t.id)
    );
    return tasks.filter(t => validIds.has(t.id));
  }

  // ─── Bug #2 guard: stale-map silent misroute ────────────────────────────
  // If the user explicitly named a file path in their request, ensure the
  // planner actually targeted it (or that it exists at all). Otherwise the
  // planner is silently routing the action to the wrong file.
  const mentioned = extractMentionedFiles(userRequest);
  for (const userFile of mentioned) {
    const matchingTasks = tasks.filter(t => pathsMatch(t.file, userFile));
    const existsOnDisk = existsSync(resolve(projectRoot, userFile));

    if (matchingTasks.length === 0) {
      // Planner ignored a file the user explicitly named
      if (!existsOnDisk) {
        throw new Error(
          `You mentioned '${userFile}' but it doesn't exist on disk and no task targets it. ` +
          `If you just created or renamed it, refresh the project map with 'litecode init --fast'.`
        );
      }
      display?.warn(
        `You mentioned '${userFile}' but the planner did not include it in any task. ` +
        `Proceeding with the planner's choice — review carefully.`
      );
      continue;
    }

    // Planner targeted the file. If it doesn't exist on disk, only allow that
    // when the action_type is explicitly 'create' — otherwise the planner is
    // about to silently turn a missing-file edit into a new-file write.
    if (!existsOnDisk) {
      const isCreate = matchingTasks.every(t => t.action_type === "create");
      if (!isCreate) {
        throw new Error(
          `You asked to modify '${userFile}' but it doesn't exist on disk. ` +
          `If you meant to create it, say 'create ${userFile}'. ` +
          `If you just renamed/moved it, refresh the project map with 'litecode init --fast'.`
        );
      }
    }
  }

  return tasks;
}
