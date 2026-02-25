#!/bin/bash
# sandbox-guard.sh — PreToolUse hook that restricts file operations to the sandbox directory.
# Expects SANDBOX_DIR env var to be set to the allowed worktree path.
# Used with --dangerously-skip-permissions to limit blast radius.

set -euo pipefail

if [[ -z "${SANDBOX_DIR:-}" ]]; then
  exit 0  # No sandbox constraint — allow everything
fi

# Resolve sandbox dir to absolute path
SANDBOX_DIR="$(cd "$SANDBOX_DIR" && pwd)"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

# --- Audit logging ---
AUDIT_FILE="$SANDBOX_DIR/audit-raw.jsonl"
AUDIT_DECISION="allowed"
AUDIT_SEVERITY="low"
AUDIT_CONFIDENCE="high"
AUDIT_REASON="Fully validated"

write_audit() {
  local input_summary
  input_summary="$(echo "$INPUT" | jq -r '.tool_input | tostring' 2>/dev/null | head -c 200)" || true
  jq -n -c \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg tool "$TOOL_NAME" \
    --arg input "$input_summary" \
    --arg decision "$AUDIT_DECISION" \
    --arg severity "$AUDIT_SEVERITY" \
    --arg confidence "$AUDIT_CONFIDENCE" \
    --arg reason "$AUDIT_REASON" \
    '{ts:$ts,tool:$tool,input:$input,decision:$decision,severity:$severity,confidence:$confidence,reason:$reason}' \
    >> "$AUDIT_FILE" 2>/dev/null || true
}

deny() {
  AUDIT_DECISION="flagged"
  AUDIT_SEVERITY="high"
  AUDIT_CONFIDENCE="high"
  AUDIT_REASON="$1"
  write_audit
  jq -n \
    --arg reason "$1" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
  exit 0
}

check_path() {
  local file_path="$1"
  [[ -z "$file_path" ]] && return 0

  # Resolve to absolute (handle relative paths from cwd)
  local cwd
  cwd=$(echo "$INPUT" | jq -r '.cwd // empty')
  if [[ "$file_path" != /* ]]; then
    file_path="${cwd}/${file_path}"
  fi

  # Normalize (resolve .., symlinks, etc.)
  # Use python since realpath may not exist on all macOS versions
  local resolved
  resolved=$(python3 -c "import os; print(os.path.realpath('$file_path'))" 2>/dev/null || echo "$file_path")

  if [[ "$resolved" != "$SANDBOX_DIR"* ]]; then
    deny "Blocked: '$resolved' is outside the sandbox directory ($SANDBOX_DIR)"
  fi
}

case "$TOOL_NAME" in
  Write|Edit)
    FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
    check_path "$FILE_PATH"
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

    # Block commands that explicitly reference paths outside sandbox
    # Check for common destructive patterns with absolute paths
    if echo "$COMMAND" | grep -qE '(rm|mv|cp|chmod|chown)\s' ; then
      # Extract paths from the command and check each one
      for path in $(echo "$COMMAND" | grep -oE '\/[^\s"'\'';&|>]+'); do
        # Normalize
        resolved=$(python3 -c "import os; print(os.path.realpath('$path'))" 2>/dev/null || echo "$path")
        if [[ "$resolved" != "$SANDBOX_DIR"* && "$resolved" != /usr/* && "$resolved" != /bin/* && "$resolved" != /opt/* && "$resolved" != /tmp/* ]]; then
          deny "Blocked: command references '$resolved' which is outside the sandbox directory ($SANDBOX_DIR)"
        fi
      done
    fi

    # Block cd to outside sandbox
    if echo "$COMMAND" | grep -qE 'cd\s+/' ; then
      CD_TARGET=$(echo "$COMMAND" | grep -oE 'cd\s+\/[^\s;&|]+' | head -1 | sed 's/cd\s*//')
      if [[ -n "$CD_TARGET" ]]; then
        resolved=$(python3 -c "import os; print(os.path.realpath('$CD_TARGET'))" 2>/dev/null || echo "$CD_TARGET")
        if [[ "$resolved" != "$SANDBOX_DIR"* ]]; then
          deny "Blocked: 'cd $CD_TARGET' would leave the sandbox directory ($SANDBOX_DIR)"
        fi
      fi
    fi

    # Classify Bash commands that were allowed but couldn't be fully validated
    if echo "$COMMAND" | grep -qE '\b(curl|wget|nc|ssh|scp|rsync)\b'; then
      AUDIT_SEVERITY="high"
      AUDIT_CONFIDENCE="low"
      AUDIT_REASON="Network operation"
    elif echo "$COMMAND" | grep -qE '\bgit\s+(push|remote|fetch|clone)\b'; then
      AUDIT_SEVERITY="high"
      AUDIT_CONFIDENCE="low"
      AUDIT_REASON="Git remote operation"
    elif echo "$COMMAND" | grep -qE '(\$\(|\$\{|`)'; then
      AUDIT_SEVERITY="high"
      AUDIT_CONFIDENCE="low"
      AUDIT_REASON="Variable expansion/subshell"
    elif echo "$COMMAND" | grep -qF '|'; then
      AUDIT_SEVERITY="medium"
      AUDIT_CONFIDENCE="low"
      AUDIT_REASON="Downstream segments unvalidated"
    elif echo "$COMMAND" | grep -qF '../'; then
      AUDIT_SEVERITY="medium"
      AUDIT_CONFIDENCE="low"
      AUDIT_REASON="Relative path traversal"
    fi
    ;;
esac

# Write audit entry and allow
write_audit
exit 0
