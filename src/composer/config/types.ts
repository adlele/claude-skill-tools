export type StepType =
  | "sandbox-start"
  | "sandbox-start-ralph"
  | "sandbox-start-headless"
  | "claude-interactive"
  | "ralph"
  | "status-check"
  | "pr-dry-run"
  | "pr-create";

export interface Step {
  label: string;
  cmd: string;
  type: StepType;
}

export interface Composition {
  description: string;
  steps: Step[];
}

export interface SessionState {
  sessionId: string;
  composition: string;
  currentStep: number;
  totalSteps: number;
  status: "in_progress" | "paused" | "completed";
  context: string;
  model: string;
  maxIterations: number;
  branch: string;
  worktree: string;
  adoId: string;
  /** Role name for the 'role' composition (e.g. "architect", "developer") */
  role?: string;
  stepTimings: number[];
  started: string;
  updated: string;
}

export interface TemplateVars {
  sessionId: string;
  context: string;
  /** Pre-computed branch name passed to sandbox start (e.g. users/adlele/add-pin-message-a1b2) */
  branchName: string;
  /** Actual branch captured from sandbox state after step 1 */
  branch: string;
  worktree: string;
  model: string;
  maxIterations: number;
  adoId: string;
  /** Role name for the 'role' composition (e.g. "architect", "developer") */
  role: string;
}
