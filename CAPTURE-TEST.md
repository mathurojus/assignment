# CAPTURE-TEST.md

Verification that prompt/response capture is installed and fires on its own.
Written before starting the assignment build, per the brief.

---

## 1. Setup

| | |
|---|---|
| **Tool** | **OpenCode v2.0.21** — terminal client on Windows (win32), driving a background service on `127.0.0.1` |
| **Model** | `opencode/big-pickle` — a **single** model. It plans and executes; there is no separate planner/executor pair in this setup. |
| **Session used for setup** | `ses_f0a562781ffenPF5ZR5tGvUgVb` |
| **Author** | `mathurojus` |

### Does the tool have an automatic hook mechanism?

Yes. OpenCode has several, and I used three:

- **Plugin lifecycle** — a plugin's `setup(ctx)` runs when the plugin loads.
- **Session hooks** — `ctx.session.hook("prompt", fn)` fires automatically on every user prompt.
- **Event stream** — `ctx.event.subscribe()` yields the server's event stream.

Plus **project plugin auto-discovery**: anything under `<project>/.opencode/plugins/` loads
automatically, and the server **watches that directory and hot-reloads on change**, so no restart
is needed and the hook is not bound to the session that created it.

I never had to remember to run anything. Saving the plugin file is the whole install step.

## 2. Mechanism and config file

**Config file changed: none.** No `opencode.json` edit was needed, because `.opencode/plugins/` is
an auto-discovery path. The capture code is the config.

- **Plugin:** `.opencode/plugins/agent-capture/index.ts`
- **Author config:** `.agent-capture.json` in the repo root
- **Output:** `.agent-logs/YYYY-MM-DD_HH-MM-SS_<session-id>.md`, one file per session
- **Sidecar state:** `%TEMP%/opencode/agent-capture/<session-id>.json` — crash recovery only. The
  markdown is fully re-rendered from it on every append. Not part of the repo.

### How each half is captured

| Half | Trigger | Why that trigger |
|---|---|---|
| **Prompt** | `ctx.session.hook("prompt", …)` | Fires **once at admission**, before attachment/skill resolution and before any model call. Gives `event.prompt.text` verbatim. Verified to fire for HTTP-API prompts as well as TUI prompts. |
| **Response** | `ctx.event.subscribe()` → `session.step.ended` where `data.finish !== "tool-calls"` | Established empirically, not assumed: `session.step.ended` fires after **every** step, and `data.finish` is the discriminator — `"stop"` means the model finished and the turn is over, `"tool-calls"` means more steps to come. |

The response body is **read back off the persisted transcript** via `ctx.session.context()`,
taking the `text` parts of the assistant messages that follow the last user message. So it is what
was actually stored, not a reconstruction from streamed deltas. A buffer of `session.text.ended`
payloads is kept only as a fallback if that read fails.

### What is deliberately excluded

Reasoning parts, tool calls, tool results, file reads, diffs, retries, and subagent sessions
(filtered on `Session.Info.parentID`). Only the prompt and the model's own output text are kept.

### Three judgement calls, stated plainly

1. **"The final response" = all assistant text across the turn**, concatenated in order — not just
   the closing paragraph. My turns interleave prose with tool calls, and you said the dead ends and
   the moment I realised an approach was wrong are the most useful things in the log. Taking only
   the last paragraph would have been the cherry-picking you warned about. Reasoning and tool calls
   are still excluded.
2. **Entries are immutable.** The `.md` is re-rendered from the sidecar on each append purely so
   `total_exchanges` and `last_prompt_time` — unknowable when the first prompt is written — stay
   correct. No entry body is ever rewritten, tidied, or removed. Proof: canaries 1–8 still read
   `model: unknown` and canaries 1–2 still carry stray quotes, exactly as first captured.
3. **`author:` is session metadata, not entry content**, so it tracks the currently configured
   handle. That is why canary 10 says `mathurojus` while canary 1 says `Ojus Mathur`.

## 3. Canary results

Canaries were sent into **freshly created sessions by a separate process** that never touched the
plugin. Ten were run. The log files are all still in `.agent-logs/`.

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

### Response-path evidence, from the interactive session

The subprocess canaries cannot exercise the response path: every nested run dies at
`Upstream request failed: Insufficient account funds` before a turn completes, and a dead turn
emits **no** `session.step.ended` at all. So the response path was proven on a real turn instead,
in `ses_f0a562781ffenPF5ZR5tGvUgVb` → `.agent-logs/2026-10-01_04-31-58_ses_f0a562781ffenPF5ZR5tGvUgVb.md`:

    [LOG_ENTRY type=RESPONSE num=1 session=f0a56278]
    timestamp: 2026-10-01T04:33:57.719Z
    model: big-pickle

    Handle received. First, let me confirm this message itself was captured as a prompt.Log
    created for this session, prompt verbatim, `model: big-pickle` correctly resolved.

(The run-on `prompt.Log` is the block-join bug from §4.9, left in place as captured. It was fixed
immediately afterwards; exchanges from 2 onward rejoin the blocks with a blank line.)

### Status: PROVEN, both halves

- **Prompt:** verbatim text, correct UTC timestamp, correct model, correct session-scoped file,
  landing in sessions created by another process. `CAPTURE TEST - 8x assignment, Ojus`
  round-tripped byte-exact.
- **Response:** full turn text captured, with reasoning and tool calls excluded, on a real
  completed turn.
