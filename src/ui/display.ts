import { createInterface } from "readline";
import type { Task } from "../orchestrator/planner.js";
import type { LLMUsage } from "../llm/client.js";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const c = {
  green:   (s: string) => `\x1b[32m${s}${RESET}`,
  red:     (s: string) => `\x1b[31m${s}${RESET}`,
  yellow:  (s: string) => `\x1b[33m${s}${RESET}`,
  blue:    (s: string) => `\x1b[34m${s}${RESET}`,
  cyan:    (s: string) => `\x1b[36m${s}${RESET}`,
  magenta: (s: string) => `\x1b[35m${s}${RESET}`,
  gray:    (s: string) => `\x1b[90m${s}${RESET}`,
  bold:    (s: string) => `${BOLD}${s}${RESET}`,
  dim:     (s: string) => `${DIM}${s}${RESET}`,
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK   = c.green("✓");
const CROSS  = c.red("✗");
const DASH   = c.yellow("–");
const ARROW  = c.cyan("→");
const DOT    = c.gray("·");

// ─── Display class ────────────────────────────────────────────────────────────

export class Display {
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerIdx = 0;
  private spinnerMsg = "";
  private spinnerActive = false;

  // ── Spinner ────────────────────────────────────────────────────────────────

  startSpinner(message: string): void {
    this.spinnerMsg = message;
    if (!process.stdout.isTTY) {
      process.stdout.write(`  ${message}\n`);
      return;
    }
    this.spinnerActive = true;
    this._renderSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
      this._renderSpinner();
    }, 80);
  }

  updateSpinner(message: string): void {
    this.spinnerMsg = message;
    if (process.stdout.isTTY) this._renderSpinner();
  }

  stopSpinner(finalMessage?: string, success = true): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (!process.stdout.isTTY) {
      if (finalMessage) process.stdout.write(`  ${success ? "✓" : "✗"} ${finalMessage}\n`);
      return;
    }
    this.spinnerActive = false;
    // Clear spinner line
    process.stdout.write(`\r${ESC}2K`);
    if (finalMessage) {
      const icon = success ? TICK : CROSS;
      process.stdout.write(`  ${icon} ${finalMessage}\n`);
    }
  }

  private _renderSpinner(): void {
    const frame = c.cyan(SPINNER_FRAMES[this.spinnerIdx]);
    const line = `  ${frame} ${this.spinnerMsg}`;
    process.stdout.write(`\r${ESC}2K${line}`);
  }

  // ── Clear current line (call before printing static output while spinner is on) ──

  private _clearLine(): void {
    if (process.stdout.isTTY && this.spinnerActive) {
      process.stdout.write(`\r${ESC}2K`);
    }
  }

  // ── Static output helpers ──────────────────────────────────────────────────

  /** Section header — bold underlined title */
  section(title: string): void {
    this._clearLine();
    process.stdout.write(`\n${c.bold(title)}\n`);
  }

  /** Neutral info line */
  info(msg: string): void {
    this._clearLine();
    process.stdout.write(`  ${DOT} ${msg}\n`);
  }

  /** Success line */
  success(msg: string): void {
    this._clearLine();
    process.stdout.write(`  ${TICK} ${msg}\n`);
  }

  /** Error line */
  error(msg: string): void {
    this._clearLine();
    process.stdout.write(`  ${CROSS} ${c.red(msg)}\n`);
  }

  /** Warning line */
  warn(msg: string): void {
    this._clearLine();
    process.stdout.write(`  ${DASH} ${c.yellow(msg)}\n`);
  }

  /** File being read */
  fileRead(path: string): void {
    this._clearLine();
    process.stdout.write(`  ${c.gray("Read")}  ${c.dim(path)}\n`);
  }

  /** File being written */
  fileWrite(path: string, detail?: string): void {
    this._clearLine();
    const suffix = detail ? c.gray(` (${detail})`) : "";
    process.stdout.write(`  ${TICK} ${c.green("Write")} ${path}${suffix}\n`);
  }

  /** File write failed */
  fileFail(path: string, reason: string): void {
    this._clearLine();
    process.stdout.write(`  ${CROSS} ${c.red("Fail")}  ${path} ${c.gray("—")} ${c.red(reason)}\n`);
  }

  // ── "Thinking" display — what the LLM is currently doing ──────────────────

  /**
   * Show a step inside a longer operation while the spinner is running.
   * Renders above the spinner on TTY; on non-TTY just prints.
   */
  thinking(step: string): void {
    if (!process.stdout.isTTY) {
      process.stdout.write(`  ${c.cyan("·")} ${step}\n`);
      return;
    }
    this._clearLine();
    process.stdout.write(`  ${c.cyan("·")} ${c.dim(step)}\n`);
    // Re-render spinner on next line
    if (this.spinnerActive) this._renderSpinner();
  }

  // ── Task list display ──────────────────────────────────────────────────────

  taskList(tasks: Task[]): void {
    this._clearLine();
    process.stdout.write(`\n  ${c.bold(`${tasks.length} task${tasks.length === 1 ? "" : "s"} planned`)}\n\n`);

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const isLast = i === tasks.length - 1;
      const prefix = isLast ? "  └─" : "  ├─";
      const connector = isLast ? "    " : "  │ ";

      const idPart    = c.cyan(t.id);
      const filePart  = c.bold(t.file);
      const depPart   = t.depends_on.length
        ? c.gray(`  [after: ${t.depends_on.join(", ")}]`)
        : "";
      const secPart   = t.load_sections
        ? c.gray(`  lines ${t.load_sections.start}–${t.load_sections.end}`)
        : "";

      process.stdout.write(`${c.gray(prefix)} ${idPart}  ${filePart}${depPart}${secPart}\n`);
      process.stdout.write(`${c.gray(connector)}  ${c.dim(t.action)}\n`);

      if (t.needs_context_from.length) {
        process.stdout.write(`${c.gray(connector)}  ${c.gray("refs: " + t.needs_context_from.join(", "))}\n`);
      }
    }
    process.stdout.write("\n");
  }

  // ── Task execution status ─────────────────────────────────────────────────

  taskStart(taskId: string, file: string, tokens?: number): void {
    const tokenStr = tokens != null ? c.gray(` ${tokens} tok`) : "";
    this.updateSpinner(`${c.cyan(taskId)}  ${file}${tokenStr}`);
  }

  taskDone(taskId: string, file: string): void {
    this._clearLine();
    process.stdout.write(`  ${TICK} ${c.cyan(taskId)}  ${file}\n`);
    if (this.spinnerActive) this._renderSpinner();
  }

  taskFailed(taskId: string, file: string, reason: string): void {
    this._clearLine();
    process.stdout.write(`  ${CROSS} ${c.cyan(taskId)}  ${file}  ${c.red(reason)}\n`);
    if (this.spinnerActive) this._renderSpinner();
  }

  // ── Wave header ───────────────────────────────────────────────────────────

  wave(index: number, total: number, files: string[]): void {
    this._clearLine();
    if (total > 1) {
      process.stdout.write(
        `  ${c.gray(`Wave ${index}/${total}`)}  ${files.map(f => c.dim(f)).join(c.gray("  "))}\n`
      );
    }
  }

  // ── Map tree display ──────────────────────────────────────────────────────

  mapFile(filePath: string, projectRoot: string): void {
    const rel = filePath.replace(projectRoot, "").replace(/\\/g, "/").replace(/^\//, "");
    const depth = rel.split("/").length - 1;
    const indent = "  ".repeat(depth);
    const isRoot = depth === 0;
    const icon = isRoot ? c.cyan("◆") : c.gray("·");
    process.stdout.write(`  ${indent}${icon} ${c.dim(rel)}\n`);
  }

  // ── Token budget line ─────────────────────────────────────────────────────

  budget(totalTokens: number, limit: number): void {
    const pct = Math.round((totalTokens / limit) * 100);
    const bar = buildBar(pct, 20);
    this._clearLine();
    process.stdout.write(
      `  ${c.gray("tokens")} ${bar} ${c.cyan(String(totalTokens))}${c.gray(`/${limit} (${pct}%)`)}\n`
    );
  }

  // ── Banner ────────────────────────────────────────────────────────────────

  banner(model?: string, baseURL?: string): void {
    const art = [
      "██╗     ██╗████████╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗",
      "██║     ██║╚══██╔══╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
      "██║     ██║   ██║   █████╗  ██║     ██║   ██║██║  ██║█████╗  ",
      "██║     ██║   ██║   ██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝  ",
      "███████╗██║   ██║   ███████╗╚██████╗╚██████╔╝██████╔╝███████╗",
      "╚══════╝╚═╝   ╚═╝   ╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝╚══════╝",
    ];
    const colors = [
      "\x1b[2;36m", // dim cyan
      "\x1b[2;36m",
      "\x1b[36m",   // cyan
      "\x1b[36m",
      "\x1b[1;96m", // bold bright cyan
      "\x1b[1;96m",
    ];
    process.stdout.write("\n");
    for (let i = 0; i < art.length; i++) {
      process.stdout.write(`  ${colors[i]}${art[i]}\x1b[0m\n`);
    }
    process.stdout.write(`\n  \x1b[2mAI Coding Agent · Small Context LLMs\x1b[0m\n`);

    if (model) {
      const host = baseURL
        ? baseURL.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
        : "";
      const hostStr = host ? `\x1b[2m${host}\x1b[0m  ` : "";
      process.stdout.write(`  \x1b[32m●\x1b[0m  ${hostStr}\x1b[96m${model}\x1b[0m\n`);
    } else {
      process.stdout.write(`  \x1b[33m●\x1b[0m  \x1b[2mNo model configured — type \x1b[0m\x1b[33m/connect\x1b[0m\x1b[2m to get started\x1b[0m\n`);
    }
    process.stdout.write("\n");
  }

  // ── Diff display ──────────────────────────────────────────────────────────

  diffHeader(filePath: string, label: "new file" | "modified" | "deleted"): void {
    this._clearLine();
    const labelColor = label === "new file" ? c.green : label === "deleted" ? c.red : c.yellow;
    const width = Math.max(0, 60 - filePath.length - label.length - 4);
    const line = "─".repeat(width);
    process.stdout.write(`\n  ${c.bold(filePath)}  ${labelColor(label)} ${c.gray(line)}\n`);
  }

  diffLines(patch: string): void {
    this._clearLine();
    const lines = patch.split("\n");
    // Skip the first two header lines (--- and +++) and last empty line
    for (const line of lines.slice(2)) {
      if (line.startsWith("@@")) {
        process.stdout.write(`  ${c.cyan(line)}\n`);
      } else if (line.startsWith("+")) {
        process.stdout.write(`  ${c.green(line)}\n`);
      } else if (line.startsWith("-")) {
        process.stdout.write(`  ${c.red(line)}\n`);
      } else if (line.trim()) {
        process.stdout.write(`  ${c.dim(line)}\n`);
      }
    }
  }

  async confirm(filePath: string): Promise<"yes" | "no" | "all" | "quit"> {
    if (!process.stdout.isTTY) return "yes";
    this._clearLine();
    process.stdout.write(`\n  ${c.bold(filePath)} — apply? ${c.green("[y]es")} ${c.red("[n]o")} ${c.cyan("[a]ll")} ${c.yellow("[q]uit")} : `);
    return new Promise(resolve => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.once("line", line => {
        rl.close();
        const answer = line.trim().toLowerCase();
        if (answer === "y" || answer === "yes") resolve("yes");
        else if (answer === "a" || answer === "all") resolve("all");
        else if (answer === "q" || answer === "quit") resolve("quit");
        else resolve("no");
      });
    });
  }

  // ── Token usage hook (overridden by TuiDisplay) ───────────────────────────

  onUsage?(_usage: LLMUsage): void { /* no-op in ANSI mode */ }

  // ── Blank line ────────────────────────────────────────────────────────────

  blank(): void {
    this._clearLine();
    process.stdout.write("\n");
  }
}

function buildBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct > 85 ? c.red : pct > 60 ? c.yellow : c.green;
  return c.gray("[") + color("█".repeat(filled)) + c.gray("░".repeat(empty)) + c.gray("]");
}
