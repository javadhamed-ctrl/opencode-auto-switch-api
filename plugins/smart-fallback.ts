import type { Plugin, PluginInput, Config, Hooks } from "@opencode-ai/plugin"
import type { Event, Session, Message, UserMessage, AssistantMessage, Part } from "@opencode-ai/sdk"
import { z } from "zod"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelCapabilities {
  text: boolean
  vision: boolean
  audio: boolean
  video: boolean
}

interface ModelEntry {
  providerID: string
  modelID: string
  displayName: string
  capabilities: ModelCapabilities
  priority: number
}

interface ProviderEntry {
  id: string
  name: string
  baseURL: string
  models: Array<{ id: string; name: string }>
}

interface ErrorState {
  failures: number
  lastFailure: number
  cooldownUntil: number
  circuitOpen: boolean
}

interface SessionState {
  fallbackDepth: number
  currentModel: string
  originalModel: string
  attempts: Array<{ model: string; timestamp: number; error: string; provider: string }>
}

interface PluginOptions {
  enabled?: boolean
  debug?: boolean
  notify?: boolean
  maxDepth?: number
  cooldownMs?: number
  circuitBreakerThreshold?: number
  circuitBreakerRecoveryMs?: number
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<PluginOptions> = {
  enabled: true,
  debug: false,
  notify: true,
  maxDepth: 5,
  cooldownMs: 60000,
  circuitBreakerThreshold: 5,
  circuitBreakerRecoveryMs: 60000,
}

// ─── Capability inference from model ID patterns ────────────────────────────

const CAPABILITY_PATTERNS: Array<{ pattern: RegExp; caps: Partial<ModelCapabilities> }> = [
  // Gemini multimodal
  { pattern: /gemini/i, caps: { vision: true, audio: true, video: true } },
  // GPT-4o/5 family
  { pattern: /gpt[-_]?[45o]|gpt[-_]?[5-9]/i, caps: { vision: true, audio: true } },
  // Claude family (vision)
  { pattern: /claude/i, caps: { vision: true } },
  // DeepSeek (text + vision)
  { pattern: /deepseek/i, caps: { vision: true } },
  // Qwen family
  { pattern: /qwen/i, caps: { vision: true } },
  // GLM family
  { pattern: /glm/i, caps: { vision: true } },
  // Kimi family
  { pattern: /kimi|moonshot/i, caps: { vision: true } },
  // Nemotron (text only)
  { pattern: /nemotron/i, caps: {} },
  // Agnes (text only)
  { pattern: /agnes/i, caps: {} },
  // Laguna (text only)
  { pattern: /laguna/i, caps: {} },
  // Ling (text only)
  { pattern: /ling/i, caps: {} },
  // Space Bunny (text only)
  { pattern: /space[- ]?bunny/i, caps: {} },
]

function inferCapabilities(modelID: string): ModelCapabilities {
  const base: ModelCapabilities = { text: true, vision: false, audio: false, video: false }
  for (const { pattern, caps } of CAPABILITY_PATTERNS) {
    if (pattern.test(modelID)) {
      return { ...base, ...caps }
    }
  }
  if (/vision|image|multimodal/i.test(modelID)) base.vision = true
  return base
}

// ─── Task classification from user message ───────────────────────────────────

const VISION_KEYWORDS = [
  "image", "picture", "photo", "screenshot", "diagram", "chart", "visual",
  "look at", "analyze image", "describe image", "ocr", "read image",
  "تصویر", "عکس", "نمونه", "گراف", "نمودار", "اسکرین‌شات",
]
const AUDIO_KEYWORDS = [
  "audio", "sound", "voice", "speech", "transcribe", "listen", "pronounce",
  "speak", "tts", "text to speech", "podcast",
  "صدا", "گویش", "ضبط", "فایل صوتی",
]
const VIDEO_KEYWORDS = [
  "video", "movie", "clip", "watch", "frame", "animation", "screen recording",
  "فیلم", "ویدئو", "انیمیشن", "ضبط صفحه",
]

function classifyTask(message: string): ModelCapabilities {
  const lower = message.toLowerCase()
  const required: ModelCapabilities = { text: true, vision: false, audio: false, video: false }
  for (const kw of VISION_KEYWORDS) { if (lower.includes(kw.toLowerCase())) { required.vision = true; break } }
  for (const kw of AUDIO_KEYWORDS)  { if (lower.includes(kw.toLowerCase()))  { required.audio  = true;  break } }
  for (const kw of VIDEO_KEYWORDS)  { if (lower.includes(kw.toLowerCase()))  { required.video  = true;  break } }
  return required
}

function modelMatchesCaps(modelCaps: ModelCapabilities, required: ModelCapabilities): boolean {
  if (required.vision && !modelCaps.vision) return false
  if (required.audio  && !modelCaps.audio)  return false
  if (required.video  && !modelCaps.video)  return false
  return true
}

// ─── Config discovery ────────────────────────────────────────────────────────

function findOpencodeConfig(): string | null {
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
    path.join(process.cwd(), "opencode.jsonc"),
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(process.cwd(), "opencode.json"),
  ]
  for (const c of candidates) { if (fs.existsSync(c)) return c }
  return null
}

