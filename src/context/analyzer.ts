import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, relative } from "path";
import type { Config } from "../config/config.js";
import type { Message } from "../llm/client.js";
import { callLLM } from "../llm/client.js";
import {
  buildFileAnalysisPrompt,
  buildFolderDescriptionPrompt,
} from "../llm/prompts.js";

const CHUNK_SIZE = 120; // lines per chunk for large-file analysis

const CHUNKED_SYSTEM_PROMPT =
  "You are a code analyzer. Output ONLY a structured markdown analysis. " +
  "For each section state the line range, what it does in one sentence, " +
  "what it imports/calls, and what calls it. No other commentary.";

function buildChunkPrompt(
  fileName: string,
  totalLines: number,
  chunk: string,
  startLine: number,
  endLine: number
): Message[] {
  return [
    { role: "system", content: CHUNKED_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `File: ${fileName} (${totalLines} lines total)\n` +
        `Analyze lines ${startLine}-${endLine}:\n\n` +
        chunk,
    },
  ];
}

// Analyze any file (not just large ones) using the structured line-range prompt.
// For files >CHUNK_SIZE lines, splits into chunks and merges results.
export async function analyzeFile(
  filePath: string,
  config: Config,
  verbose = false
): Promise<string> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  const fileName = basename(filePath);

  if (verbose) {
    process.stderr.write(
      `[Analyzer] ${fileName} (${totalLines} lines)\n`
    );
  }

  let fullAnalysis: string;

  if (totalLines <= CHUNK_SIZE) {
    // Small file — one structured analysis call
    const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
    const messages = buildFileAnalysisPrompt(filePath, numbered);
    fullAnalysis = (await callLLM(messages, config, verbose)).content;
  } else {
    // Large file — chunk it and merge
    const chunks: string[] = [`# ${fileName} (${totalLines} lines)\n`];
    for (let start = 0; start < totalLines; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, totalLines - 1);
      const chunkLines = lines.slice(start, end + 1);
      const chunkText = chunkLines.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
      const messages = buildChunkPrompt(fileName, totalLines, chunkText, start + 1, end + 1);
      if (verbose) {
        process.stderr.write(`[Analyzer] chunk lines ${start + 1}-${end + 1}\n`);
      }
      const result = await callLLM(messages, config, verbose);
      chunks.push(result.content);
    }
    fullAnalysis = chunks.join("\n\n");
  }

  const analysisPath = join(dirname(filePath), `${fileName}.file_analysis.md`);
  writeFileSync(analysisPath, fullAnalysis, "utf-8");

  if (verbose) {
    process.stderr.write(`[Analyzer] → ${analysisPath}\n`);
  }

  return analysisPath;
}

// Extract the first meaningful line from an analysis file as a short summary.
function extractSummary(analysisContent: string): string {
  const lines = analysisContent.split("\n");
  // Second non-empty line after the # heading is typically the one-sentence description
  let passedHeading = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) { passedHeading = true; continue; }
    if (passedHeading) return trimmed.slice(0, 120);
  }
  return "";
}

// Build folder_analysis.md for a given folder.
// Uses one LLM call for a one-sentence folder description, then builds the rest as a template.
export async function analyzeFolder(
  folderPath: string,
  fileAnalysisPaths: { name: string; analysisPath: string }[],
  projectRoot: string,
  config: Config,
  verbose = false
): Promise<string> {
  const folderName = relative(projectRoot, folderPath).replace(/\\/g, "/") || basename(folderPath);

  // Build per-file entries from their analysis files
  const fileEntries: Array<{ name: string; relPath: string; summary: string; lineCount: number }> = [];
  const summaryLines: string[] = [];

  for (const f of fileAnalysisPaths) {
    let summary = "(no analysis)";
    let lineCount = 0;
    try {
      const content = readFileSync(f.analysisPath, "utf-8");
      summary = extractSummary(content);
      const match = content.match(/\((\d+) lines?\)/);
      if (match) lineCount = parseInt(match[1], 10);
    } catch {
      // keep defaults
    }
    const relPath = relative(projectRoot, f.analysisPath).replace(/\\/g, "/");
    fileEntries.push({ name: f.name, relPath, summary, lineCount });
    summaryLines.push(`${f.name}: ${summary}`);
  }

  // One focused LLM call: single sentence describing what this folder does
  let folderDescription = "";
  if (summaryLines.length > 0) {
    const messages = buildFolderDescriptionPrompt(folderName, summaryLines.join("\n"));
    if (verbose) process.stderr.write(`[Analyzer] folder description: ${folderName}\n`);
    try {
      const raw = (await callLLM(messages, config, verbose)).content;
      // Take first line, strip any markdown syntax the model sneaks in
      folderDescription = raw.split("\n")[0].replace(/^[#*\->]+\s*/, "").trim();
    } catch {
      folderDescription = fileEntries.map(e => e.name).join(", ");
    }
  }

  // Build the markdown template — no LLM guessing at structure
  const lines: string[] = [
    `# ${folderName}/ folder`,
    folderDescription,
    ``,
    `## Files`,
  ];

  for (const e of fileEntries) {
    const lineInfo = e.lineCount ? ` (${e.lineCount} lines)` : "";
    lines.push(`- [${e.name} → ${e.relPath}] ${e.summary}${lineInfo}`);
  }

  lines.push(``, `## Navigation`);
  for (const e of fileEntries) {
    lines.push(`- Edit ${e.name} → ${e.name}`);
  }

  const result = lines.join("\n");
  const outputPath = join(folderPath, "folder_analysis.md");
  writeFileSync(outputPath, result, "utf-8");

  if (verbose) process.stderr.write(`[Analyzer] → ${outputPath}\n`);
  return outputPath;
}

const ROOT_FILE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".swift", ".kt", ".cs", ".sh", ".bash",
  ".html", ".css", ".json", ".yaml", ".yml", ".toml", ".md", ".env",
]);

