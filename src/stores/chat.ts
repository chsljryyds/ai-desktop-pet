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

  interface RequestRun {
    version: number
    controller: AbortController
    cancelled: boolean
    userMessageId: string | null
    /** Called once, synchronously, when cancel happens before a message exists. */
    onCancelDraft?: () => void
  }

  let active: RequestRun | null = null
  let sessionVersion = 0

  const findMessage = (id: string) => messages.value.find(item => item.id === id)

  function isCurrent(run: RequestRun) {
    return active === run && !run.cancelled && run.version === sessionVersion
  }

  function takeSnapshot(): { ok: true, config: AIConfig, pet: PetSnapshot } | { ok: false, result: SendResult } {
    const profile = petStore.profile

    if (!profile) return { ok: false, result: { ok: false, reason: 'not_ready' } }

    const validation = validateAIConfig(aiStore.config)

    if (!validation.ok) return { ok: false, result: { ok: false, reason: 'error', error: { kind: 'invalid_config' } } }

    const pet: PetSnapshot = { id: profile.id, name: profile.name, personality: profile.personality }

    return { ok: true, config: { ...validation.config }, pet }
  }

  function begin(): RequestRun {
    const run: RequestRun = {
      version: sessionVersion,
      controller: new AbortController(),
      cancelled: false,
      userMessageId: null,
    }

    active = run
    sending.value = true

    return run
  }

  function finish(run: RequestRun) {
    if (active !== run) return

    active = null
    sending.value = false
  }

  function cancelledResult(run: RequestRun): SendResult {
    return { ok: false, reason: 'cancelled', restoreDraft: run.userMessageId === null }
  }

  async function execute(run: RequestRun, params: {
    turnId: string
    userMessageId: string
    config: AIConfig
    pet: PetSnapshot
    apiKey: string
  }) {
    const { turnId, userMessageId, config, pet, apiKey } = params

    if (!isCurrent(run)) return

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
        signal: run.controller.signal,
      })

      if (!isCurrent(run) || run.controller.signal.aborted) return

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
      if (!isCurrent(run) || run.controller.signal.aborted) return

      const info = toAIErrorInfo(error)
      const user = findMessage(userMessageId)

      if (!user) return

      user.status = info.kind === 'cancelled' ? 'cancelled' : 'failed'
      user.error = info.kind === 'cancelled' ? void 0 : info
    }
  }

  async function send(text: string, hooks?: { onCancelDraft?: () => void }): Promise<SendResult> {
    const content = text.trim()

    if (!content) return { ok: false, reason: 'empty' }

    if (active) return { ok: false, reason: 'busy' }

    const snapshot = takeSnapshot()

    if (!snapshot.ok) return snapshot.result

    const { config, pet } = snapshot
    const run = begin()

    run.onCancelDraft = hooks?.onCancelDraft

    try {
      const apiKey = await getAIKey(config.baseURL)

      if (run.version !== sessionVersion) return { ok: false, reason: 'stale' }

      if (!isCurrent(run)) return cancelledResult(run)

      if (!apiKey) return { ok: false, reason: 'error', error: { kind: 'missing_key' } }

      const turnId = nanoid()
      const userMessageId = nanoid()

      run.userMessageId = userMessageId

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

      await execute(run, { turnId, userMessageId, config, pet, apiKey })

      if (run.version !== sessionVersion) return { ok: false, reason: 'stale' }

      if (run.cancelled || !isCurrent(run)) return cancelledResult(run)

      return { ok: true }
    } catch (error) {
      if (run.version !== sessionVersion) return { ok: false, reason: 'stale' }

      if (!isCurrent(run)) return cancelledResult(run)

      return { ok: false, reason: 'error', error: toAIErrorInfo(error) }
    } finally {
      finish(run)
    }
  }

  async function retry(userMessageId: string): Promise<SendResult> {
    if (active) return { ok: false, reason: 'busy' }

    const user = findMessage(userMessageId)

    if (!user || user.role !== 'user' || (user.status !== 'failed' && user.status !== 'cancelled')) {
      return { ok: false, reason: 'stale' }
    }

    const snapshot = takeSnapshot()

    if (!snapshot.ok) return snapshot.result

    const { config, pet } = snapshot
    const run = begin()

    run.userMessageId = user.id
    user.status = 'pending'
    user.error = void 0

    try {
      const apiKey = await getAIKey(config.baseURL)

      if (run.version !== sessionVersion) return { ok: false, reason: 'stale' }

      if (!isCurrent(run)) return cancelledResult(run)

      if (!apiKey) {
        user.status = 'failed'
        user.error = { kind: 'missing_key' }

        return { ok: false, reason: 'error', error: user.error }
      }

      await execute(run, { turnId: user.turnId, userMessageId, config, pet, apiKey })

      if (run.version !== sessionVersion) return { ok: false, reason: 'stale' }

      if (run.cancelled || !isCurrent(run)) return cancelledResult(run)

      return { ok: true }
    } catch (error) {
      if (run.version !== sessionVersion) return { ok: false, reason: 'stale' }

      if (!isCurrent(run)) return cancelledResult(run)

      user.status = 'failed'
      user.error = toAIErrorInfo(error)

      return { ok: false, reason: 'error', error: user.error }
    } finally {
      finish(run)
    }
  }

  function cancel() {
    const run = active

    if (!run) return

    run.cancelled = true
    run.controller.abort()

    if (run.userMessageId) {
      const user = findMessage(run.userMessageId)

      if (user?.status === 'pending') {
        user.status = 'cancelled'
        user.error = void 0
      }
    }

    const restoreDraft = run.userMessageId ? undefined : run.onCancelDraft

    run.onCancelDraft = undefined

    if (active === run) {
      active = null
      sending.value = false
    }

    restoreDraft?.()
  }

  function clear() {
    sessionVersion++

    if (active) {
      active.cancelled = true
      active.controller.abort()
    }

    active = null
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
