import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import type {
  AIConfig,
  AIConfigErrorCode,
  AIConfigField,
  AIConfigValidation,
  AIErrorInfo,
  AIErrorKind,
  AITransportMessage,
  BaseURLErrorCode,
  ChatOnceResult,
} from '@/types/ai'

export const DEFAULT_AI_CONFIG: Readonly<AIConfig> = {
  schemaVersion: 1,
  baseURL: '',
  model: '',
  timeoutMs: 60000,
  maxContextRounds: 10,
}

export const TIMEOUT_RANGE = { min: 5000, max: 300000 } as const

export const ROUNDS_RANGE = { min: 1, max: 50 } as const

export const MODEL_MAX_LENGTH = 200

export const CONNECTION_TEST_PROMPT = 'Reply with the single word OK.'

/**
 * Must stay identical to the allow list in `src-tauri/capabilities/ai-network.json`
 * (enforced by `src/__tests__/capabilities.test.ts`).
 */
export const AUTHORIZED_HTTPS_ORIGINS: readonly string[] = [
  'https://api.openai.com',
  'https://api.deepseek.com',
  'https://dashscope.aliyuncs.com',
  'https://api.moonshot.cn',
  'https://open.bigmodel.cn',
  'https://api.siliconflow.cn',
  'https://ark.cn-beijing.volces.com',
  'https://token-plan.maas.qianwenaiapi.com',
]

export const AUTHORIZED_LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost']

export class AIError extends Error {
  readonly kind: AIErrorKind
  readonly status?: number
  readonly detail?: string

  constructor(kind: AIErrorKind, options: { status?: number, detail?: string } = {}) {
    super(kind)
    this.name = 'AIError'
    this.kind = kind
    this.status = options.status
    this.detail = options.detail
  }

  toInfo(): AIErrorInfo {
    return { kind: this.kind, status: this.status, detail: this.detail }
  }
}

export function toAIErrorInfo(error: unknown): AIErrorInfo {
  if (error instanceof AIError) return error.toInfo()

  return classifyTransportError(error).toInfo()
}

export type NormalizedBaseURL
  = | { ok: true, value: string }
    | { ok: false, code: BaseURLErrorCode }

export function normalizeBaseURL(input: string): NormalizedBaseURL {
  const trimmed = input.trim()

  if (!trimmed) return { ok: false, code: 'empty' }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, code: 'invalid' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'protocol' }
  }

  if (!url.hostname) return { ok: false, code: 'invalid' }

  if (url.username || url.password) return { ok: false, code: 'credentials' }

  if (url.search || url.hash || /[?#]/.test(trimmed)) {
    return { ok: false, code: 'query_or_hash' }
  }

  if (url.protocol === 'http:' && !AUTHORIZED_LOOPBACK_HOSTS.includes(url.hostname)) {
    return { ok: false, code: 'insecure' }
  }

  const path = url.pathname.replace(/\/+$/, '')

  if (/\/chat\/completions$/i.test(path)) return { ok: false, code: 'full_endpoint' }

  return { ok: true, value: `${url.origin}${path}` }
}

export function isAuthorizedBaseURL(baseURL: string) {
  let url: URL

  try {
    url = new URL(baseURL)
  } catch {
    return false
  }

  if (url.protocol === 'http:') return AUTHORIZED_LOOPBACK_HOSTS.includes(url.hostname)

  return url.protocol === 'https:' && AUTHORIZED_HTTPS_ORIGINS.includes(url.origin)
}

export function buildChatCompletionsURL(baseURL: string) {
  return `${baseURL}/chat/completions`
}

export function validateAIConfig(draft: Partial<AIConfig>): AIConfigValidation {
  const errors: Partial<Record<AIConfigField, AIConfigErrorCode>> = {}

  const base = normalizeBaseURL(draft.baseURL ?? '')

  if (!base.ok) {
    errors.baseURL = base.code
  } else if (!isAuthorizedBaseURL(base.value)) {
    errors.baseURL = 'not_authorized'
  }

  const model = (draft.model ?? '').trim()

  if (!model) {
    errors.model = 'model_empty'
  } else if (model.length > MODEL_MAX_LENGTH) {
    errors.model = 'model_too_long'
  }

  const { timeoutMs, maxContextRounds } = draft

  if (!isIntegerInRange(timeoutMs, TIMEOUT_RANGE)) errors.timeoutMs = 'timeout_range'

  if (!isIntegerInRange(maxContextRounds, ROUNDS_RANGE)) errors.maxContextRounds = 'rounds_range'

  if (!base.ok || Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      schemaVersion: 1,
      baseURL: base.value,
      model,
      timeoutMs: timeoutMs!,
      maxContextRounds: maxContextRounds!,
    },
  }
}

