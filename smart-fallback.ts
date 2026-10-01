import type { Plugin, ToolDefinition, PluginInput, Config, Hooks } from "@opencode-ai/plugin"
import type { Event, Session, Message, ApiError, UserMessage, AssistantMessage, Part } from "@opencode-ai/sdk"
import { z } from "zod"

interface ModelCapabilities {
  text: boolean
  vision: boolean
  audio: boolean
  video: boolean
}

interface ModelConfig {
  providerID: string
  modelID: string
  capabilities: ModelCapabilities
  priority?: number
}

interface AgentFallbackConfig {
  fallbackModels: ModelConfig[]
  maxDepth: number
  cooldownMs: number
  enabled: boolean
}

interface PluginConfig {
  enabled: boolean
  defaultFallback: AgentFallbackConfig
  agents: Record<string, AgentFallbackConfig>
  globalCooldownMs: number
  circuitBreaker: {
    enabled: boolean
    failureThreshold: number
    recoveryTimeoutMs: number
  }
  notify: boolean
  debug: boolean
  taskClassification: {
    enabled: boolean
    visionKeywords: string[]
    audioKeywords: string[]
    videoKeywords: string[]
  }
}

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  defaultFallback: {
    fallbackModels: [],
    maxDepth: 3,
    cooldownMs: 60000,
    enabled: true,
  },
  agents: {},
  globalCooldownMs: 60000,
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    recoveryTimeoutMs: 60000,
  },
  notify: true,
  debug: false,
  taskClassification: {
    enabled: true,
    visionKeywords: ["image", "picture", "photo", "screenshot", "diagram", "chart", "visual", "look at", "see", "analyze image", "describe image", "ocr", "read image"],
    audioKeywords: ["audio", "sound", "voice", "speech", "transcribe", "listen", "pronounce", "speak", "say", "tts", "text to speech"],
    videoKeywords: ["video", "movie", "clip", "watch", "frame", "animation", "screen recording"],
  },
}

const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-opus-4": { text: true, vision: true, audio: false, video: false },
  "claude-sonnet-4": { text: true, vision: true, audio: false, video: false },
  "claude-haiku-4": { text: true, vision: true, audio: false, video: false },
  "gpt-4o": { text: true, vision: true, audio: true, video: false },
  "gpt-4o-mini": { text: true, vision: true, audio: true, video: false },
  "gpt-5": { text: true, vision: true, audio: true, video: false },
  "gemini-2.5-pro": { text: true, vision: true, audio: true, video: true },
  "gemini-2.5-flash": { text: true, vision: true, audio: true, video: true },
  "gemini-2.0-flash": { text: true, vision: true, audio: true, video: true },
  "gemini-3": { text: true, vision: true, audio: true, video: true },
  "nemotron-3-ultra": { text: true, vision: false, audio: false, video: false },
  "nemotron-3.5-lightning": { text: true, vision: false, audio: false, video: false },
  "deepseek-v4": { text: true, vision: false, audio: false, video: false },
  "deepseek-r1": { text: true, vision: false, audio: false, video: false },
  "qwen3": { text: true, vision: true, audio: false, video: false },
  "glm-5": { text: true, vision: true, audio: false, video: false },
  "kimi-k2": { text: true, vision: true, audio: false, video: false },
  "agnes": { text: true, vision: false, audio: false, video: false },
  "laguna": { text: true, vision: false, audio: false, video: false },
  "ling": { text: true, vision: false, audio: false, video: false },
  "space-bunny": { text: true, vision: false, audio: false, video: false },
}

function normalizeModelID(modelID: string): string {
  return modelID.toLowerCase().replace(/[^a-z0-9]/g, "-")
}

function getModelCapabilities(modelID: string): ModelCapabilities {
  const normalized = normalizeModelID(modelID)
  for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (normalized.includes(key)) {
      return caps
    }
  }
  return { text: true, vision: false, audio: false, video: false }
}

function classifyTask(message: string, config: PluginConfig): ModelCapabilities {
  if (!config.taskClassification.enabled) {
    return { text: true, vision: false, audio: false, video: false }
  }

  const lower = message.toLowerCase()
  const required: ModelCapabilities = { text: true, vision: false, audio: false, video: false }

  for (const kw of config.taskClassification.visionKeywords) {
    if (lower.includes(kw.toLowerCase())) {
      required.vision = true
      break
    }
  }
  for (const kw of config.taskClassification.audioKeywords) {
    if (lower.includes(kw.toLowerCase())) {
      required.audio = true
      break
    }
  }
  for (const kw of config.taskClassification.videoKeywords) {
    if (lower.includes(kw.toLowerCase())) {
      required.video = true
      break
    }
  }

  return required
}

