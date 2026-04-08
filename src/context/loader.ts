import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { countTokens } from "../tokens/counter.js";

const WARN_THRESHOLD = 4000; // tokens

function warnIfLarge(label: string, content: string): void {
  const tokens = countTokens(content);
  if (tokens > WARN_THRESHOLD) {
    process.stderr.write(
      `[Loader] Warning: "${label}" is ${tokens} tokens (threshold: ${WARN_THRESHOLD})\n`
    );
  }
}

export function loadProjectMap(projectRoot: string): string {
  const path = join(projectRoot, "project_context.md");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  warnIfLarge("project_context.md", content);
  return content;
}

export function loadFolderMap(folderPath: string): string {
  // Prefer deep-mode analysis file; fall back to fast-mode context file
  const analysisPath = join(folderPath, "folder_analysis.md");
  if (existsSync(analysisPath)) {
    const content = readFileSync(analysisPath, "utf-8");
    warnIfLarge(`${folderPath}/folder_analysis.md`, content);
    return content;
  }
  const ctxPath = join(folderPath, "folder_context.md");
  if (!existsSync(ctxPath)) return "";
  const content = readFileSync(ctxPath, "utf-8");
  warnIfLarge(`${folderPath}/folder_context.md`, content);
  return content;
}

export function loadFileForEdit(
  filePath: string,
  sections?: { start: number; end: number }
): string {
  // If file doesn't exist (new file creation), return empty string
  if (!existsSync(filePath)) {
    return "";
  }

  const raw = readFileSync(filePath, "utf-8");

  if (!sections) {
    warnIfLarge(filePath, raw);
    return raw;
  }

  // Return only the requested line range, 1-indexed, with line-number prefixes
  const allLines = raw.split("\n");
  const start = Math.max(1, sections.start);
  const end = Math.min(allLines.length, sections.end);
  const slice = allLines.slice(start - 1, end);
  const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
  warnIfLarge(`${filePath}:${start}-${end}`, numbered);
  return numbered;
}

export function loadFileAnalysis(filePath: string): string | null {
  const analysisPath = `${filePath}.file_analysis.md`;
  if (!existsSync(analysisPath)) return null;
  const content = readFileSync(analysisPath, "utf-8");
  warnIfLarge(`${filePath}.file_analysis.md`, content);
  return content;
}
