export interface AIConfig {
  schemaVersion: 1
  baseURL: string
  model: string
  timeoutMs: number
  maxContextRounds: number
}

export type AIConfigField = 'baseURL' | 'model' | 'timeoutMs' | 'maxContextRounds'

export type BaseURLErrorCode
  = | 'empty'
    | 'invalid'
    | 'protocol'
    | 'insecure'
    | 'credentials'
    | 'query_or_hash'
    | 'full_endpoint'
    | 'not_authorized'

export type AIConfigErrorCode
  = | BaseURLErrorCode
    | 'model_empty'
    | 'model_too_long'
    | 'timeout_range'
    | 'rounds_range'

export type AIConfigValidation
  = | { ok: true, config: AIConfig }
    | { ok: false, errors: Partial<Record<AIConfigField, AIConfigErrorCode>> }

export interface AITransportMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AIErrorKind
  = | 'invalid_config'
    | 'missing_key'
    | 'scope_denied'
    | 'unauthorized'
    | 'not_found'
    | 'rate_limited'
    | 'context_too_long'
    | 'server_error'
    | 'http_error'
    | 'network'
    | 'timeout'
    | 'cancelled'
    | 'invalid_response'

export interface AIErrorInfo {
  kind: AIErrorKind
  status?: number
  detail?: string
}

export interface ChatOnceResult {
  content: string
  finishReason: string | null
  truncated: boolean
}

export interface AIKeyStatus {
  configured: boolean
  baseUrl: string | null
}