function stripJSONCComments(jsonc: string): string {
  return jsonc
    .replace(/"(?:[^"\\]|\\.)*"/g, match => match)
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

function discoverProviders(): ProviderEntry[] {
  const configPath = findOpencodeConfig()
  if (!configPath) return []
  try {
    const raw = stripJSONCComments(fs.readFileSync(configPath, "utf-8"))
    const cfg = JSON.parse(raw) as Record<string, any>
    const providers: ProviderEntry[] = []
    for (const [id, provider] of Object.entries(cfg.provider || {})) {
      const p = provider as Record<string, any>
      const models = Object.entries(p.models || {}).map(([mid, m]: [string, any]) => ({
        id: mid, name: m?.name ?? mid,
      }))
      providers.push({ id, name: p.name ?? id, baseURL: p.options?.baseURL ?? "", models })
    }
    return providers
  } catch (e) {
    console.error("[auto-switch] Config parse error:", e)
    return []
  }
}

function buildModelRegistry(providers: ProviderEntry[]): ModelEntry[] {
  return providers.flatMap(p =>
    p.models.map(m => ({
      providerID: p.id,
      modelID: m.id,
      displayName: `${p.name} → ${m.name}`,
      capabilities: inferCapabilities(m.id),
      priority: p.id + "/" + m.id,
    }))
  ).sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID))
}

// ─── Error state management ──────────────────────────────────────────────────

function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function getErrorState(key: string, states: Map<string, ErrorState>): ErrorState {
  let s = states.get(key)
  if (!s) { s = { failures: 0, lastFailure: 0, cooldownUntil: 0, circuitOpen: false }; states.set(key, s) }
  return s
}

function isAvailable(state: ErrorState, opts: Required<PluginOptions>): boolean {
  const now = Date.now()
  if (state.cooldownUntil > now) return false
  if (opts.circuitBreakerThreshold > 0 && state.circuitOpen) {
    if (state.lastFailure + opts.circuitBreakerRecoveryMs > now) return false
    state.circuitOpen = false; state.failures = 0
  }
  return true
}

function recordFailure(key: string, states: Map<string, ErrorState>, opts: Required<PluginOptions>): void {
  const s = getErrorState(key, states)
  s.failures++; s.lastFailure = Date.now()
  s.cooldownUntil = Date.now() + opts.cooldownMs
  if (s.failures >= opts.circuitBreakerThreshold) s.circuitOpen = true
}

function recordSuccess(key: string, states: Map<string, ErrorState>): void {
  const s = getErrorState(key, states)
  s.failures = Math.max(0, s.failures - 1); s.circuitOpen = false
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logDebug(debug: boolean, ...args: any[]): void {
  if (debug) console.error("[auto-switch]", ...args)
}

async function showToast(client: any, message: string, variant: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  try { await client.tui.showToast({ body: { message, variant } }) } catch {}
}

async function getLastUserMessage(client: any, sessionID: string) {
  try {
    const resp = await client.session.messages({ path: { id: sessionID } })
    const msgs = (resp.data as any[]) ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info?.role === "user") return msgs[i]
    }
  } catch {}
  return null
}

async function getSessionAgent(client: any, sessionID: string): Promise<string> {
  const um = await getLastUserMessage(client, sessionID)
  if (um?.info?.role === "user") return (um.info as UserMessage).agent ?? "default"
  return "default"
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Object) || error === null) return false
  const e = error as Record<string, any>
  const msg = String(e?.message ?? "").toLowerCase()
  const status = e?.status ?? e?.statusCode
  if (status && [401, 402, 403, 429, 500, 502, 503, 504, 529].includes(status)) return true
  const patterns = [
    "rate limit", "too many requests", "quota exceeded", "billing hard limit",
    "out of credits", "insufficient quota", "model unsupported",
    "service unavailable", "overloaded", "temporarily unavailable",
    "context length", "context window", "max tokens", "token limit",
    "disconnected", "connection reset", "socket hang up", "network error", "timeout",
  ]
  return patterns.some(p => msg.includes(p))
}

