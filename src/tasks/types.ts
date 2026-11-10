export type TaskStatus =
  | "planned"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** A request the control plane places on a running task; consumed by the loop. */
export type TaskControl = "pause" | "cancel";

export type OperationKind =
  | "info"
  | "status"
  | "model"
  | "tool_call"
  | "tool_result"
  | "human"
  | "error";

/** One line in a task's operation log — the audit trail of what the agent did. */
export interface OperationRecord {
  id: string;
  at: string; // ISO timestamp
  kind: OperationKind;
  message: string;
  data?: unknown;
}

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  /** Set when this task was spawned as a subagent of another task. */
  parentId?: string;
  control?: TaskControl;
  createdAt: string;
  updatedAt: string;
  /** Number of agent iterations executed so far. */
  steps: number;
  maxSteps: number;
  result?: string;
  error?: string;
  log: OperationRecord[];
}

/** A terminal status cannot transition further without an explicit retry. */
export const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
