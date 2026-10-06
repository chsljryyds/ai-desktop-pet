import type { AIErrorInfo } from './ai'

export type MessageStatus = 'pending' | 'complete' | 'failed' | 'cancelled'

export interface ChatMessage {
  id: string
  petId: string
  conversationId: string
  turnId: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  createdAt: string
  /** Present on a failed user message; always sanitized. */
  error?: AIErrorInfo
  /** The provider reported `finish_reason: length`. */
  truncated?: boolean
}

export type SendResult
  = | { ok: true }
    | { ok: false, reason: 'empty' | 'busy' | 'not_ready' | 'stale' }
    | { ok: false, reason: 'error', error: AIErrorInfo }
