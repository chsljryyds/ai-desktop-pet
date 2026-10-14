import type { AITransportMessage } from '@/types/ai'
import type { ChatMessage, SendResult } from '@/types/chat'

/**
 * Keeps a draft the user typed while a request was in flight.
 * An early cancel restores the original text only when the input is still empty
 * and the question never became a message. Callers must also check that this
 * send still owns the input generation; an empty box alone is not enough.
 */
export function nextInputDraft(result: SendResult, currentInput: string, original: string) {
  if (currentInput.length > 0) return currentInput

  if (result.ok || result.reason === 'busy' || result.reason === 'stale') return ''

  if (result.reason === 'cancelled') return result.restoreDraft ? original : ''

  return original
}

export function shouldSubmitOnEnter(event: { key: string, shiftKey: boolean, isComposing: boolean, keyCode?: number }) {
  if (event.key !== 'Enter' || event.shiftKey) return false

  if (event.isComposing || event.keyCode === 229) return false

  return true
}

/**
 * Owns one input box across sends. Each submit takes a generation.
 * A later submit, typed draft, or invalidate() makes the old submit unable to write.
 */
export function createChatComposer(io: { read: () => string, write: (value: string) => void }) {
  let generation = 0

  function invalidate() {
    generation += 1
  }

  async function submit(
    dispatch: (text: string, restoreDraft: () => void) => Promise<SendResult>,
    onSettled?: (result: SendResult) => void,
  ) {
    const text = io.read()

    if (!text.trim()) return

    const owned = ++generation

    io.write('')

    let consumed = false

    const restoreDraft = () => {
      if (consumed || generation !== owned || io.read().length > 0) return

      consumed = true
      io.write(text)
    }

    const result = await dispatch(text, restoreDraft)

    if (generation === owned) onSettled?.(result)

    if (!consumed && generation === owned && io.read().length === 0) {
      io.write(nextInputDraft(result, '', text))
    }

    return result
  }

  return { submit, invalidate }
}

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