function modelMatchesCapabilities(modelID: string, required: ModelCapabilities): boolean {
  const caps = getModelCapabilities(modelID)
  if (required.vision && !caps.vision) return false
  if (required.audio && !caps.audio) return false
  if (required.video && !caps.video) return false
  return true
}

interface ErrorWithMessage {
  message: string
  statusCode?: number
}

function hasMessageAndStatusCode(error: unknown): error is ErrorWithMessage {
  return typeof error === "object" && error !== null && "message" in error && typeof (error as any).message === "string"
}

function isRetryableError(error: unknown): boolean {
  if (!hasMessageAndStatusCode(error)) return false
  const status = error.statusCode
  const message = error.message
  const lower = message.toLowerCase()

  if (status && [401, 402, 403].includes(status)) return true
  if (status && [429, 500, 502, 503, 504, 529].includes(status)) return true

  const retryPatterns = [
    "rate limit",
    "too many requests",
    "quota exceeded",
    "usage limit",
    "insufficient quota",
    "billing hard limit",
    "out of credits",
    "all credentials exhausted",
    "model unsupported",
    "service unavailable",
    "overloaded",
    "temporarily unavailable",
    "try again later",
    "try again soon",
    "try again in",
    "context length",
    "context window",
    "max tokens",
    "token limit",
    "disconnected",
    "connection reset",
    "socket hang up",
    "network error",
    "timeout",
  ]

  return retryPatterns.some((p) => lower.includes(p))
}

interface ModelState {
  failures: number
  lastFailure: number
  cooldownUntil: number
  circuitOpen: boolean
}

interface SessionState {
  fallbackDepth: number
  currentModel: string
  originalModel: string
  attempts: Array<{ model: string; timestamp: number; error: string }>
}

interface FallbackContext {
  client: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>
  config: PluginConfig
  modelStates: Map<string, ModelState>
  sessionStates: Map<string, SessionState>
}

function getModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function getModelState(ctx: FallbackContext, key: string): ModelState {
  let state = ctx.modelStates.get(key)
  if (!state) {
    state = { failures: 0, lastFailure: 0, cooldownUntil: 0, circuitOpen: false }
    ctx.modelStates.set(key, state)
  }
  return state
}

function getSessionState(ctx: FallbackContext, sessionID: string): SessionState {
  let state = ctx.sessionStates.get(sessionID)
  if (!state) {
    state = { fallbackDepth: 0, currentModel: "", originalModel: "", attempts: [] }
    ctx.sessionStates.set(sessionID, state)
  }
  return state
}

function isModelAvailable(ctx: FallbackContext, key: string): boolean {
  const state = getModelState(ctx, key)
  const now = Date.now()
  if (state.cooldownUntil > now) return false
  if (ctx.config.circuitBreaker.enabled && state.circuitOpen) {
    if (state.lastFailure + ctx.config.circuitBreaker.recoveryTimeoutMs > now) return false
    state.circuitOpen = false
    state.failures = 0
  }
  return true
}

function recordFailure(ctx: FallbackContext, key: string, error: string): void {
  const state = getModelState(ctx, key)
  state.failures++
  state.lastFailure = Date.now()
  state.cooldownUntil = Date.now() + ctx.config.defaultFallback.cooldownMs
  if (ctx.config.circuitBreaker.enabled && state.failures >= ctx.config.circuitBreaker.failureThreshold) {
    state.circuitOpen = true
  }
}

function recordSuccess(ctx: FallbackContext, key: string): void {
  const state = getModelState(ctx, key)
  state.failures = Math.max(0, state.failures - 1)
  state.circuitOpen = false
}

function selectFallbackModel(
  ctx: FallbackContext,
  agentName: string,
  requiredCaps: ModelCapabilities,
  excludeKeys: string[]
): ModelConfig | null {
  const agentConfig = ctx.config.agents[agentName] ?? ctx.config.defaultFallback
  if (!agentConfig.enabled || agentConfig.fallbackModels.length === 0) return null

  const candidates = agentConfig.fallbackModels
    .filter((m) => !excludeKeys.includes(getModelKey(m.providerID, m.modelID)))
    .filter((m) => isModelAvailable(ctx, getModelKey(m.providerID, m.modelID)))
    .filter((m) => modelMatchesCapabilities(m.modelID, requiredCaps))
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))

  return candidates[0] ?? null
}

async function showToast(client: FallbackContext["client"], message: string, variant: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  try {
    await client.tui.showToast({ body: { message, variant } })
  } catch {}
}

function logDebug(ctx: FallbackContext, ...args: any[]): void {
  if (ctx.config.debug) console.error("[smart-fallback]", ...args)
}

interface MessageWithParts {
  info: Message
  parts: Part[]
}

