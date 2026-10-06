import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { AIConfig } from '@/types/ai'
import type { ChatMessage, SendResult } from '@/types/chat'
import type { PetProfile } from '@/types/pet'

import { i18n } from '@/locales'
import { chatOnce, toAIErrorInfo, validateAIConfig } from '@/utils/ai'
import { getAIKey } from '@/utils/ai-secret'
import { buildContext } from '@/utils/chat'

import { useAIStore } from './ai'
import { usePetStore } from './pet'

type PetSnapshot = Pick<PetProfile, 'id' | 'name' | 'personality'>

export function buildSystemPrompt(pet: Pick<PetProfile, 'name' | 'personality'>) {
  return i18n.global.t('stores.chat.systemPrompt', { name: pet.name, personality: pet.personality })
}

/**
 * Chat messages live in this window's memory only: never started, never saved, never synced.
 * Request runtime state (ids, controller, session version) is closure-private and not serializable.
 */
export const useChatStore = defineStore('chat', () => {
  const aiStore = useAIStore()
  const petStore = usePetStore()

  const messages = ref<ChatMessage[]>([])
  const conversationId = ref(nanoid())
  const sending = ref(false)

  let activeRequestId: string | null = null
  let controller: AbortController | null = null
  let sessionVersion = 0

  const findMessage = (id: string) => messages.value.find(item => item.id === id)

  function takeSnapshot(): { ok: true, config: AIConfig, pet: PetSnapshot } | { ok: false, result: SendResult } {
    const profile = petStore.profile

    if (!profile) return { ok: false, result: { ok: false, reason: 'not_ready' } }

    const validation = validateAIConfig(aiStore.config)

    if (!validation.ok) return { ok: false, result: { ok: false, reason: 'error', error: { kind: 'invalid_config' } } }

    const pet: PetSnapshot = { id: profile.id, name: profile.name, personality: profile.personality }

    return { ok: true, config: { ...validation.config }, pet }
  }

  function begin() {
    const requestId = nanoid()

    activeRequestId = requestId
    sending.value = true

    return { requestId, version: sessionVersion }
  }

  function isStale(requestId: string, version: number) {
    return version !== sessionVersion || activeRequestId !== requestId
  }

  function finish(requestId: string) {
    if (activeRequestId !== requestId) return

    activeRequestId = null
    controller = null
    sending.value = false
  }

  async function execute(params: {
    turnId: string
    userMessageId: string
    requestId: string
    version: number
    config: AIConfig
    pet: PetSnapshot
    apiKey: string
  }) {
    const { turnId, userMessageId, requestId, version, config, pet, apiKey } = params

    const requestController = new AbortController()

    controller = requestController

    const context = buildContext({
      systemPrompt: buildSystemPrompt(pet),
      messages: messages.value,
      currentTurnId: turnId,
      maxRounds: config.maxContextRounds,
    })

    try {
      const result = await chatOnce({
        baseURL: config.baseURL,
        model: config.model,
        apiKey,
        messages: context,
        timeoutMs: config.timeoutMs,
        signal: requestController.signal,
      })

      if (isStale(requestId, version)) return

      const user = findMessage(userMessageId)

      if (user) user.status = 'complete'

      messages.value.push({
        id: nanoid(),
        petId: pet.id,
        conversationId: conversationId.value,
        turnId,
        role: 'assistant',
        content: result.content,
        status: 'complete',
        createdAt: new Date().toISOString(),
        truncated: result.truncated || void 0,
      })
    } catch (error) {
      if (isStale(requestId, version)) return

      const info = toAIErrorInfo(error)
      const user = findMessage(userMessageId)

      if (!user) return

      user.status = info.kind === 'cancelled' ? 'cancelled' : 'failed'
      user.error = info.kind === 'cancelled' ? void 0 : info
    }
  }

  async function send(text: string): Promise<SendResult> {
    const content = text.trim()

    if (!content) return { ok: false, reason: 'empty' }

    if (activeRequestId) return { ok: false, reason: 'busy' }

    const snapshot = takeSnapshot()

    if (!snapshot.ok) return snapshot.result

    const { config, pet } = snapshot
    const { requestId, version } = begin()

    try {
      const apiKey = await getAIKey(config.baseURL)

      if (isStale(requestId, version)) return { ok: false, reason: 'stale' }

      if (!apiKey) return { ok: false, reason: 'error', error: { kind: 'missing_key' } }

      const turnId = nanoid()
      const userMessageId = nanoid()

      messages.value.push({
        id: userMessageId,
        petId: pet.id,
        conversationId: conversationId.value,
        turnId,
        role: 'user',
        content,
        status: 'pending',
        createdAt: new Date().toISOString(),
      })

      await execute({ turnId, userMessageId, requestId, version, config, pet, apiKey })

      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'error', error: toAIErrorInfo(error) }
    } finally {
      finish(requestId)
    }
  }

  async function retry(userMessageId: string): Promise<SendResult> {
    if (activeRequestId) return { ok: false, reason: 'busy' }

    const user = findMessage(userMessageId)

    if (!user || user.role !== 'user' || (user.status !== 'failed' && user.status !== 'cancelled')) {
      return { ok: false, reason: 'stale' }
    }

    const snapshot = takeSnapshot()

    if (!snapshot.ok) return snapshot.result

    const { config, pet } = snapshot
    const { requestId, version } = begin()

    user.status = 'pending'
    user.error = void 0

    try {
      const apiKey = await getAIKey(config.baseURL)

      if (isStale(requestId, version)) return { ok: false, reason: 'stale' }

      if (!apiKey) {
        user.status = 'failed'
        user.error = { kind: 'missing_key' }

        return { ok: false, reason: 'error', error: user.error }
      }

      await execute({ turnId: user.turnId, userMessageId, requestId, version, config, pet, apiKey })

      return { ok: true }
    } catch (error) {
      if (!isStale(requestId, version)) {
        user.status = 'failed'
        user.error = toAIErrorInfo(error)
      }

      return { ok: false, reason: 'error', error: toAIErrorInfo(error) }
    } finally {
      finish(requestId)
    }
  }

  function cancel() {
    controller?.abort()
  }

  function clear() {
    sessionVersion++
    controller?.abort()
    activeRequestId = null
    controller = null
    sending.value = false
    messages.value = []
    conversationId.value = nanoid()
  }

  return {
    messages,
    conversationId,
    sending,
    send,
    retry,
    cancel,
    clear,
  }
}, {
  tauri: {
    save: false,
    sync: false,
    saveOnChange: false,
    saveOnExit: false,
  },
})
