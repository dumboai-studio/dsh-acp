# ADR 0003: Direct Harness sessions with ACP v1/v2

Status: Implemented in 0.7.0. Supersedes ADR 0002.

## Decision

Use one Harness session runtime and two ACP SDK handlers. The SDK 2.1.0 protocol router negotiates v1 or experimental v2 at initialization. Neither handler invokes the official Harness ACP implementation. The existing Harness CLI profile still composes the model, tools, persistence and startup services; the packaged overlay disables its ACP server and loads our plugin.

The adapter pins its Harness dependencies to the same [CLI release](../../package.json) and uses `agents.create/resume`, `Agent.followup/cancel/whenIdle`, model selection, typed session events, registered title/todo projections, session persistence readers and title checkpoints. Some content/model/MCP admission helpers are adapted from the MIT-licensed upstream sources, with attribution in THIRD_PARTY_NOTICES.md. No deprecated in-memory event snapshots or private official ACP imports are used. These public APIs are pre-stable, so every dependency upgrade still requires compatibility checks.

## Session ownership

A connection owns exact Agent and Session instances. Each session has a FIFO prompt queue, an ordered output queue and a close operation. V1 rejects overlapping prompts and returns completion after the driver, descendants and accepted updates drain. V2 keeps busy prompts pending until Harness commits their user message; it acknowledges that durable message ID separately from foreground state. Cancellation before insertion rejects the request; after insertion it cannot withdraw the successful acknowledgement. Session cancellation cancels foreground work and queued admissions.

Foreground ownership includes work started by Harness without an ACP prompt. Held submissions remain in the queue while that work runs or waits for permission; admission rechecks quiescence after asynchronous content preparation. Only the synchronous `Agent.followup` handoff gives a submission ownership of execution and cancellation. Rejected or cancelled queue entries cannot change the current task's outcome. Closing also reports the final cancelled idle state for autonomous work before its response, after Agent disposal and final output delivery.

Errors after v2 insertion become idle state updates with an error stop reason. No new turn is admitted until the previous driver has retired, including failures. Permission waits support local cancellation even if the client does not answer. Aggregate permission state distinguishes a blocked workflow from one whose other tools are still running. EOF and plugin disposal cancel owned work, flush persistence and dispose Agent scopes.

## Resume and presentation

V1 retains its existing resume-without-replay behavior. V2 always synchronizes foreground state before responding. A `start` replay cursor reads retained events through the public persistence service and reconstructs messages, tools and plans. Live updates are buffered during synchronization and delivered in order so replay cannot overwrite newer state. User message IDs survive reconnects. Unknown cursors are rejected.

The registered title/todo projections supply current snapshots and live changes. Tool categories are inferred from known tool names; unknown and MCP tools remain generic. Model configuration is per session and pinned to each admitted turn. Model changes during execution are deferred until the agent is idle. Harness records the selection through `agent.model.select()` and restores it through `agent.model.current()` when the session reopens. MCP replacement waits for foreground quiescence and restores the previous mounts if loading the replacement fails; failed rollback prevents further prompts on that session.

## Streaming and permissions

The public `agent/assistant-stream` event supplies text and reasoning deltas. They share the session output queue with committed events and completion. V1 appends each delta once and suppresses its committed text duplicate; v2 appends chunks and replaces them with the committed content snapshot. Complete text blocks without deltas are also delivered. V1 cannot retract provider text replacements; v2 reconciles them at settlement.

Assistant message IDs are adapter-owned turn/step/attempt coordinates, with a distinct reasoning ID. Counting durable `assistant/message` and `assistant/attempt` events gives replay the same IDs as live output, including retries. These IDs replace the Harness assistant IDs previously exposed by 0.7.1; clients retaining that version's transcript should rebuild it once from a start replay when upgrading. User message IDs remain unchanged. Failed attempts retain their visible prefix as transcript output without adding model-visible history. Cancellation uses Harness's durable interrupted-message prefix. This adapter writes no additional session events.

The optional public `permissionPresets` service supplies the session's `mode` config option. Changes use its setter and flush the session; permission projection and catalog changes publish the full options snapshot. A profile without that service exposes no mode selector. Saved custom permission combinations remain selectable only as their current no-op value. Model and permission mutations are ordered within each session.

## Compatibility limits

Existing CLI/environment/overlay usage and v1 display behavior remain supported. The adapter implements SDK 2.1.0's baseline v2 session surface, not every optional draft extension. It does not advertise MCP-over-ACP, additional directories, fork/delete, ACP terminal/filesystem, legacy session/set_mode or slash commands, or elicitation. The primary session working directory remains fixed.

## Validation

Keep process-level v1 regressions and add v2 tests against the built launcher with deterministic model responses and real Harness services. Cover acceptance vs completion, queued cancellation, recovery after provider errors, permission cancellation, MCP, model choices, plans/titles, restart, replay IDs and wire ordering. Use the upstream experimental ACP compatibility kit as additional evidence; its result is not an official certification. Package smoke tests run the same tests against an installed tarball outside the source checkout.
