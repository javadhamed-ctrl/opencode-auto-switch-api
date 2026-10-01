# OpenCode Smart Fallback Plugin

A modality-aware automatic model fallback plugin for [OpenCode](https://opencode.ai). When your primary model hits rate limits, quota exhaustion, or other transient errors, this plugin automatically switches to a compatible fallback model based on the task's modality requirements (text, vision, audio, video).

## Features

- **Modality-Aware Routing**: Classifies tasks as text-only, vision, audio, or video and selects fallback models that support the required modalities
- **Automatic Fallback**: Detects rate limits (429), quota errors, service unavailable (503), timeouts, and other transient failures
- **Per-Agent Fallback Chains**: Configure different fallback models for different agents (coder, reviewer, etc.)
- **Circuit Breaker**: Automatically isolates consistently failing models
- **Cooldown Periods**: Prevents immediate retry of failed models
- **Auto-Recovery**: Returns to the original model after cooldown expires
- **Notifications**: Toast notifications on fallback/recovery events
- **Control Tool**: `/smart_fallback_control` tool for enable/disable/status/reset/recover

## Installation

### Local Plugin (Recommended)

Copy `smart-fallback.ts` to your OpenCode plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins
cp smart-fallback.ts ~/.config/opencode/plugins/
```

Add to your `opencode.jsonc`:

```jsonc
{
  "plugin": [
    [
      "smart-fallback",
      {
        "enabled": true,
        "debug": true,
        "notify": true,
        "defaultFallback": {
          "enabled": true,
          "maxDepth": 3,
          "cooldownMs": 60000,
          "fallbackModels": [
            { "providerID": "nara", "modelID": "nemotron-3.5-lightning-free", "priority": 1, "capabilities": { "text": true, "vision": false, "audio": false, "video": false } },
            { "providerID": "nara", "modelID": "agnes-3-flash", "priority": 2, "capabilities": { "text": true, "vision": false, "audio": false, "video": false } },
            { "providerID": "codecraft", "modelID": "gemini-3.6-flash", "priority": 10, "capabilities": { "text": true, "vision": true, "audio": true, "video": true } }
          ]
        },
        "agents": {
          "coder": {
            "enabled": true,
            "maxDepth": 3,
            "cooldownMs": 60000,
            "fallbackModels": [
              { "providerID": "nara", "modelID": "nemotron-3.5-lightning-free", "priority": 1, "capabilities": { "text": true, "vision": false, "audio": false, "video": false } },
              { "providerID": "codecraft", "modelID": "deepseek-v4-pro-0813", "priority": 10, "capabilities": { "text": true, "vision": false, "audio": false, "video": false } }
            ]
          }
        },
        "circuitBreaker": { "enabled": true, "failureThreshold": 5, "recoveryTimeoutMs": 60000 },
        "taskClassification": { "enabled": true }
      }
    ]
  ]
}
```

### NPM Package (Future)

```bash
npm install opencode-smart-fallback
```

Then add to `opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-smart-fallback"]
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `debug` | boolean | `false` | Enable debug logging to stderr |
| `notify` | boolean | `true` | Show toast notifications on fallback/recovery |
| `defaultFallback` | AgentFallbackConfig | see below | Default fallback configuration |
| `agents` | Record<string, AgentFallbackConfig> | `{}` | Per-agent fallback overrides |
| `circuitBreaker` | CircuitBreakerConfig | `{ enabled: true, failureThreshold: 5, recoveryTimeoutMs: 60000 }` | Circuit breaker settings |
| `taskClassification` | TaskClassificationConfig | `{ enabled: true, ... }` | Task modality classification keywords |

### AgentFallbackConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable fallback for this agent |
| `maxDepth` | number | `3` | Maximum fallback attempts per message |
| `cooldownMs` | number | `60000` | Cooldown period for failed models (ms) |
| `fallbackModels` | ModelConfig[] | `[]` | Ordered list of fallback models |

### ModelConfig

| Option | Type | Description |
|--------|------|-------------|
| `providerID` | string | Provider ID (e.g., "nara", "codecraft") |
| `modelID` | string | Model ID (e.g., "nemotron-3.5-lightning-free") |
| `capabilities` | ModelCapabilities | Required: `{ text: true, vision: false, audio: false, video: false }` |
| `priority` | number | Lower = higher priority (default: 999) |

### ModelCapabilities

| Option | Type | Description |
|--------|------|-------------|
| `text` | boolean | Text generation (always true for LLMs) |
| `vision` | boolean | Image understanding (Claude, GPT-4o, Gemini) |
| `audio` | boolean | Audio input/output (GPT-4o, Gemini) |
| `video` | boolean | Video understanding (Gemini 2.5+) |

## Usage

### Automatic Fallback

Just use OpenCode normally. When a model hits a transient error:

1. Plugin detects the error (rate limit, quota, timeout, etc.)
2. Classifies the current task's modality requirements from the user message
3. Selects the next available fallback model that supports required modalities
4. Reverts the session and replays the user message with the fallback model
5. Shows a toast notification

### Control Tool

Use the built-in tool to manage fallback per session:

```bash
# Check status
/smart_fallback_control status

# Disable fallback for current session
/smart_fallback_control disable

# Enable fallback
/smart_fallback_control enable

# Reset fallback state
/smart_fallback_control reset

# Manually recover to original model
/smart_fallback_control recover
```

## How It Works

1. **Event Listening**: Plugin listens for `session.error`, `session.status` (retry), and `message.updated` (assistant error) events
2. **Error Classification**: Determines if error is retryable (rate limit, quota, timeout, etc.) or immediate fallback (auth, model unsupported)
3. **Task Classification**: Analyzes user message for modality keywords (image, audio, video, etc.)
4. **Model Selection**: Filters fallback models by availability, modality compatibility, and priority
5. **Execution**: Reverts session to last user message, replays with fallback model
6. **Recovery**: On session idle, checks if original model cooldown expired and recovers automatically

## Supported Error Types

### Immediate Fallback (no retry)
- Authentication errors (401, 402, 403)
- Quota exhausted / insufficient quota
- Billing hard limit
- Model unsupported / missing API key

### Retryable with Backoff then Fallback
- Rate limits (429, "rate limit", "too many requests")
- Service unavailable (503, 504, 529)
- Timeouts, network errors, connection resets
- Context length / token limit exceeded
- "try again later/soon/in N seconds"

## Example Scenarios

### Text-Only Task (Coding)
```
User: "Write a Python function to parse JSON"
→ Task: text-only
→ Primary: nara/nemotron-3-ultra-free (text)
→ On rate limit: nara/nemotron-3.5-lightning-free (text)
```

### Vision Task (Image Analysis)
```
User: "Analyze this screenshot for UI bugs" + image
→ Task: vision required
→ Primary: codecraft/gpt-5.5 (vision)
→ On rate limit: codecraft/gemini-3.6-flash (vision + audio + video)
```

### Audio Task (Transcription)
```
User: "Transcribe this audio file" + audio
→ Task: audio required
→ Primary: codecraft/gemini-3.6-flash (audio)
→ On rate limit: codecraft/gpt-5.5 (audio)
```

## License

MIT License - see LICENSE file for details.

## Author

Javad Hamed (javadhamed@gmail.com)