function isIntegerInRange(value: unknown, range: { min: number, max: number }) {
  return Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizeDetail(raw: unknown, secrets: readonly string[] = []) {
  if (typeof raw !== 'string') return

  let text = raw

  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join('***')
  }

  text = text
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replace(/\b(sk|ak|pk)-[\w-]{6,}/gi, '$1-***')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return

  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function extractServerError(body: string) {
  let json: unknown

  try {
    json = JSON.parse(body)
  } catch {
    return {}
  }

  if (!isRecord(json)) return {}

  const { error } = json

  if (isRecord(error)) {
    return {
      message: typeof error.message === 'string' ? error.message : undefined,
      code: typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : undefined,
    }
  }

  if (typeof error === 'string') return { message: error }

  if (typeof json.message === 'string') return { message: json.message }

  if (typeof json.detail === 'string') return { message: json.detail }

  return {}
}

const CONTEXT_LIMIT_PATTERN = /context[_ ]length|maximum context|context window|too many tokens|token limit|max_tokens|exceeds? the/i

function statusToKind(status: number, hint: string): AIErrorKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 408) return 'timeout'
  if (status === 413) return 'context_too_long'
  if (status === 429) return 'rate_limited'
  if ((status === 400 || status === 422) && CONTEXT_LIMIT_PATTERN.test(hint)) return 'context_too_long'
  if (status >= 500) return 'server_error'

  return 'http_error'
}

export function parseChatResponse(status: number, body: string, secrets: readonly string[] = []): ChatOnceResult {
  if (status < 200 || status >= 300) {
    const { message, code } = extractServerError(body)

    throw new AIError(statusToKind(status, `${code ?? ''} ${message ?? ''}`), {
      status,
      detail: sanitizeDetail(message, secrets),
    })
  }

  let json: unknown

  try {
    json = JSON.parse(body)
  } catch {
    throw new AIError('invalid_response', { status })
  }

  const choice = isRecord(json) && Array.isArray(json.choices) ? json.choices[0] : undefined
  const message = isRecord(choice) ? choice.message : undefined
  const content = isRecord(message) ? message.content : undefined

  if (typeof content !== 'string' || !content.trim()) {
    throw new AIError('invalid_response', {
      status,
      detail: sanitizeDetail(extractServerError(body).message, secrets),
    })
  }

  const finishReason = isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : null

  return {
    content: content.trim(),
    finishReason,
    truncated: finishReason === 'length',
  }
}

export function classifyTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  if (/not allowed/i.test(message)) return new AIError('scope_denied')
  if (/request cancel/i.test(message)) return new AIError('cancelled')
  if (/timed? ?out/i.test(message)) return new AIError('timeout')
  if (/certificate|tls|ssl|handshake/i.test(message)) return new AIError('network', { detail: 'tls' })
  if (/dns|resolve|lookup|nodename|name or service/i.test(message)) return new AIError('network', { detail: 'dns' })

  return new AIError('network', { detail: 'connect' })
}

export interface AITransportInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal: AbortSignal
  maxRedirections: number
  connectTimeout: number
}

export interface AITransportResponse {
  status: number
  text: () => Promise<string>
}

export type AITransport = (url: string, init: AITransportInit) => Promise<AITransportResponse>

export const tauriTransport: AITransport = (url, init) => tauriFetch(url, init)

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AIError('cancelled'))

    if (signal.aborted) onAbort()

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export interface ChatOnceParams {
  baseURL: string
  model: string
  apiKey: string
  messages: AITransportMessage[]
  timeoutMs: number
  signal?: AbortSignal
}

export async function chatOnce(params: ChatOnceParams, transport: AITransport = tauriTransport): Promise<ChatOnceResult> {
  const { baseURL, model, apiKey, messages, timeoutMs, signal } = params

  if (!apiKey) throw new AIError('missing_key')

  if (signal?.aborted) throw new AIError('cancelled')

  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onAbort = () => controller.abort()

  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await raceAbort(transport(buildChatCompletionsURL(baseURL), {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
      maxRedirections: 0,
      connectTimeout: Math.min(timeoutMs, 15000),
    }), controller.signal)

    const body = await raceAbort(response.text(), controller.signal)

    return parseChatResponse(response.status, body, [apiKey])
  } catch (error) {
    if (controller.signal.aborted) throw new AIError(timedOut ? 'timeout' : 'cancelled')

    if (error instanceof AIError) throw error

    throw classifyTransportError(error)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export interface ConnectionTestResult {
  reply: string
  truncated: boolean
  elapsedMs: number
}

export async function testConnection(
  params: { config: AIConfig, apiKey: string, signal?: AbortSignal },
  transport: AITransport = tauriTransport,
): Promise<ConnectionTestResult> {
  const { config, apiKey, signal } = params
  const startedAt = Date.now()

  const result = await chatOnce({
    baseURL: config.baseURL,
    model: config.model,
    apiKey,
    timeoutMs: config.timeoutMs,
    signal,
    messages: [{ role: 'user', content: CONNECTION_TEST_PROMPT }],
  }, transport)

  return {
    reply: result.content.slice(0, 120),
    truncated: result.truncated,
    elapsedMs: Date.now() - startedAt,
  }
}
