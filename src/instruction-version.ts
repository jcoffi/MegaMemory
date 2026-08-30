/**
 * Version tag of the agent-instruction content this build ships into
 * AGENTS.md / CLAUDE.md. Bump it whenever that installed guidance changes.
 *
 * Shared by the installer (which stamps it both into the instruction block and
 * into each generated MCP server config's env) and the server (which reads it
 * back from the environment to flag installs whose instructions differ from
 * this build). Keeping it in one module is what makes the staleness signal
 * actually wireable end-to-end.
 */
export const INSTRUCTION_VERSION = "2026-08-30-cited-descriptive";

/**
 * Name of the env var the installer writes into generated MCP server configs
 * and the server reads at runtime. Shared so producer and consumer can never
 * drift on the key string.
 */
export const INSTRUCTIONS_VERSION_ENV = "MEGAMEMORY_INSTRUCTIONS_VERSION";