async function getLastUserMessage(client: FallbackContext["client"], sessionID: string): Promise<MessageWithParts | null> {
  try {
    const response = await client.session.messages({ path: { id: sessionID } })
    const messages = (response.data as MessageWithParts[]) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === "user") return messages[i]
    }
  } catch {}
  return null
}

async function getSessionAgent(client: FallbackContext["client"], sessionID: string): Promise<string> {
  const userMsg = await getLastUserMessage(client, sessionID)
  if (userMsg && userMsg.info.role === "user") return (userMsg.info as UserMessage).agent
  return "default"
}

async function triggerFallback(
  ctx: FallbackContext,
  sessionID: string,
  agentName: string,
  error: unknown,
  providerID: string,
  modelID: string
): Promise<boolean> {
  const sessionState = getSessionState(ctx, sessionID)
  const agentConfig = ctx.config.agents[agentName] ?? ctx.config.defaultFallback

  if (sessionState.fallbackDepth >= agentConfig.maxDepth) {
    logDebug(ctx, "max fallback depth reached", sessionID)
    await showToast(ctx.client, "⚠️ Smart Fallback: Max fallback depth reached", "warning")
    return false
  }

  const currentModelKey = getModelKey(providerID, modelID)

  const userMessage = await getLastUserMessage(ctx.client, sessionID)
  const messageContent = userMessage?.parts
    .filter((p): p is Part & { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ") ?? ""
  const requiredCaps = classifyTask(messageContent, ctx.config)

  const excludeKeys = new Set(sessionState.attempts.map((a) => a.model))
  excludeKeys.add(currentModelKey)

  const fallback = selectFallbackModel(ctx, agentName, requiredCaps, Array.from(excludeKeys))
  if (!fallback) {
    logDebug(ctx, "no suitable fallback model", sessionID)
    await showToast(ctx.client, "⚠️ Smart Fallback: No suitable fallback model available", "warning")
    return false
  }

  recordFailure(ctx, currentModelKey, String(error))

  sessionState.fallbackDepth++
  sessionState.attempts.push({ model: currentModelKey, timestamp: Date.now(), error: String(error) })
  sessionState.currentModel = getModelKey(fallback.providerID, fallback.modelID)

  if (sessionState.originalModel === "") {
    sessionState.originalModel = currentModelKey
  }

  logDebug(ctx, "fallback triggered", {
    session: sessionID,
    from: currentModelKey,
    to: sessionState.currentModel,
    depth: sessionState.fallbackDepth,
    requiredCaps,
  })

  const capsStr = [requiredCaps.vision && "vision", requiredCaps.audio && "audio", requiredCaps.video && "video", "text"]
    .filter(Boolean)
    .join(" ")
  await showToast(ctx.client, `🔄 Smart Fallback: Switching to ${fallback.modelID} (${capsStr})`, "info")

try {
        if (userMessage) {
          await ctx.client.session.revert({ path: { id: sessionID }, body: { messageID: userMessage.info.id } })
          const promptParts = userMessage.parts
            .filter((p): p is Part & { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ type: "text" as const, text: p.text }))
          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              model: { providerID: fallback.providerID, modelID: fallback.modelID },
              parts: promptParts,
            },
          })
        }
        return true
      } catch (e) {
    logDebug(ctx, "fallback execution failed", e)
    await showToast(ctx.client, "❌ Smart Fallback: Failed to execute fallback", "error")
    return false
  }
}

async function tryRecoverOriginal(ctx: FallbackContext, sessionID: string, agentName: string): Promise<void> {
  const sessionState = getSessionState(ctx, sessionID)
  if (!sessionState.originalModel || sessionState.originalModel === sessionState.currentModel) return

  const originalState = getModelState(ctx, sessionState.originalModel)
  const now = Date.now()
  if (originalState.cooldownUntil <= now && !originalState.circuitOpen) {
    logDebug(ctx, "recovering to original model", { session: sessionID, original: sessionState.originalModel })
    const [providerID, modelID] = sessionState.originalModel.split("/")
    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          model: { providerID, modelID },
          parts: [],
        },
      })
      sessionState.currentModel = sessionState.originalModel
      recordSuccess(ctx, sessionState.originalModel)
      await showToast(ctx.client, `✅ Smart Fallback: Recovered to original model`, "success")
    } catch (e) {
      logDebug(ctx, "recovery failed", e)
    }
  }
}

