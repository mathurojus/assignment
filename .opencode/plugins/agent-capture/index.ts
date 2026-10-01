/**
 * agent-capture — automatic prompt/response capture for the 8x assignment.
 *
 * Writes one append-only markdown log per session to <project>/.agent-logs/.
 * Captures exactly two things per exchange: the user prompt (verbatim) and the
 * model's final response for that prompt. Reasoning, tool calls, tool output,
 * file reads and diffs are deliberately excluded.
 *
 * Mechanism
 *   prompt  -> ctx.session.hook("prompt")  fires once at admission, gives the
 *              verbatim prompt text before any model call.
 *   response-> ctx.event.subscribe() on "session.step.ended" where
 *              data.finish !== "tool-calls" (i.e. the model stopped instead of
 *              requesting another tool). That is the end of a turn.
 *
 * The response body is read back from the session transcript via
 * ctx.session.context() rather than from streamed events, so it is whatever was
 * actually persisted. A buffer of session.text.ended events is kept only as a
 * fallback in case the transcript read fails.
 *
 * The markdown file is re-rendered from a sidecar state file on every append so
 * that header fields which are unknowable up front (total_exchanges,
 * last_prompt_time) stay correct. Entry bodies are never rewritten or edited.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"

const TOOL = "opencode"

type Entry = {
  type: "PROMPT" | "RESPONSE"
  num: number
  timestamp: string
  model: string
  text: string
}

type State = {
  sessionID: string
  short: string
  logFile: string
  project: string
  author: string
  firstPromptAt: string
  lastPromptAt: string
  entries: Entry[]
  buffer: string[]
  awaiting: boolean
  exchanges: number
}

/**
 * Author precedence: AGENT_CAPTURE_AUTHOR env var, then .agent-capture.json in
 * the project root, then git config user.name. The env var is a property of the
 * server process, so changing it needs `opencode service restart`; the JSON file
 * is picked up on the next plugin reload and ships with the repo.
 */
function resolveAuthor(projectDir: string): string {
  const fromEnv = process.env.AGENT_CAPTURE_AUTHOR
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  try {
    const cfg = join(projectDir, ".agent-capture.json")
    if (existsSync(cfg)) {
      const parsed = JSON.parse(readFileSync(cfg, "utf8"))
      if (typeof parsed?.author === "string" && parsed.author.trim()) return parsed.author.trim()
    }
  } catch {}
  try {
    const name = execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim()
    if (name) return name
  } catch {}
  return "unknown"
}

/** Several ctx.* reads return an envelope `{ location, data }`; unwrap it. */
function unwrap(value: any): any {
  if (value && typeof value === "object" && "data" in value) return (value as any).data
  return value
}

function modelName(model: unknown): string {
  const m = unwrap(model)
  if (!m) return "unknown"
  if (typeof m === "string") return m
  if (typeof m !== "object") return "unknown"
  const rec = m as Record<string, any>
  const id = rec.id ?? rec.modelID ?? rec.model
  if (typeof id === "string" && id) return id
  return "unknown"
}

function stamp(d: Date): { iso: string; date: string; time: string } {
  const iso = d.toISOString()
  return { iso, date: iso.slice(0, 10), time: iso.slice(11, 19).replaceAll(":", "-") }
}

function render(state: State): string {
  const { date } = stamp(new Date(state.firstPromptAt))
  const last = state.lastPromptAt || state.firstPromptAt
  const header = [
    "---",
    `session_id: ${state.sessionID}`,
    `date: ${date}`,
    `author: ${state.author}`,
    `model: ${state.entries.find((e) => e.model !== "unknown")?.model ?? "unknown"}`,
    `tool: ${TOOL}`,
    `project: ${state.project}`,
    `total_exchanges: ${state.exchanges}`,
    `first_prompt_time: ${state.firstPromptAt}`,
    `last_prompt_time: ${last}`,
    "---",
    "",
    `# Session Log - ${date}`,
    "",
    `Session: \`${state.short}\` | Project: \`${state.project}\` | Author: \`${state.author}\``,
    "",
    "---",
    "",
  ].join("\n")

  const body = state.entries
    .map((e) => {
      const head = [
        `[LOG_ENTRY type=${e.type} num=${e.num} session=${state.short}]`,
        `timestamp: ${e.timestamp}`,
        `model: ${e.model}`,
        "",
      ].join("\n")
      return `${head}\n${e.text}\n`
    })
    .join("\n")

  return header + body
}

