import type { Message } from "./client.js";

export function buildPlannerPrompt(
  projectContext: string,
  userRequest: string
): Message[] {
  return [
    {
      role: "system",
      content:
        "You are a coding task planner. Read the project map. " +
        "Output ONLY a valid JSON object in this exact shape: {\"tasks\": [...]}. " +
        "Do NOT return a bare array. Do NOT write code. Do NOT explain. ONLY output the JSON object.\n\n" +
        "Each task must have: id (string), file (string, relative path), action (string), " +
        "action_type ('edit' | 'create' | 'delete'), " +
        "load_sections (null or {start,end}), needs_context_from (string[]), depends_on (string[]).\n\n" +
        "Rules:\n" +
        "- One task per file.\n" +
        "- action_type: 'edit' for modifying an existing file, 'create' for a new file, " +
        "'delete' for removing a file from disk. If the user asks to delete/remove a file, you MUST " +
        "use action_type 'delete' — do NOT emit an edit task that empties the file.\n" +
        "- The 'action' field MUST be a full sentence describing exactly what to change in that file. " +
        "Example: 'Add console.log(\"Loading config\") as the first line inside the loadConfig function body.' " +
        "NEVER use generic words like 'edit', 'update', 'modify', or 'change' alone — always describe the exact change. " +
        "For delete tasks, the action can be a brief reason (e.g. 'Delete this file as requested by the user').\n" +
        "- depends_on lists task IDs that must complete first.\n" +
        "- load_sections is null unless the file is large and only a range is needed.\n" +
        "- needs_context_from lists other files to read (not edit).",
    },
    {
      role: "user",
      content: `Project map:\n${projectContext}\n\nRequest: ${userRequest}`,
    },
  ];
}

export function buildExecutorPrompt(
  action: string,
  fileContent: string,
  referenceFiles: { name: string; content: string }[],
  isNewFile = false,
  fileName = "",
  originalRequest = ""
): Message[] {
  const refSection =
    referenceFiles.length > 0
      ? "\n\n" +
        referenceFiles
          .map(r => `--- Reference: ${r.name} ---\n${r.content}`)
          .join("\n\n")
      : "";

  // Detect file type from extension for better prompting
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const fileTypeHint = ext ? `FILE TYPE: ${ext.toUpperCase()}\n` : '';

  const fileSection = isNewFile
    ? `--- Create new file: ${fileName} ---\n(create this file from scratch)`
    : `--- File to edit: ${fileName} ---\n${fileContent}`;

  const systemPrompt = isNewFile
    ? `You are a code generator. ${fileTypeHint}Create a complete new file from scratch matching the requested file type. ` +
      "Output ONLY the complete file content. " +
      "No markdown fences. No explanations. No commentary. Just the code."
    : `You are a code editor. Output ONLY the complete modified file content. ` +
      "No markdown fences. No explanations. No commentary. Just the code.";

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content:
        (originalRequest ? `User request: ${originalRequest}\nSpecific task: ${action}\n\n` : `Task: ${action}\n\n`) +
        fileSection +
        refSection +
        (isNewFile ? "\n\nIMPORTANT: Output ONLY the file content, nothing else." : ""),
    },
  ];
}

// ─── Deep analysis prompts ────────────────────────────────────────────────────

export function buildFileAnalysisPrompt(
  filePath: string,
  content: string
): Message[] {
  return [
    {
      role: "system",
      content:
        "You are a code indexer. Output ONLY structured markdown — no prose, no fences.\n" +
        "Format:\n" +
        "# <filename> (<N> lines)\n" +
        "<one sentence: what this file does>\n\n" +
        "## Lines A-B: <section title>\n" +
        "- <what it does>\n" +
        "- Imports: <list or none>\n" +
        "- Exports: <list or none>\n" +
        "- Calls: <list or none>\n" +
        "- Called by: <list or none>\n\n" +
        "## Navigation\n" +
        "- <task type> → Lines A-B\n\n" +
        "Rules: group lines into logical sections of 5-30 lines each. " +
        "Be concise. Every section must have a line range.",
    },
    {
      role: "user",
      content: `File: ${filePath}\n\n${content}`,
    },
  ];
}

// Ask the LLM for a single sentence describing what a folder does.
// Input: folder name + one-line summaries of each file in it.
// Output: ONE sentence, no markdown, no lists.
export function buildFolderDescriptionPrompt(
  folderName: string,
  fileSummaries: string
): Message[] {
  return [
    {
      role: "system",
      content:
        "Output ONLY one plain sentence (under 120 characters) describing what this folder does. " +
        "No lists, no markdown, no bullet points, no fences. Just one sentence.",
    },
    {
      role: "user",
      content: `Folder: ${folderName}\nFiles:\n${fileSummaries}`,
    },
  ];
}

export function buildRetryPlannerPrompt(
  projectContext: string,
  userRequest: string
): Message[] {
  const base = buildPlannerPrompt(projectContext, userRequest);
  base.push({
    role: "assistant",
    content: "(previous response was not valid JSON)",
  });
  base.push({
    role: "user",
    content:
      "Your previous response was not valid JSON. " +
      "Output ONLY a JSON object with a 'tasks' array. Nothing else.",
  });
  return base;
}