function extractErrorFromEvent(event: Event): { error: unknown; providerID: string; modelID: string; sessionID: string; agentName: string } | null {
  if (event.type === "session.error") {
    const sessionID = event.properties.sessionID
    if (!sessionID) return null
    return {
      error: event.properties.error ?? "Unknown error",
      providerID: "",
      modelID: "",
      sessionID,
      agentName: "default",
    }
  }

  if (event.type === "session.status") {
    const sessionID = event.properties.sessionID
    const status = event.properties.status
    if (!sessionID || status.type !== "retry") return null
    if (!isRetryableError(status.message)) return null
    return {
      error: status.message,
      providerID: "",
      modelID: "",
      sessionID,
      agentName: "default",
    }
  }

  if (event.type === "message.updated") {
    const message = event.properties.info
    if (message.role !== "assistant" || !message.error) return null
    if (!isRetryableError(message.error)) return null
    const assistantMsg = message as AssistantMessage
    return {
      error: assistantMsg.error,
      providerID: assistantMsg.providerID,
      modelID: assistantMsg.modelID,
      sessionID: assistantMsg.sessionID,
      agentName: "default",
    }
  }

  return null
}

export default async function smartFallbackPlugin(
  input: PluginInput,
  options: Partial<PluginConfig> = {}
): Promise<Hooks> {
  const client = input.client
  const config = { ...DEFAULT_CONFIG, ...options } as PluginConfig
  const modelStates = new Map<string, ModelState>()
  const sessionStates = new Map<string, SessionState>()

  const fallbackCtx: FallbackContext = {
    client,
    config,
    modelStates,
    sessionStates,
  }

  const hooks: Hooks = {
    async event({ event }) {
      if (!config.enabled) return

      const extracted = extractErrorFromEvent(event)
      if (!extracted) return

      let { error, providerID, modelID, sessionID, agentName } = extracted

      if (!providerID || !modelID) {
        const sessionInfo = await getLastUserMessage(client, sessionID)
        if (sessionInfo && sessionInfo.info.role === "user") {
          const userMsg = sessionInfo.info as UserMessage
          providerID = userMsg.model.providerID
          modelID = userMsg.model.modelID
          agentName = userMsg.agent
        } else {
          agentName = await getSessionAgent(client, sessionID)
        }
      } else if (!agentName || agentName === "default") {
        agentName = await getSessionAgent(client, sessionID)
      }

      if (!providerID || !modelID) {
        logDebug(fallbackCtx, "could not determine provider/model for session", sessionID)
        return
      }

      await triggerFallback(fallbackCtx, sessionID, agentName, error, providerID, modelID)
    },

    async config(cfg: Config) {
      if (!cfg.plugin) cfg.plugin = []
      cfg.plugin.push(["smart-fallback", config as any])
    },

    tool: {
      smart_fallback_control: {
        description: "Control smart fallback for current session",
        args: {
          action: z.enum(["enable", "disable", "status", "reset", "recover"]).describe("Action to perform"),
        },
        async execute({ action }: { action: string }, context) {
          const sessionID = context.sessionID
          const agentName = context.agent
          const sessionState = getSessionState(fallbackCtx, sessionID)
          const agentConfig = config.agents[agentName] ?? config.defaultFallback

          switch (action) {
            case "enable":
              agentConfig.enabled = true
              return "Smart fallback enabled for this session"
            case "disable":
              agentConfig.enabled = false
              return "Smart fallback disabled for this session"
            case "status": {
              const userMsg = await getLastUserMessage(client, sessionID)
              const currentModel = userMsg && userMsg.info.role === "user"
                ? getModelKey((userMsg.info as UserMessage).model.providerID, (userMsg.info as UserMessage).model.modelID)
                : "unknown"
              const availableFallbacks = agentConfig.fallbackModels
                .filter((m) => isModelAvailable(fallbackCtx, getModelKey(m.providerID, m.modelID)))
                .map((m) => `${m.providerID}/${m.modelID}`)
              return JSON.stringify({
                enabled: agentConfig.enabled,
                currentModel,
                originalModel: sessionState.originalModel || "none",
                fallbackDepth: sessionState.fallbackDepth,
                maxDepth: agentConfig.maxDepth,
                attempts: sessionState.attempts.length,
                availableFallbacks,
              }, null, 2)
            }
            case "reset":
              sessionState.fallbackDepth = 0
              sessionState.attempts = []
              sessionState.originalModel = ""
              return "Smart fallback state reset"
            case "recover":
              if (sessionState.originalModel && sessionState.originalModel !== "unknown") {
                const [providerID, modelID] = sessionState.originalModel.split("/")
                try {
                  await client.session.prompt({
                    path: { id: sessionID },
                    body: { model: { providerID, modelID }, parts: [] },
                  })
                  sessionState.currentModel = sessionState.originalModel
                  recordSuccess(fallbackCtx, sessionState.originalModel)
                  return `Recovered to original model: ${sessionState.originalModel}`
                } catch (e) {
                  return `Recovery failed: ${e}`
                }
              }
              return "No original model to recover to"
            default:
              return `Unknown action: ${action}`
          }
        },
      },
    },
  }

  return hooks
}