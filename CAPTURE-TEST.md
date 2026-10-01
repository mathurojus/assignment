# CAPTURE-TEST.md

Verification that prompt/response capture is installed and fires on its own.
Written before starting the assignment build, per the brief.

---

## 1. Setup

| | |
|---|---|
| **Tool** | **OpenCode v2.0.21** — terminal client on Windows (win32), driving a background service at `http://127.0.0.1:<port>` |
| **Model** | `opencode/big-pickle` — a **single** model. It plans and executes; there is no separate planner/executor pair in this setup. |
| **Session (this one)** | `ses_f0a562781ffenPF5ZR5tGvUgVb` |
| **Git identity** | `user.name=Ojus Mathur`, `user.email=mathurojus17@gmail.com` |

### Does the tool have an automatic hook mechanism?

Yes. OpenCode has two, and I used both:

- **Plugin lifecycle / hooks** — a plugin's `setup(ctx)` runs when the plugin loads, and
  `ctx.session.hook("prompt", fn)` fires automatically on every user prompt.
  `ctx.event.subscribe()` yields the server's event stream.
- **Project plugin auto-discovery** — anything under `<project>/.opencode/plugins/` is loaded
  automatically, and the server **watches that directory and hot-reloads on change**, so no
  restart is needed and the hook is not bound to the session that created it.

I did not have to remember to run anything. Editing the plugin file is enough to install it.

## 2. Mechanism and config file

**Config file changed: none.** No `opencode.json` edit was required, because
`.opencode/plugins/` is an auto-discovery path. The capture code is the config.

- **Plugin:** `.opencode/plugins/agent-capture/index.ts`
- **Output:** `.agent-logs/YYYY-MM-DD_HH-MM-SS_<session-id>.md`, one file per session
- **Sidecar state:** `%TEMP%/opencode/agent-capture/<session-id>.json` (crash recovery only;
  the markdown is fully re-rendered from it on every append, and it is *not* part of the repo)

### How each half is captured

| Half | Trigger | Why that trigger |
|---|---|---|
| **Prompt** | `ctx.session.hook("prompt", …)` | Fires **once at admission**, before attachment/skill resolution and before any model call. Gives `event.prompt.text` verbatim. Verified this fires for prompts submitted via the HTTP API as well as the TUI. |
| **Response** | `ctx.event.subscribe()` → `session.step.ended` where `data.finish !== "tool-calls"` | I established empirically that `session.step.ended` fires after **every** step and that `data.finish` is the discriminator: `"stop"` = the model finished and the turn is over; `"tool-calls"` = mid-turn, more steps to come. |

The response body is **read back off the persisted transcript** via `ctx.session.context()`,
taking the `text` parts of the assistant messages that follow the last user message. So it is
whatever was actually stored, not a reconstruction from streamed deltas. A buffer of
`session.text.ended` payloads is kept only as a fallback if that read fails.

### What is deliberately excluded

Reasoning parts, tool calls, tool results, file reads, diffs, retries, and subagent sessions
(filtered on `Session.Info.parentID`). Only the prompt and the model's own output text are kept.

### Two judgement calls I made, stated plainly

1. **"The final response" = all assistant text across the turn**, concatenated in order — not
   just the last paragraph. My turns interleave prose with tool calls, and you said you want the
   dead ends and the moment I realised an approach was wrong. Taking only the closing paragraph
   would have been the cherry-picking you warned about. Reasoning and tool calls are still excluded.
2. **Entries are immutable.** The `.md` is re-rendered from the sidecar on each append purely so
   that `total_exchanges` and `last_prompt_time` — unknowable when the first prompt is written —
   stay correct. No entry body is ever rewritten, tidied, or removed. Proof: the canary logs
   below still show `model: unknown` and stray quotes, exactly as first captured.

## 3. Canary results

All canaries were sent into **freshly created sessions by a separate process** that never touched
the plugin. Nine were run; the log files are all still in `.agent-logs/`.

- **Canary A** — `ses_canarythree003` → `.agent-logs/2026-10-01_04-26-53_ses_canarythree003.md`
- **Canary B** — `ses_canaryfinal009` → `.agent-logs/2026-10-01_04-29-35_ses_canaryfinal009.md`

### Canary A, pasted raw from the log file

    ---
    session_id: ses_canarythree003
    date: 2026-10-01
    author: Ojus Mathur
    model: unknown
    tool: opencode
    project: assign
    total_exchanges: 1
    first_prompt_time: 2026-10-01T04:26:53.175Z
    last_prompt_time: 2026-10-01T04:26:53.175Z
    ---

    # Session Log - 2026-10-01

    Session: `canaryth` | Project: `assign` | Author: `Ojus Mathur`

    ---
    [LOG_ENTRY type=PROMPT num=1 session=canaryth]
    timestamp: 2026-10-01T04:26:53.175Z
    model: unknown

    CAPTURE TEST - 8x assignment, Ojus

