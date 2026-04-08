import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, relative, extname, basename } from "path";
import type { Config } from "../config/config.js";
import { analyzeFile, analyzeFolder, buildRootMap } from "./analyzer.js";

export const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  ".litecode",
  "__pycache__",
  ".next",
  ".nuxt",
  "build",
  "coverage",
  ".cache",
]);

const IGNORED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz",
  ".lock", ".map",
]);

// Only these extensions get LLM analysis in deep mode (skip JSON, MD, config, etc.)
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".swift", ".kt", ".cs", ".sh", ".bash",
]);

// Files we skip even in deep mode (context/analysis files themselves)
const IGNORED_NAMES = new Set([
  "project_context.md",
  "folder_context.md",
  "folder_analysis.md",
]);

function shouldIgnore(name: string): boolean {
  if (IGNORED.has(name)) return true;
  if (name.startsWith(".") && name !== ".env.example") return true;
  return false;
}

// ─── Tech stack detection ─────────────────────────────────────────────────────

function detectTechStack(projectRoot: string): string[] {
  const stack: string[] = [];
  if (existsSync(join(projectRoot, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["typescript"] || deps["ts-node"] || deps["tsx"]) stack.push("TypeScript");
      else stack.push("Node.js");
      if (deps["react"]) stack.push("React");
      if (deps["next"]) stack.push("Next.js");
      if (deps["vue"]) stack.push("Vue");
      if (deps["express"]) stack.push("Express");
    } catch {
      stack.push("Node.js");
    }
  }
  if (existsSync(join(projectRoot, "requirements.txt")) || existsSync(join(projectRoot, "pyproject.toml"))) stack.push("Python");
  if (existsSync(join(projectRoot, "go.mod"))) stack.push("Go");
  if (existsSync(join(projectRoot, "Cargo.toml"))) stack.push("Rust");
  const csharpFiles = readdirSync(projectRoot).filter(f => f.endsWith(".csproj"));
  if (csharpFiles.length > 0) stack.push("C#");
  return stack;
}

// ─── Fast (pattern-matching) mode ─────────────────────────────────────────────