- **Independence:** capture works in sessions that did not create the hook.
- **Encoding:** logs are valid UTF-8 and byte-exact on disk (verified by round-tripping the raw
  bytes), and `.gitattributes` stops Git rewriting line endings inside them.

## 4. Things I tried first that did not work

1. **`GET /api/event` from an external process → `401 Unauthorized`.** The event payload schema in
   the OpenAPI document is an opaque `contentMediaType: application/json` passthrough, so I could
   not read event names off the spec either. The plugin's authenticated `ctx.event.subscribe()` was
   the only route.
2. **`import { Plugin } from "@opencode/plugin"`** → `Die(ResolveMessage: Cannot find package
   '@opencode/plugin')`. The docs' own example uses this import; it does not resolve for a project
   plugin here. Fixed by exporting a plain `export default { id, setup(ctx) }`.
3. **Assuming V1 event names.** I first looked for `message.updated` and `session.idle`. Neither
   exists in V2. Replaced with a throwaway discovery plugin that dumped every distinct event type
   off the live stream, which produced the real names: `session.text.started/delta/ended`,
   `session.step.started/ended/streamed`, `session.tool.*`, `session.reasoning.*`,
   `session.usage.updated`, `shell.*`.
4. **`opencode api post /api/session --data '{...}'` from PowerShell** → `Expected a valid JSON
   body`. PowerShell strips double quotes before they reach the native Bun executable; the server
   log shows the JSON arriving as `{location:{directory:C:/Users/Ojus/Desktop/assign}}`. `--%`
   stop-parsing is not supported by this CLI. Worked around with a `.cmd` wrapper
   (`scripts/canary.cmd`), where `cmd.exe` passes the body intact.
5. **`opencode run --session <id> "CAPTURE TEST ..."`** → captured the prompt **with literal double
   quotes** around it, for the same argv reason. That is why canaries 1 and 2 read
   `"CAPTURE TEST - 8x assignment, Ojus"`. Left exactly as captured. An argv artefact, not a
   capture bug; the TUI path is unaffected.
6. **`ctx.model.default()` → returned nothing usable.** It resolves, but returns an envelope
   `{ location, data: { id, modelID, … } }`, not a bare model. `ctx.agent.list()` has the same
   envelope and is not an array. My first unwrapping attempt read the envelope and logged
   `model: unknown`. Fixed by unwrapping `.data`; canary B then correctly recorded `gpt-6.1-sol`.
7. **A silent bug of my own, recorded because it nearly cost me the whole diagnosis.** The
   diagnostic added to find cause 6 called `appendFileSync` without importing it. The resulting
   `ReferenceError` was swallowed by the surrounding `catch {}`, so the debug file was created and
   left empty — indistinguishable from "the diagnostic never ran". Three canaries produced no
   information before I spotted the missing import.
8. **`gh` CLI is not installed** and the repo had no remote, so the GitHub handle could not be
   auto-detected. Resolved by asking, and by shipping the handle in `.agent-capture.json`.
9. **Text blocks were concatenated with no separator.** The model's text is stored as several
   `text` parts per turn, split at tool-call boundaries. I had assumed each part ended with a
   newline and joined with `""`, reasoning that reproducing the raw stream was maximally faithful.
   It is not: it produced run-on text in the first real response —
   `...captured as a prompt.Log created for this session...`. Fixed by rejoining blocks with a
   blank line. Exchange 1 still shows the artefact, left as captured.
10. **The response handler read state that a hot-reload empties.** It used the in-memory `Map`
    instead of the sidecar-restoring loader, so editing the plugin mid-turn would have silently
    dropped that turn's response. Found by reading the code immediately before making an edit that
    would have triggered it, and fixed first. Capture has to survive the act of editing the
    capture code, or it is not really automatic.

## 5. Known gaps, not papered over

- **This session's first two messages are missing from the logs.** They were admitted while the
  throwaway discovery plugin was still loaded, before `agent-capture` existed. I could reconstruct
  them from the on-disk transcript, but hand-writing log entries is exactly what you said not to
  do, so the gap stays. That log file records exchanges 1 onward from the third message.
- **Canary sessions have a PROMPT with no RESPONSE.** Honest, not a bug: those turns never
  completed. Explicit handling now prevents a prompt dangling forever — if a new prompt arrives
  while a response is pending, the previous exchange is closed with
  `[no response captured - the turn ended without a final assistant message]`.
- **A dead turn is indistinguishable from a turn still running** in the event stream, which is why
  that fix is driven by the next prompt rather than by an error event.
- **Canaries 1–8 record `author: Ojus Mathur`**, the `git config user.name` fallback, because they
  were captured before the handle was known. Canary 10 and later record `mathurojus`. The earlier
  files were not retro-edited.

## 6. Repo setup

- **Remote:** `origin` → `https://github.com/mathurojus/assignment.git`
- **Branch:** `main`
- **Author:** `mathurojus`, from `.agent-capture.json`. Precedence is `AGENT_CAPTURE_AUTHOR` env
  var, then that file, then `git config user.name`. The repo file is preferred over the env var
  deliberately: the env var belongs to the server process and would need `opencode service
  restart`, which kills the session mid-setup. The file is picked up on the next plugin reload and
  ships with the submission so the value is auditable.
- `.agent-logs/` is **not** in `.gitignore`. `.gitattributes` marks it `-text` so Git cannot
  rewrite line endings inside recorded entries.