// ─── Plugin entry point ─────────────────────────────────────────────────────

export default async function autoSwitchPlugin(
  input: PluginInput,
  options: PluginOptions = {}
): Promise<Hooks> {
  const client = input.client
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const providers = discoverProviders()
  const modelRegistry = buildModelRegistry(providers)

  logDebug(opts.debug, `Discovered ${providers.length} providers, ${modelRegistry.length} models`)

  const errorStates = new Map<string, ErrorState>()
  const sessionStates = new Map<string, SessionState>()

  if (providers.length > 0) {
    const summary = providers.map(p =>
      `  ${p.name} (${p.id}): ${p.models.length} models`
    ).join("\n")
    logDebug(opts.debug, "Providers:\n" + summary)
  }

  async function triggerSwitch(
    sessionID: string, agentName: string,
    error: unknown, providerID: string, modelID: string,
  ): Promise<boolean> {
    if (!opts.enabled) return false

    const ss = sessionStates.get(sessionID) ??
      { fallbackDepth: 0, currentModel: "", originalModel: "", attempts: [] }
    if (!sessionStates.has(sessionID)) sessionStates.set(sessionID, ss)

    if (ss.fallbackDepth >= opts.maxDepth) {
      await showToast(client, "⚠️ Auto Switch: Max switches reached", "warning")
      return false
    }

    const curKey = modelKey(providerID, modelID)
    const um = await getLastUserMessage(client, sessionID)
    const msgText = um?.parts?.filter((p: Part) => p.type === "text").map((p: any) => p.text).join(" ") ?? ""
    const required = classifyTask(msgText)

    const tried = new Set(ss.attempts.map(a => a.model))
    tried.add(curKey)

    const candidates = modelRegistry
      .filter(m => !tried.has(modelKey(m.providerID, m.modelID)))
      .filter(m => isAvailable(getErrorState(modelKey(m.providerID, m.modelID), errorStates), opts))
      .filter(m => modelMatchesCaps(m.capabilities, required))
      .sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID))

    if (candidates.length === 0) {
      await showToast(client, "⚠️ Auto Switch: No suitable model found", "warning")
      return false
    }

    const next = candidates[0]
    recordFailure(curKey, errorStates, opts)
    ss.fallbackDepth++
    ss.attempts.push({ model: curKey, timestamp: Date.now(), error: String(error), provider: providerID })
    ss.currentModel = modelKey(next.providerID, next.modelID)
    if (ss.originalModel === "") ss.originalModel = curKey

    const capsStr = [
      required.vision && "👁 vision",
      required.audio  && "🔊 audio",
      required.video  && "🎬 video",
      "📝 text",
    ].filter(Boolean).join(", ")

    logDebug(opts.debug, `switching ${curKey} → ${next.providerID}/${next.modelID}  [${capsStr}]`)
    await showToast(client, `🔄 Auto Switch → ${next.displayName}  [${capsStr}]`, "info")

    try {
      if (um) {
        const parts = um.parts
          ?.filter((p: Part) => p.type === "text")
          .map((p: any) => ({ type: "text" as const, text: p.text }))
          ?? []
        await client.session.revert({ path: { id: sessionID }, body: { messageID: um.info.id } })
        await client.session.prompt({
          path: { id: sessionID },
          body: { model: { providerID: next.providerID, modelID: next.modelID }, parts },
        })
        recordSuccess(modelKey(next.providerID, next.modelID), errorStates)
        return true
      }
      return false
    } catch (e) {
      logDebug(opts.debug, "switch execution failed", e)
      await showToast(client, `❌ Auto Switch: Failed on ${next.displayName}`, "error")
      return false
    }
  }

  async function recoverOriginal(sessionID: string): Promise<void> {
    const ss = sessionStates.get(sessionID)
    if (!ss || !ss.originalModel || ss.originalModel === ss.currentModel) return
    const [provID, modelID] = ss.originalModel.split("/")
    const st = getErrorState(ss.originalModel, errorStates)
    if (st.cooldownUntil <= Date.now() && !st.circuitOpen) {
      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: { model: { providerID: provID, modelID }, parts: [] },
        })
        ss.currentModel = ss.originalModel
        recordSuccess(ss.originalModel, errorStates)
        await showToast(client, `✅ Auto Switch: Recovered to ${ss.originalModel}`, "success")
      } catch (e) { logDebug(opts.debug, "recover failed", e) }
    }
  }

  function extractError(event: Event) {
    if (event.type === "session.error") {
      const sid = event.properties?.sessionID
      if (!sid) return null
      return { error: event.properties?.error ?? "Unknown", sessionID: sid, agentName: "default", providerID: "", modelID: "" }
    }
    if (event.type === "session.status") {
      const sid = event.properties?.sessionID
      const status = event.properties?.status
      if (!sid || status?.type !== "retry") return null
      if (!isRetryableError(status.message)) return null
      return { error: status.message, sessionID: sid, agentName: "default", providerID: "", modelID: "" }
    }
    if (event.type === "message.updated") {
      const msg = event.properties?.info
      if (msg?.role !== "assistant" || !msg.error) return null
      if (!isRetryableError(msg.error)) return null
      const am = msg as AssistantMessage
      return { error: am.error, sessionID: am.sessionID, agentName: "default", providerID: am.providerID, modelID: am.modelID }
    }
    return null
  }

  const hooks: Hooks = {
    async event({ event }) {
      if (!opts.enabled) return
      const ex = extractError(event)
      if (!ex) return

      let { error, providerID, modelID, sessionID, agentName } = ex
      if (!providerID || !modelID) {
        const um = await getLastUserMessage(client, sessionID)
        if (um?.info?.role === "user") {
          providerID = (um.info as UserMessage).model?.providerID ?? ""
          modelID = (um.info as UserMessage).model?.modelID ?? ""
          agentName = (um.info as UserMessage).agent ?? "default"
        } else {
          agentName = await getSessionAgent(client, sessionID)
        }
      } else if (!agentName || agentName === "default") {
        agentName = await getSessionAgent(client, sessionID)
      }
      if (!providerID || !modelID) return

      await triggerSwitch(sessionID, agentName, error, providerID, modelID)
    },

    async config(cfg: Config) {
      if (!cfg.plugin) cfg.plugin = []
      cfg.plugin.push(["auto-switch-api", opts])
    },

    tool: {
      auto_switch_status: {
        description: "Show current model, fallback depth, and all discovered providers/models",
        args: {},
        async execute(_: Record<string, never>, context) {
          const ss = sessionStates.get(context.sessionID) ?? { fallbackDepth: 0, currentModel: "", originalModel: "", attempts: [] }
          const um = await getLastUserMessage(client, context.sessionID)
          const current = um?.info?.role === "user"
            ? modelKey((um.info as UserMessage).model.providerID, (um.info as UserMessage).model.modelID)
            : "unknown"
          return JSON.stringify({
            enabled: opts.enabled,
            currentModel: current,
            originalModel: ss.originalModel || "none",
            fallbackDepth: ss.fallbackDepth,
            maxDepth: opts.maxDepth,
            attempts: ss.attempts.length,
            totalModels: modelRegistry.length,
            providers: providers.map(p => ({
              id: p.id, name: p.name,
              modelCount: p.models.length,
              models: p.models.map(m => ({ id: m.id, name: m.name })),
            })),
          }, null, 2)
        },
      },
      auto_switch_control: {
        description: "Control auto-switch: enable, disable, reset state, or recover to original model",
        args: {
          action: z.enum(["enable", "disable", "reset", "recover"])
            .describe("Action: enable, disable, reset, or recover"),
        },
        async execute({ action }: { action: string }, context) {
          const ss = sessionStates.get(context.sessionID) ??
            { fallbackDepth: 0, currentModel: "", originalModel: "", attempts: [] }
          if (!sessionStates.has(context.sessionID)) sessionStates.set(context.sessionID, ss)
          switch (action) {
            case "enable":  opts.enabled = true; return "Auto-switch enabled"
            case "disable": opts.enabled = false; return "Auto-switch disabled"
            case "reset":
              ss.fallbackDepth = 0; ss.attempts = []; ss.originalModel = ""
              return "State reset"
            case "recover":
              if (ss.originalModel && ss.originalModel !== "unknown") {
                const [provID, modelID] = ss.originalModel.split("/")
                try {
                  await client.session.prompt({
                    path: { id: context.sessionID },
                    body: { model: { providerID: provID, modelID }, parts: [] },
                  })
                  ss.currentModel = ss.originalModel
                  recordSuccess(ss.originalModel, errorStates)
                  return `Recovered to ${ss.originalModel}`
                } catch (e) { return `Recovery failed: ${String(e)}` }
              }
              return "No original model to recover to"
            default: return `Unknown action: ${action}`
          }
        },
      },
    },
  }

  return hooks
}
