import { EventEmitter } from "events";
import type { TuiEvent, TuiState, Answer, ChatLine } from "./types.js";

let lineIdSeq = 0;

function freshState(): TuiState {
  return {
    messages: [],
    activeTasks: new Map(),
    spinner: null,
    pendingDiff: null,
    tokens: {
      lastUsage: null,
      sessionPrompt: 0,
      sessionCompletion: 0,
      sessionTotal: 0,
      requestCount: 0,
    },
    busy: false,
  };
}

export class TuiStore extends EventEmitter {
  state: TuiState = freshState();
  private pendingUpdate = false;

  /**
   * Batch rapid-fire state changes into a single "update" emission per tick.
   * Synchronous bursts (e.g. 10 task_start events in one tick) collapse to one render.
   */
  scheduleEmit(): void {
    if (this.pendingUpdate) return;
    this.pendingUpdate = true;
    process.nextTick(() => {
      this.pendingUpdate = false;
      this.emit("update");
    });
  }

  private push(line: Omit<ChatLine, "id">): void {
    const entry: ChatLine = { ...line, id: lineIdSeq++ };
    this.state = { ...this.state, messages: [...this.state.messages, entry] };
  }

  dispatch(event: TuiEvent): void {
    switch (event.type) {
      case "spinner_start":
        this.state = { ...this.state, spinner: event.msg, busy: true };
        break;
      case "spinner_update":
        this.state = { ...this.state, spinner: event.msg };
        break;
      case "spinner_stop":
        this.state = { ...this.state, spinner: null };
        if (event.msg) this.push({ kind: event.success ? "success" : "error", text: event.msg });
        break;
      case "message":
        this.push({ kind: event.kind as ChatLine["kind"], text: event.text });
        break;
      case "file_write":
        this.push({ kind: "file_write", text: event.path + (event.detail ? ` (${event.detail})` : "") });
        break;
      case "file_fail":
        this.push({ kind: "file_fail", text: `${event.path} — ${event.reason}` });
        break;
      case "task_list": {
        const summary = `${event.tasks.length} task${event.tasks.length === 1 ? "" : "s"} planned`;
        this.push({ kind: "info", text: summary });
        break;
      }
      case "task_start": {
        const tasks = new Map(this.state.activeTasks);
        tasks.set(event.id, { id: event.id, file: event.file, tokens: event.tokens, status: "running" });
        this.state = { ...this.state, activeTasks: tasks };
        break;
      }
      case "task_done": {
        const tasks = new Map(this.state.activeTasks);
        tasks.delete(event.id);
        this.push({ kind: "task_done", text: `${event.id}  ${event.file}` });
        this.state = { ...this.state, activeTasks: tasks };
        break;
      }
      case "task_failed": {
        const tasks = new Map(this.state.activeTasks);
        tasks.delete(event.id);
        this.push({ kind: "task_failed", text: `${event.id}  ${event.file}  ${event.reason}` });
        this.state = { ...this.state, activeTasks: tasks };
        break;
      }
      case "wave":
        if (event.total > 1) this.push({ kind: "wave", text: `Wave ${event.index}/${event.total}  ${event.files.join("  ")}` });
        break;
      case "diff_header":
      case "diff_lines":
        // handled by DiffViewer via pendingDiff
        break;
      case "usage": {
        const u = event.usage;
        const prev = this.state.tokens;
        this.state = {
          ...this.state,
          tokens: {
            lastUsage: u,
            sessionPrompt: prev.sessionPrompt + u.promptTokens,
            sessionCompletion: prev.sessionCompletion + u.completionTokens,
            sessionTotal: prev.sessionTotal + u.totalTokens,
            requestCount: prev.requestCount + 1,
          },
        };
        break;
      }
      case "pipeline_done":
        this.state = { ...this.state, busy: false };
        break;
    }
    this.scheduleEmit();
  }

  confirmRequest(file: string, label: "new file" | "modified" | "deleted", patch: string): Promise<Answer> {
    return new Promise(resolve => {
      this.state = {
        ...this.state,
        pendingDiff: { file, label, patch, resolve },
      };
      this.scheduleEmit();
    });
  }

  resolveConfirm(answer: Answer): void {
    const diff = this.state.pendingDiff;
    if (!diff) return;
    const verb =
      answer === "yes" ? "accepted" :
      answer === "all" ? "accepted (all remaining)" :
      answer === "no" ? "skipped" : "aborted";
    const entry: ChatLine = { id: lineIdSeq++, kind: answer === "no" || answer === "quit" ? "warn" : "success", text: `${verb}: ${diff.file}` };
    this.state = {
      ...this.state,
      messages: [...this.state.messages, entry],
      pendingDiff: null,
    };
    this.scheduleEmit();
    diff.resolve(answer);
  }
}