const ROOT_IGNORED_NAMES = new Set([
  "project_context.md", "folder_context.md", "folder_analysis.md",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
]);

const ROOT_IGNORED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".lock", ".map",
]);

function describeRootFile(name: string): string {
  const ext = extname(name);
  if (name === "index.html") return "Root HTML entry point";
  if (name === "README.md") return "Project documentation";
  if (name === "package.json") return "Node.js package manifest";
  if (name === "tsconfig.json") return "TypeScript compiler config";
  if (name === "litecode.json") return "LiteCode agent config";
  if (name === "Cargo.toml") return "Rust package manifest";
  if (name === "go.mod") return "Go module definition";
  if (name === "pyproject.toml" || name === "requirements.txt") return "Python package config";
  if (name.endsWith(".md")) return `Markdown document`;
  if (name.endsWith(".html")) return `HTML file`;
  if (name.endsWith(".json")) return `JSON config`;
  if (ext === ".env") return "Environment variables";
  return name;
}

// Build project_context.md at the project root from all folder analyses.
// Pure template — no LLM call. Folder descriptions come from extractSummary on each folder_analysis.md.
export async function buildRootMap(
  projectRoot: string,
  techStack: string,
  folderAnalysisPaths: { name: string; analysisPath: string }[],
  _config: Config,
  verbose = false
): Promise<string> {
  const { readdirSync } = await import("fs");
  const projectName = basename(projectRoot);

  const lines: string[] = [
    `# ${projectName}`,
    ``,
    `## Stack`,
    techStack,
    ``,
    `## Folders`,
  ];

  for (const f of folderAnalysisPaths) {
    let description = "";
    try {
      const content = readFileSync(f.analysisPath, "utf-8");
      description = extractSummary(content);
    } catch {
      description = "(no analysis)";
    }
    const relPath = relative(projectRoot, f.analysisPath).replace(/\\/g, "/");
    lines.push(`- [${f.name}/ → ${relPath}] ${description}`);
  }

  // Collect and list root-level files
  let rootEntries: import("fs").Dirent[] = [];
  try { rootEntries = readdirSync(projectRoot, { withFileTypes: true }) as import("fs").Dirent[]; } catch { /* ignore */ }
  const rootFiles = rootEntries
    .filter(e => e.isFile())
    .map(e => e.name)
    .filter(name => {
      if (ROOT_IGNORED_NAMES.has(name)) return false;
      if (name.startsWith(".") && name !== ".env.example") return false;
      const ext = extname(name);
      return ROOT_FILE_EXTS.has(ext) && !ROOT_IGNORED_EXTS.has(ext);
    })
    .sort();

  if (rootFiles.length > 0) {
    lines.push(``, `## Root files`);
    for (const name of rootFiles) {
      lines.push(`- \`${name}\` — ${describeRootFile(name)}`);
    }
  }

  // Detect entry point — check common locations (web-first, then Node/TS)
  const candidates = [
    "index.html",
    "src/cli/index.ts", "src/index.ts", "src/main.ts", "src/app.ts",
    "index.ts", "main.ts", "app.ts",
    "src/cli/index.js", "src/index.js", "src/main.js", "src/app.js",
    "index.js", "main.js", "app.js",
    "main.py", "app.py", "main.go",
  ];
  const entryPoint = candidates.find(c => existsSync(join(projectRoot, c)));

  lines.push(``, `## Navigation`);
  if (entryPoint) lines.push(`- Entry point: ${entryPoint}`);
  for (const f of folderAnalysisPaths) {
    lines.push(`- ${f.name} → ${f.name}/`);
  }

  const result = lines.join("\n");
  const outputPath = join(projectRoot, "project_context.md");
  writeFileSync(outputPath, result, "utf-8");

  if (verbose) process.stderr.write(`[Analyzer] → ${outputPath}\n`);
  return outputPath;
}
