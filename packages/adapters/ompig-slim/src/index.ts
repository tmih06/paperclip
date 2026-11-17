export const type = "ompig_slim";
export const label = "ompig-slim (durable)";
export const models: { id: string; label: string }[] = [];
export const agentConfigurationDoc = `# ompig_slim

Use when an installed ompig-slim executable should perform an immutable Durable assignment with SQLite/WAL checkpoints. Not the interactive PiG/omp runtime; no ordinary extensions, skills, MCP configuration or model roles are automatically loaded.

Configuration:
- command: executable, default ompig-slim. Install a pinned binary in the execution image; no implicit downloads or local fallback.
- model: required exact configured provider/model identity. Credentials/profile configuration must already be present in the execution environment, or supplied via env.
- cwd: absolute workspace path. The Paperclip execution workspace takes precedence.
- maxTurns: tool-round budget, default 100.
- timeoutSec: process time limit, default 0 (disabled); graceSec: shutdown grace, default 20.
- promptTemplate, bootstrapPromptTemplate, instructionsFilePath: Paperclip instructions.
- env: environment overrides (use secret references for credentials).

Every Paperclip run has one private .paperclip-ompig workdesk below its execution workspace. Repeating the SAME run/assignment resumes it; changed prompt, cwd, model or budget fails closed. A new Paperclip turn starts a new immutable assignment with Paperclip's fresh-session handoff, not a conversational resume. An unfinished saved assignment from another run is refused; reconcile it before resetting the session. Terminal unanswered work is never automatically retried with a fresh workdesk.

SIGTERM/SIGINT leave recoverable work, not an aborted assignment. Core owns process-tree termination. Resume requires the original cwd and all workspace edits plus the ENTIRE workdesk (including SQLite WAL). Workspace sync is only a clean-stop snapshot, not continuous durability: emptyDir pod deletion/node loss can lose both. Use persistent storage and verify its locking/WAL semantics before claiming infrastructure-crash recovery. done means an answer, NOT tests/review/deployment approval.`;