export default {
  id: "agent-capture",
  async setup(ctx: any) {
    const projectDir = ctx.location?.project?.canonical || ctx.location?.directory
    if (!projectDir) return
    const logDir = join(projectDir, ".agent-logs")
    const stateDir = join(tmpdir(), "opencode", "agent-capture")
    mkdirSync(logDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    const author = resolveAuthor(projectDir)
    const project = basename(projectDir)
    const states = new Map<string, State>()

    // A session's model is not resolved at prompt-admission time, so fall back
    // through the agent and then the server default rather than logging "unknown".
    let cachedModel: string | undefined
    const resolveModel = async (info: any): Promise<string> => {
      const fromSession = modelName(info?.model)
      if (fromSession !== "unknown") return fromSession
      if (cachedModel) return cachedModel
      try {
        const agent = info?.agent ? await ctx.agent.get({ agentID: info.agent }) : undefined
        const fromAgent = modelName(agent?.model)
        if (fromAgent !== "unknown") {
          cachedModel = fromAgent
          return fromAgent
        }
      } catch {}
      try {
        const fromDefault = modelName(await ctx.model.default())
        if (fromDefault !== "unknown") {
          cachedModel = fromDefault
          return fromDefault
        }
      } catch {}
      // Last resort: any agent in this location that pins a model. A session
      // created over the API with no agent/model has nothing else to go on.
      try {
        const listed = unwrap(await ctx.agent.list())
        const agents = Array.isArray(listed) ? listed : []
        for (const a of agents as any[]) {
          const m = modelName(a?.model)
          if (m !== "unknown") {
            cachedModel = m
            return m
          }
        }
      } catch {}
      return cachedModel ?? "unknown"
    }

    const sidecar = (id: string) => join(stateDir, `${id}.json`)

    const load = (sessionID: string): State | undefined => {
      const cached = states.get(sessionID)
      if (cached) return cached
      const path = sidecar(sessionID)
      if (!existsSync(path)) return undefined
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as State
        states.set(sessionID, parsed)
        return parsed
      } catch {
        return undefined
      }
    }

    const create = (sessionID: string): State => {
      const short = sessionID.replace(/^ses_/, "").slice(0, 8)
      const now = new Date()
      const s = stamp(now)
      const state: State = {
        sessionID,
        short,
        logFile: join(logDir, `${s.date}_${s.time}_${sessionID}.md`),
        project,
        author,
        firstPromptAt: s.iso,
        lastPromptAt: s.iso,
        entries: [],
        buffer: [],
        awaiting: false,
        exchanges: 0,
      }
      states.set(sessionID, state)
      return state
    }

    const persist = (state: State) => {
      // The author is session metadata, not entry content, so it tracks the
      // currently configured handle. Entry bodies are never touched.
      state.author = author

      // Sidecar first: if rendering throws, the transcript state is still safe.
      const sp = sidecar(state.sessionID)
      const stmp = `${sp}.tmp`
      writeFileSync(stmp, JSON.stringify(state, null, 2), "utf8")
      renameSync(stmp, sp)

      const md = render(state)
      const tmp = `${state.logFile}.tmp`
      writeFileSync(tmp, md, "utf8")
      renameSync(tmp, state.logFile)
    }

    // ---- PROMPT --------------------------------------------------------
    await ctx.session.hook("prompt", async (event: any) => {
      const sessionID = event?.sessionID
      if (!sessionID) return
      let info: any
      try {
        info = await ctx.session.get({ sessionID })
      } catch {}
      if (info?.parentID) return // subagent session, not a human<->model exchange

      const state = load(sessionID) ?? create(sessionID)
      const now = new Date().toISOString()

      // Deliberately NOT closing out a previous unanswered prompt here. A prompt
      // can arrive while a turn is still running (the user steering), and a steer
      // is indistinguishable from a dead turn at this point. An earlier version
      // assumed "unanswered" meant "dead" and fabricated
      // "[no response captured ...]" for a turn that then succeeded, and filed the
      // real response under the wrong exchange number. A prompt with no response is
      // self-evident in the log; a fabricated one is not.
      state.exchanges += 1
      state.lastPromptAt = now
      state.awaiting = true
      state.entries.push({
        type: "PROMPT",
        num: state.exchanges,
        timestamp: now,
        model: await resolveModel(info),
        // verbatim, untruncated, unedited
        text: event?.prompt?.text ?? "",
      })
      persist(state)
    })

    // ---- RESPONSE ------------------------------------------------------
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event?.location?.directory !== projectDir) continue
          const type = event?.type
          if (type !== "session.text.ended" && type !== "session.step.ended") continue
          const sessionID = event?.data?.sessionID
          if (!sessionID) continue
          // load(), not states.get(): editing this file hot-reloads the plugin and
          // empties the in-memory map, so an in-flight turn must be restored from
          // the sidecar or its response would be dropped.
          const state = load(sessionID)
          if (!state || !state.awaiting) continue

          if (type === "session.text.ended") {
            state.buffer.push(event.data.text ?? "")
            continue
          }

          // A step that ended in a tool call is mid-turn, not the response.
          if (event.data.finish === "tool-calls") continue

          // End of turn: read the authoritative text back off the transcript.
          // Text parts are separate blocks (the model interleaves them with tool
          // calls), so they are rejoined with a blank line. Concatenating them
          // directly ran sentences together: "captured as a prompt.Log created".
          const blocks: string[] = []
          let model = "unknown"
          try {
            const messages = await ctx.session.context({ sessionID })
            const list = Array.isArray(messages) ? messages : (messages?.data ?? [])
            let start = 0
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i]?.type === "user") {
                start = i + 1
                break
              }
            }
            for (const message of list.slice(start)) {
              if (message?.type !== "assistant") continue
              model = modelName(message.model) || model
              for (const part of message.content ?? []) {
                if (part?.type === "text" && typeof part.text === "string") blocks.push(part.text)
              }
            }
          } catch {}
          if (blocks.length === 0) blocks.push(...state.buffer)
          const text = blocks.join("\n\n")
          if (model !== "unknown") cachedModel = model

          // Attribute the response to the most recent prompt that has no response
          // yet, rather than to "the current exchange counter". Those differ once
          // the user steers mid-turn: two prompts, one turn. Taking the latest
          // open prompt also stops a dead turn's leftover prompt from stealing the
          // next turn's response.
          let num = state.exchanges
          for (let i = state.entries.length - 1; i >= 0; i--) {
            const entry: any = state.entries[i]
            if (entry.type !== "PROMPT") continue
            const answered = state.entries.some((r: any) => r.type === "RESPONSE" && r.num === entry.num)
            if (!answered) {
              num = entry.num
              break
            }
          }

          state.entries.push({
            type: "RESPONSE",
            num,
            timestamp: new Date().toISOString(),
            model,
            text,
          })
          state.buffer = []
          state.awaiting = false
          persist(state)
        }
      } catch {}
    })()

    return () => controller.abort()
  },
}
