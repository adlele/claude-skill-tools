export interface ClaudeSessionEntry {
  /** UUID passed to --session-id */
  claudeSessionId: string;
  /** Composer step index that spawned this session */
  stepIndex: number;
  /** Step label for display (e.g. "Run architect") */
  stepLabel: string;
  /** Step type ("claude-interactive" | "ralph") */
  stepType: string;
  /** The worktree/cwd where claude was run */
  projectDir: string;
  /** ISO timestamp when the session was started */
  startedAt: string;
  /** Ralph iteration number (for ralph steps that run multiple sub-sessions) */
  ralphIteration?: number;
  /** Ralph phase (for ralph steps) */
  ralphPhase?: "dev" | "rev";
}

export interface ComposerSessionMap {
  /** Composer session ID */
  composerSessionId: string;
  /** Composition type (e.g. "full", "ralph-only") */
  compositionType: string;
  /** Branch name */
  branch: string;
  /** When the composer session was started */
  startedAt: string;
  /** All Claude sessions spawned by this composer session */
  claudeSessions: ClaudeSessionEntry[];
}
