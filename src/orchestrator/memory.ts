import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface MemoryEntry {
  request: string;
  synthesis: string;
  files: string[];
  timestamp: string;
}

interface MemoryFile {
  recent: MemoryEntry[];
}

const MEMORY_DIR = ".litecode";
const MEMORY_FILE = "memory.json";
const MAX_ENTRIES = 2;

function memoryPath(cwd: string): { dir: string; file: string } {
  const dir = join(cwd, MEMORY_DIR);
  return { dir, file: join(dir, MEMORY_FILE) };
}

export function loadMemory(cwd: string): MemoryEntry[] {
  const { file } = memoryPath(cwd);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as MemoryFile;
    return Array.isArray(parsed.recent) ? parsed.recent.slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function appendMemory(cwd: string, entry: MemoryEntry): void {
  const { dir, file } = memoryPath(cwd);
  const existing = loadMemory(cwd);
  const next: MemoryFile = { recent: [...existing, entry].slice(-MAX_ENTRIES) };
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), "utf-8");
}

export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e, i) => {
    const shortTs = e.timestamp.replace("T", " ").slice(0, 16);
    const files = e.files.length ? e.files.join(", ") : "(none)";
    return (
      `${i + 1}. [${shortTs}] User asked: "${e.request}"\n` +
      `   You did: ${e.synthesis}\n` +
      `   Files: ${files}`
    );
  });
  return (
    "Recent actions in this project (most recent last):\n" +
    lines.join("\n") +
    '\nIf the user refers to "last time", "previous", "undo", or "revert", use this history to identify the target files and the change to reverse.'
  );
}
