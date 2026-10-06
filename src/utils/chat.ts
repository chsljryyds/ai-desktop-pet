import type { AITransportMessage } from '@/types/ai'
import type { ChatMessage } from '@/types/chat'

interface BuildContextOptions {
  systemPrompt: string
  messages: readonly ChatMessage[]
  currentTurnId: string
  maxRounds: number
}

/**
 * system prompt + last N fully completed (user, assistant) rounds + the current question once.
 * Failed / cancelled / pending turns never enter the context.
 */
export function buildContext(options: BuildContextOptions): AITransportMessage[] {
  const { systemPrompt, messages, currentTurnId, maxRounds } = options

  const rounds: Array<[ChatMessage, ChatMessage]> = []
  const users = new Map<string, ChatMessage>()

  for (const message of messages) {
    if (message.turnId === currentTurnId || message.status !== 'complete') continue

    if (message.role === 'user') {
      users.set(message.turnId, message)

      continue
    }

    const user = users.get(message.turnId)

    if (user) rounds.push([user, message])
  }

  const current = messages.find(message => message.turnId === currentTurnId && message.role === 'user')

  const result: AITransportMessage[] = []

  if (systemPrompt.trim()) result.push({ role: 'system', content: systemPrompt })

  const recent = maxRounds > 0 ? rounds.slice(-maxRounds) : []

  for (const [user, assistant] of recent) {
    result.push({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content })
  }

  if (current) result.push({ role: 'user', content: current.content })

  return result
}