function getFirstLines(filePath: string, n = 5): string {
  try {
    return readFileSync(filePath, "utf-8").split("\n").slice(0, n).join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function describeFile(filePath: string): string {
  const name = basename(filePath);
  const ext = extname(name);
  const firstLines = getFirstLines(filePath);

  if (name === "package.json") return "Node.js package manifest";
  if (name === "tsconfig.json") return "TypeScript compiler configuration";
  if (name === "litecode.json") return "LiteCode agent configuration";
  if (name.includes("test") || name.includes("spec")) return `Test file for ${name.replace(/\.(test|spec)\.[^.]+$/, "")}`;
  if (name === "index.ts" || name === "index.js") return "Module entry point";
  if (name.endsWith(".md")) return `Markdown document: ${name.replace(".md", "")}`;

  const commentMatch = firstLines.match(/^(?:\/\/|#|\/\*)\s*(.+)/);
  if (commentMatch) return commentMatch[1].slice(0, 80);

  const extDescriptions: Record<string, string> = {
    ".ts": "TypeScript module",
    ".js": "JavaScript module",
    ".py": "Python module",
    ".go": "Go source file",
    ".rs": "Rust source file",
    ".json": "JSON data file",
    ".yaml": "YAML configuration",
    ".yml": "YAML configuration",
    ".env": "Environment variables",
    ".sh": "Shell script",
  };
  return extDescriptions[ext] ?? `${ext || "file"}: ${name}`;
}

// Extract imports and exports from source files so stubs are actually useful.
function extractFileSignature(filePath: string): string {
  const ext = extname(filePath);
  if (![".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) return "";
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); } catch { return ""; }

  const parts: string[] = [];

  // CommonJS requires — local paths only (skip node_modules for brevity)
  const requires = [...content.matchAll(/require\(['"]([^'"]+)['"]\)/g)]
    .map(m => m[1]);
  if (requires.length) parts.push(`Imports: ${requires.join(", ")}`);

  // ESM imports
  const esmImports = [...content.matchAll(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm)]
    .map(m => m[1]);
  if (esmImports.length) parts.push(`Imports: ${esmImports.join(", ")}`);

  // module.exports = { a, b, c }
  const cjsExports = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (cjsExports) {
    const names = cjsExports[1].split(",")
      .map(s => s.trim().split(/\s*:/)[0].trim())
      .filter(Boolean);
    if (names.length) parts.push(`Exports: ${names.join(", ")}`);
  }

  // named ESM exports
  const esmExported = [...content.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/gm)]
    .map(m => m[1]);
  if (esmExported.length) parts.push(`Exports: ${esmExported.join(", ")}`);

  // top-level function declarations
  const fns = [...content.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)].map(m => m[1]);
  if (fns.length) parts.push(`Functions: ${fns.join(", ")}`);

  return parts.join("\n");
}

export async function generateProjectContext(projectRoot: string): Promise<string> {
  const stack = detectTechStack(projectRoot);
  const entries = readdirSync(projectRoot, { withFileTypes: true });

  const topLevelFiles: string[] = [];
  const topLevelDirs: string[] = [];

  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    if (entry.isDirectory()) topLevelDirs.push(entry.name);
    else if (!IGNORED_EXTS.has(extname(entry.name))) topLevelFiles.push(entry.name);
  }

  const lines: string[] = [
    `# Project Context`,
    ``,
    `**Tech stack:** ${stack.length > 0 ? stack.join(", ") : "Unknown"}`,
    `**Root:** ${projectRoot}`,
    ``,
    `## Top-level folders`,
  ];

  // Walk up to 6 levels deep and list all source files with relative paths
  const collectSourceFiles = (dir: string, depth: number): string[] => {
    if (depth > 6) return [];
    let entries: import("fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import("fs").Dirent[]; } catch { return []; }
    const result: string[] = [];
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!IGNORED_EXTS.has(ext) && !entry.name.endsWith(".md") && !entry.name.endsWith(".lock") && !entry.name.endsWith(".json")) {
          result.push(join(dir, entry.name).replace(projectRoot, "").replace(/\\/g, "/").replace(/^\//, ""));
        }
      } else if (entry.isDirectory()) {
        result.push(...collectSourceFiles(join(dir, entry.name), depth + 1));
      }
    }
    return result;
  };

  for (const dir of topLevelDirs.sort()) {
    const dirPath = join(projectRoot, dir);
    const sourceFiles = collectSourceFiles(dirPath, 1);
    if (sourceFiles.length > 0) {
      lines.push(`- \`${dir}/\``);
      for (const f of sourceFiles.slice(0, 30)) {
        lines.push(`  - \`${f}\``);
      }
      if (sourceFiles.length > 30) lines.push(`  - … and ${sourceFiles.length - 30} more`);
    } else {
      lines.push(`- \`${dir}/\` — (no source files)`);
    }
  }

  // Show all meaningful root-level files (source, config, markup, docs)
  const LOCK_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock"]);
  const rootSourceFiles = topLevelFiles.filter(f => {
    if (LOCK_FILES.has(f)) return false;
    const ext = extname(f);
    return SOURCE_EXTS.has(ext) || [".mjs", ".cjs", ".css", ".html", ".json", ".md", ".yaml", ".yml", ".toml", ".env"].includes(ext);
  });
  if (rootSourceFiles.length > 0) {
    lines.push(``, `## Root files`);
    for (const f of rootSourceFiles.sort()) {
      lines.push(`- \`${f}\` — ${describeFile(join(projectRoot, f))}`);
    }
  }

  return lines.join("\n");
}

export async function generateFolderContext(folderPath: string): Promise<string> {
  const entries = readdirSync(folderPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    if (entry.isFile() && !IGNORED_EXTS.has(extname(entry.name))) {
      files.push(entry.name);
    }
  }

  const lines: string[] = [`# Folder: ${folderPath}`, ``];

  if (files.length === 0) {
    lines.push("_No source files._");
    return lines.join("\n");
  }

  lines.push(`## Files`);
  for (const name of files.sort()) {
    const desc = describeFile(join(folderPath, name));
    lines.push(`- \`${name}\` — ${desc}`);
  }

  return lines.join("\n");
}

// Fast mode: pattern-matching only, no LLM calls.
export async function initContextMaps(
  projectRoot: string,
  onFile?: (filePath: string) => void
): Promise<string[]> {
  const written: string[] = [];

  const projectCtx = await generateProjectContext(projectRoot);
  const projectCtxPath = join(projectRoot, "project_context.md");
  writeFileSync(projectCtxPath, projectCtx, "utf-8");
  written.push(projectCtxPath);
  onFile?.(projectCtxPath);

  const recurse = async (dir: string) => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import("fs").Dirent[];
    } catch {
      return;
    }

    const hasSourceFiles = entries.some(
      e => e.isFile() && !shouldIgnore(e.name) && !IGNORED_EXTS.has(extname(e.name))
    );

    if (hasSourceFiles || dir !== projectRoot) {
      const folderCtx = await generateFolderContext(dir);
      const folderCtxPath = join(dir, "folder_context.md");
      writeFileSync(folderCtxPath, folderCtx, "utf-8");
      written.push(folderCtxPath);
      onFile?.(folderCtxPath);
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !shouldIgnore(entry.name)) {
        await recurse(join(dir, entry.name));
      }
    }
  };

  const topEntries = readdirSync(projectRoot, { withFileTypes: true }) as import("fs").Dirent[];
  for (const entry of topEntries) {
    if (entry.isDirectory() && !shouldIgnore(entry.name)) {
      await recurse(join(projectRoot, entry.name));
    }
  }

  return written;
}

// ─── Deep mode: bottom-up LLM-powered analysis ───────────────────────────────

interface FileEntry {
  absPath: string;
  folder: string;
  name: string;
}

