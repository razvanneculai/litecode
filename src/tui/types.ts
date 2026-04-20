import type { Task } from "../orchestrator/planner.js";
import type { LLMUsage } from "../llm/client.js";

export type { LLMUsage };

export type Answer = "yes" | "no" | "all" | "quit";

export type TuiEvent =
  | { type: "spinner_start"; msg: string }
  | { type: "spinner_update"; msg: string }
  | { type: "spinner_stop"; msg?: string; success: boolean }
  | { type: "message"; kind: "info" | "success" | "error" | "warn" | "thinking" | "section" | "user" | "answer"; text: string }
  | { type: "file_read"; path: string }
  | { type: "file_write"; path: string; detail?: string }
  | { type: "file_fail"; path: string; reason: string }
  | { type: "task_list"; tasks: Task[] }
  | { type: "task_start"; id: string; file: string; tokens?: number }
  | { type: "task_done"; id: string; file: string }
  | { type: "task_failed"; id: string; file: string; reason: string }
  | { type: "wave"; index: number; total: number; files: string[] }
  | { type: "diff_header"; file: string; label: "new file" | "modified" | "deleted" }
  | { type: "diff_lines"; patch: string }
  | { type: "confirm"; file: string }
  | { type: "usage"; usage: LLMUsage }
  | { type: "pipeline_done" };

export interface ChatLine {
  id: number;
  kind: "user" | "info" | "success" | "error" | "warn" | "thinking" | "section" | "task_done" | "task_failed" | "wave" | "file_write" | "file_fail" | "answer";
  text: string;
}

export interface TaskState {
  id: string;
  file: string;
  tokens?: number;
  status: "running" | "done" | "failed";
  reason?: string;
}

export interface DiffState {
  file: string;
  label: "new file" | "modified" | "deleted";
  patch: string;
  resolve: (answer: Answer) => void;
}

export interface TokenState {
  lastUsage: LLMUsage | null;
  sessionPrompt: number;
  sessionCompletion: number;
  sessionTotal: number;
  requestCount: number;
}

export interface TuiState {
  messages: ChatLine[];
  activeTasks: Map<string, TaskState>;
  spinner: string | null;
  pendingDiff: DiffState | null;
  tokens: TokenState;
  busy: boolean;
}
