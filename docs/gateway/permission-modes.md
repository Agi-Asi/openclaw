---
summary: "Session permission modes, workspace boundaries, and escalation reviewers"
read_when:
  - Choosing a permission mode for an agent session
  - Understanding who reviews an exec escalation
  - Comparing session permissions with sandbox and tool policy
title: Session permission modes
---

Session permission modes set one session's filesystem boundary and exec escalation reviewer. The boundary is the session's canonical `sessionRoot`; the mode determines what may happen inside or outside it.

| Mode        | Filesystem access                                 | Exec escalation reviewer              |
| ----------- | ------------------------------------------------- | ------------------------------------- |
| `read-only` | Reads under `sessionRoot`; mutation tools omitted | None; exec is denied                  |
| `guarded`   | Reads and writes under `sessionRoot`              | A human after the allowlist fast path |
| `workspace` | Reads and writes under `sessionRoot`              | LLM review, with human fallback       |
| `full`      | Unrestricted filesystem access                    | None                                  |

`full` requires `operator.admin`. The other modes require `operator.write`.

A direct user turn in an existing `full` session may explicitly delegate that mode with `sessions_spawn({ permissionMode: "full" })`. The option is native-subagent only, is hidden on ineligible turns, and never applies by omission. The child records a visible system note when the delegation commits.

## Session root and defaults

The Gateway records `sessionRoot` when it creates the session. An explicit working directory becomes the root after canonical path resolution. A session without an explicit working directory uses the selected agent's canonical workspace.

Managed worktree sessions use the worktree checkout as `sessionRoot`. A nested working directory remains the runtime `cwd`, so relative paths start there while filesystem containment covers the whole checkout.

A new managed worktree session defaults to `workspace` when no mode is specified. Other sessions with no recorded mode keep the existing config-driven behavior.

## Policy precedence and clamping

An explicit session mode takes precedence over the session's legacy `execSecurity` and `execAsk` overrides. When the mode is unset, those fields and the normal global or per-agent configuration continue to work as before.

An explicit `full` mode is the admin-authorized exception to host approval-file floors: its OpenClaw exec policy remains `full` with approvals off. Approval-file floors continue to tighten config-driven exec policy, legacy session overrides, unset modes, and every non-full session mode. Sandbox restrictions and tool allow/deny policy remain independent, and a harness may clamp an unsupported mode to a compatible safer policy tuple. Codex also continues to honor externally enforced `requirements.toml` constraints.

Changing permission, exec, elevated, or tool policy rotates the session lifecycle revision. If work is active, `sessions.patch` rejects the change by default. Callers that own the current `sessionId` and `lifecycleRevision` can choose `activeRunPolicy: "stop"` to stop and drain that work before commit, or `"stop-and-continue"` to start one trusted continuation after the new policy commits. The operation records a visible system note; queued turns prepared under the old policy are discarded rather than replayed.

For the independent sandbox, tool-policy, and elevated-exec controls, see [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).