// Walk tree and collect all source files, grouped by folder.
function collectFiles(root: string): Map<string, FileEntry[]> {
  const byFolder = new Map<string, FileEntry[]>();

  const walk = (dir: string) => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import("fs").Dirent[];
    } catch {
      return;
    }

    const fileEntries: FileEntry[] = [];
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!SOURCE_EXTS.has(ext)) continue;   // only analyze actual source files
        if (IGNORED_NAMES.has(entry.name)) continue;
        if (entry.name.endsWith(".file_analysis.md")) continue;
        fileEntries.push({ absPath: join(dir, entry.name), folder: dir, name: entry.name });
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      }
    }

    if (fileEntries.length > 0) {
      byFolder.set(dir, fileEntries);
    }
  };

  walk(root);
  return byFolder;
}

// Sort folders deepest-first (most path separators first).
function sortDeepestFirst(folders: string[]): string[] {
  return [...folders].sort((a, b) => {
    const depthA = a.split(/[\\/]/).length;
    const depthB = b.split(/[\\/]/).length;
    return depthB - depthA;
  });
}

const ANALYSIS_LINE_THRESHOLD = 150;

// Deep init: analyze every file with LLM, build folder analyses bottom-up, then root map.
export async function deepInit(
  projectRoot: string,
  config: Config,
  onFile?: (filePath: string) => void,
  verbose = false
): Promise<string[]> {
  const written: string[] = [];
  const techStack = detectTechStack(projectRoot).join(", ") || "Unknown";

  // Collect all source files grouped by folder
  const byFolder = collectFiles(projectRoot);
  const folders = sortDeepestFirst([...byFolder.keys()]);

  // Phase 1: analyze every file (LLM call per file)
  const folderAnalysisInputs = new Map<string, { name: string; analysisPath: string }[]>();
  const rateLimitDelay = config.rateLimitDelayMs ?? 5000;

  for (const folder of folders) {
    const files = byFolder.get(folder) ?? [];
    const inputs: { name: string; analysisPath: string }[] = [];

    for (const file of files) {
      const expectedAnalysisPath = join(file.folder, file.name + ".file_analysis.md");
      if (existsSync(expectedAnalysisPath)) {
        // Already analyzed — skip to avoid redundant LLM calls on resume
        inputs.push({ name: file.name, analysisPath: expectedAnalysisPath });
        onFile?.(expectedAnalysisPath);
        continue;
      }

      // Skip LLM analysis for small files — write a lightweight stub instead
      let lineCount = 0;
      try { lineCount = readFileSync(file.absPath, "utf-8").split("\n").length; } catch { /* ignore */ }
      if (lineCount <= ANALYSIS_LINE_THRESHOLD) {
        const desc = describeFile(file.absPath);
        const sig = extractFileSignature(file.absPath);
        const stub = sig
          ? `# ${file.name} (${lineCount} lines)\n${desc}\n${sig}\n`
          : `# ${file.name} (${lineCount} lines)\n${desc}\n`;
        writeFileSync(expectedAnalysisPath, stub, "utf-8");
        written.push(expectedAnalysisPath);
        onFile?.(expectedAnalysisPath);
        inputs.push({ name: file.name, analysisPath: expectedAnalysisPath });
        continue;
      }

      try {
        const analysisPath = await analyzeFile(file.absPath, config, verbose);
        written.push(analysisPath);
        onFile?.(analysisPath);
        inputs.push({ name: file.name, analysisPath });
      } catch (err) {
        process.stderr.write(`[deepInit] Skipping ${file.name}: ${(err as Error).message}\n`);
      }
      await new Promise(r => setTimeout(r, rateLimitDelay));
    }

    folderAnalysisInputs.set(folder, inputs);
  }

  // Phase 2: build folder_analysis.md for each folder (deepest first)
  const rootFolderInputs: { name: string; analysisPath: string }[] = [];

  for (const folder of folders) {
    // Skip the project root itself — it has no parent folder to feed into
    const relFolder = relative(projectRoot, folder).replace(/\\/g, "/");
    if (!relFolder) continue;

    const inputs = folderAnalysisInputs.get(folder) ?? [];
    const expectedFolderAnalysis = join(folder, "folder_analysis.md");
    let analysisPath: string | undefined;
    if (existsSync(expectedFolderAnalysis)) {
      analysisPath = expectedFolderAnalysis;
      onFile?.(analysisPath);
    } else {
      try {
        analysisPath = await analyzeFolder(folder, inputs, projectRoot, config, verbose);
        written.push(analysisPath);
        onFile?.(analysisPath);
      } catch (err) {
        process.stderr.write(`[deepInit] Skipping folder analysis for ${folder}: ${(err as Error).message}\n`);
      }
      await new Promise(r => setTimeout(r, rateLimitDelay));
    }

    // Only top-level folders feed into the root map (skip nested ones)
    if (!relFolder.includes("/") && analysisPath) {
      rootFolderInputs.push({ name: relFolder, analysisPath });
    }
  }

  // Phase 3: build project_context.md at root
  const rootMapPath = await buildRootMap(projectRoot, techStack, rootFolderInputs, config, verbose);
  written.push(rootMapPath);
  onFile?.(rootMapPath);

  return written;
}
