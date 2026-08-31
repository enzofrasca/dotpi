export const MAX_OUTPUT_CHARS = 40_000;
export const MAX_STDERR_CHARS = 20_000;
export const LARGE_TASK_CHARS = 8_000;
export const QUIET_HINT_MS = 15_000;

/** Read-only child: inspection tools only. Bash is not sandboxed — prompt forbids mutation. */
export const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
