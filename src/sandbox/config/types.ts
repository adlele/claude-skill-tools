// config/types.ts — Type definitions for sandbox management

export interface SandboxState {
  branch: string;
  slug: string;
  worktree: string;
  pid: string;
  mode: string;
  base: string;
  model: string;
  created: string;
}

export interface AuditEntry {
  decision?: string;
  severity?: string;
  confidence?: string;
  tool?: string;
  input?: string;
  ts?: string;
  reason?: string;
}

export interface AuditDetail {
  tool: string;
  input: string;
  ts: string;
  reason: string;
}

export interface CreateResult {
  branch: string;
  worktree: string;
}
