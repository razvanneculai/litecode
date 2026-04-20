import type { Task } from "../orchestrator/planner.js";
import type { LLMUsage } from "../llm/client.js";
import type { TuiStore } from "./store.js";

export class TuiDisplay {
  private _pendingLabel: "new file" | "modified" | "deleted" = "modified";
  private _pendingPatch = "";

  constructor(private store: TuiStore) {}

  startSpinner(message: string): void {
    this.store.dispatch({ type: "spinner_start", msg: message });
  }

  updateSpinner(message: string): void {
    this.store.dispatch({ type: "spinner_update", msg: message });
  }

  stopSpinner(finalMessage?: string, success = true): void {
    this.store.dispatch({ type: "spinner_stop", msg: finalMessage, success });
  }

  section(title: string): void {
    this.store.dispatch({ type: "message", kind: "section", text: title });
  }

  info(msg: string): void {
    this.store.dispatch({ type: "message", kind: "info", text: msg });
  }

  success(msg: string): void {
    this.store.dispatch({ type: "message", kind: "success", text: msg });
  }

  error(msg: string): void {
    this.store.dispatch({ type: "message", kind: "error", text: msg });
  }

  warn(msg: string): void {
    this.store.dispatch({ type: "message", kind: "warn", text: msg });
  }

  thinking(step: string): void {
    this.store.dispatch({ type: "message", kind: "thinking", text: step });
  }

  fileRead(_path: string): void {
    // omit in TUI — too noisy
  }

  fileWrite(path: string, detail?: string): void {
    this.store.dispatch({ type: "file_write", path, detail });
  }

  fileFail(path: string, reason: string): void {
    this.store.dispatch({ type: "file_fail", path, reason });
  }

  taskList(tasks: Task[]): void {
    this.store.dispatch({ type: "task_list", tasks });
  }

  taskStart(taskId: string, file: string, tokens?: number): void {
    this.store.dispatch({ type: "task_start", id: taskId, file, tokens });
  }

  taskDone(taskId: string, file: string): void {
    this.store.dispatch({ type: "task_done", id: taskId, file });
  }

  taskFailed(taskId: string, file: string, reason: string): void {
    this.store.dispatch({ type: "task_failed", id: taskId, file, reason });
  }

  wave(index: number, total: number, files: string[]): void {
    this.store.dispatch({ type: "wave", index, total, files });
  }

  mapFile(_filePath: string, _projectRoot: string): void {
    // not used in interactive pipeline
  }

  budget(_totalTokens: number, _limit: number): void {
    // sidebar handles budget display
  }

  banner(_model?: string, _baseURL?: string): void {
    // banner shown by App directly
  }

  diffHeader(filePath: string, label: "new file" | "modified" | "deleted"): void {
    this._pendingLabel = label;
    this._pendingPatch = "";
  }

  diffLines(patch: string): void {
    this._pendingPatch = patch;
  }

  async confirm(filePath: string): Promise<"yes" | "no" | "all" | "quit"> {
    return this.store.confirmRequest(filePath, this._pendingLabel, this._pendingPatch);
  }

  blank(): void {
    // no-op in TUI
  }

  onUsage(usage: LLMUsage): void {
    this.store.dispatch({ type: "usage", usage });
  }
}
