export type GoalConditionType = "contains" | "absent" | "regex" | "price_below";

export interface GoalCondition {
  type: GoalConditionType;
  /** Text to find / pattern / numeric threshold (as a string). */
  value: string;
  /** Optional CSS selector to scope the checked text to part of the page. */
  selector?: string;
}

export type GoalStatus = "active" | "paused";

export interface GoalCheck {
  at: string;
  ok: boolean; // was the condition satisfied at this check?
  detail: string;
  error?: string;
}

export interface Goal {
  id: string;
  name: string;
  url: string;
  condition: GoalCondition;
  intervalSec: number;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastOk?: boolean;
  /** First time the condition became satisfied (when the alert fired). */
  triggeredAt?: string;
  /** Recent check history (capped). */
  checks: GoalCheck[];
}