### Canary B, pasted raw from the log file

    ---
    session_id: ses_canaryfinal009
    date: 2026-10-01
    author: Ojus Mathur
    model: gpt-6.1-sol
    tool: opencode
    project: assign
    total_exchanges: 1
    first_prompt_time: 2026-10-01T04:29:35.213Z
    last_prompt_time: 2026-10-01T04:29:35.213Z
    ---

    # Session Log - 2026-10-01

    Session: `canaryfi` | Project: `assign` | Author: `Ojus Mathur`

    ---
    [LOG_ENTRY type=PROMPT num=1 session=canaryfi]
    timestamp: 2026-10-01T04:29:35.213Z
    model: gpt-6.1-sol

    CAPTURE TEST - 8x assignment, Ojus

### Status: prompt half PROVEN, response half PENDING

- **Prompt capture: proven.** Verbatim text, correct timestamp, correct session-scoped file, in
  sessions created by another process. `CAPTURE TEST - 8x assignment, Ojus` round-tripped exactly.
- **Response capture: implemented and wired, but not yet observed end-to-end.** Every nested
  `opencode run` / API prompt dies at `Upstream request failed: Insufficient account funds`
  before a turn can complete, so a subprocess cannot manufacture a canary *response*. A dead turn
  emits **no** `session.step.ended` at all.
  The response path is proven instead by the first real message sent in an interactive session —
  same code path, and a more honest test than a synthetic one. See §5.

## 4. Things I tried first that did not work

1. **`GET /api/event` from an external process → `401 Unauthorized`.** The event payload schema in
   the OpenAPI document is an opaque `contentMediaType: application/json` passthrough, so I could
   not read event names off the spec either. The plugin's authenticated `ctx.event.subscribe()` was
   the only route.
2. **`import { Plugin } from "@opencode/plugin"`** → `Die(ResolveMessage: Cannot find package
   '@opencode/plugin')`. The docs' example uses this import; it does not resolve for a project
   plugin here. Fixed by exporting a plain `export default { id, setup(ctx) }`.
3. **Assuming V1 event names.** I first looked for `message.updated` and `session.idle`. Neither
   exists in V2. Replaced with a discovery plugin that dumped every distinct event type off the
   live stream, which gave the real names: `session.text.started/delta/ended`,
   `session.step.started/ended/streamed`, `session.tool.*`, `session.reasoning.*`,
   `session.usage.updated`, `shell.*`.
4. **`opencode api post /api/session --data '{...}'` from PowerShell** → `Expected a valid JSON body`.
   PowerShell strips double quotes before they reach the native Bun executable; the server log
   shows the JSON arriving as `{location:{directory:C:/Users/Ojus/Desktop/assign}}`. `--%`
   stop-parsing is not supported by this CLI. Worked around with a `.cmd` wrapper
   (`scripts/canary.cmd`), where `cmd.exe` passes the body intact.
5. **`opencode run --session <id> "CAPTURE TEST ..."`** → captured the prompt **with literal double
   quotes** around it, for the same argv reason. This is why canaries 1 and 2 in `.agent-logs/`
   read `"CAPTURE TEST - 8x assignment, Ojus"`. I left them exactly as captured. It is an argv
   artefact, not a capture bug — the TUI path is unaffected.
6. **`ctx.model.default()` returning the model → returned nothing usable.** It resolves, but returns
   an envelope `{ location, data: { id, modelID, … } }`, not a bare model. `ctx.agent.list()` has the
   same envelope and is not an array. My first unwrapping attempt read the envelope and logged
   `model: unknown`. Fixed by unwrapping `.data`; canary B then correctly recorded `gpt-6.1-sol`.
7. **A silent bug of my own, worth recording because it nearly cost me the diagnosis.** The
   diagnostic I added to find cause 6 called `appendFileSync` without importing it. The resulting
   `ReferenceError` was swallowed by the surrounding `catch {}`, so the debug file was created and
   left empty — which looked exactly like "the diagnostic never ran". Three canaries produced no
   information before I spotted the missing import.
8. **`gh` CLI is not installed** and the repo has no remote, so the GitHub handle cannot be
   auto-detected. See §6.

## 5. Known gaps, not papered over

- **This session's first two messages are missing from the logs.** They were admitted while a
  throwaway discovery plugin was still loaded, before `agent-capture` existed. I could reconstruct
  them from the on-disk transcript, but hand-writing log entries is exactly the thing you said not
  to do, so I left the gap. Capture for this session is live from the next message onward.
- **Canary sessions have a PROMPT with no RESPONSE.** Honest, not a bug: those turns never
  completed. I added explicit handling so a prompt can no longer dangle forever — if a new prompt
  arrives while a response is pending, the previous exchange is closed with
  `[no response captured - the turn ended without a final assistant message]`.
- **A dead turn is indistinguishable from a turn still running** in the event stream, which is why
  the fix above is driven by the next prompt rather than by an error event.
- **`author:` is currently a guess**, see below.

## 6. Needs your input

- **GitHub handle.** `author:` falls back to `git config user.name` = `Ojus Mathur`, which is not a
  handle. The plugin reads `AGENT_CAPTURE_AUTHOR` first; set it and every log from here on is
  correct. Note this is a server-process environment variable, so it needs `opencode service
  restart` to take effect.
