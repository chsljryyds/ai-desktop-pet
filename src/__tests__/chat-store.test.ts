import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAIStore } from '@/stores/ai'
import { useChatStore } from '@/stores/chat'
import { usePetStore } from '@/stores/pet'

const KEY = 'sk-chat-store-secret-0000000'
const BASE = 'http://127.0.0.1:18080/v1'

const http = vi.hoisted(() => ({ fetch: vi.fn() }))
const secret = vi.hoisted(() => ({ getAIKey: vi.fn() }))

vi.mock('@tauri-apps/plugin-http', () => http)
vi.mock('@/utils/ai-secret', () => secret)
vi.mock('@/locales', () => ({
  i18n: { global: { t: (_: string, params: { name: string, personality: string }) => `NAME=${params.name};${params.personality}` } },
}))

interface Deferred {
  url: string
  body: { model: string, messages: Array<{ role: string, content: string }> }
  signal: AbortSignal
  resolve: (content: string, status?: number) => void
}

let calls: Deferred[] = []

function respondLater() {
  http.fetch.mockImplementation((url: string, init: { body: string, signal: AbortSignal }) => {
    return new Promise((resolvePromise, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Request cancelled')))

      calls.push({
        url,
        body: JSON.parse(init.body),
        signal: init.signal,
        resolve: (content, status = 200) => resolvePromise({
          status,
          text: async () => JSON.stringify(status === 200 ? { choices: [{ message: { content }, finish_reason: 'stop' }] } : { error: { message: content } }),
        }),
      })
    })
  })
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function waitForCall(index: number) {
  for (let attempt = 0; attempt < 50 && !calls[index]; attempt++) await flush()

  return calls[index]
}

function setup() {
  setActivePinia(createPinia())

  const ai = useAIStore()
  const pet = usePetStore()

  ai.save({ schemaVersion: 1, baseURL: BASE, model: 'model-a', timeoutMs: 60000, maxContextRounds: 10 })
  pet.ensureDefault({ name: '小咪', personality: '温和' })

  return { ai, pet, chat: useChatStore() }
}

beforeEach(() => {
  calls = []
  http.fetch.mockReset()
  secret.getAIKey.mockReset()
  secret.getAIKey.mockImplementation(async (baseURL: string) => baseURL === BASE ? KEY : null)
  respondLater()
})

// U04 防重复与重试
describe('send guard and retry', () => {
  it('a double click sends only one request', async () => {
    const { chat } = setup()

    const first = chat.send('hello')
    const second = await chat.send('hello')

    expect(second).toEqual({ ok: false, reason: 'busy' })

    ;(await waitForCall(0)).resolve('hi')

    expect(await first).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(chat.messages.filter(item => item.role === 'user')).toHaveLength(1)
    expect(chat.sending).toBe(false)
  })

  it('retry reuses the turn and does not duplicate the user message', async () => {
    const { chat } = setup()

    const pending = chat.send('question')

    ;(await waitForCall(0)).resolve('boom', 500)
    await pending

    const failed = chat.messages[0]

    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'server_error', status: 500 } })

    const retry = chat.retry(failed.id)

    ;(await waitForCall(1)).resolve('answer')

    expect(await retry).toEqual({ ok: true })
    expect(chat.messages.map(item => [item.role, item.status, item.turnId])).toEqual([
      ['user', 'complete', failed.turnId],
      ['assistant', 'complete', failed.turnId],
    ])
    expect(calls[1].body.messages.filter(item => item.content === 'question')).toHaveLength(1)
  })

  it('a missing key blocks sending without appending a message', async () => {
    const { chat, ai } = setup()

    ai.config.baseURL = 'http://localhost:18080/v1'

    expect(await chat.send('hi')).toEqual({ ok: false, reason: 'error', error: { kind: 'missing_key' } })
    expect(chat.messages).toHaveLength(0)
    expect(http.fetch).not.toHaveBeenCalled()
  })

  it('an invalid config blocks sending', async () => {
    const { chat, ai } = setup()

    ai.config.model = ''

    expect(await chat.send('hi')).toEqual({ ok: false, reason: 'error', error: { kind: 'invalid_config' } })
    expect(secret.getAIKey).not.toHaveBeenCalled()
  })
})

// U05 取消与清空
describe('cancel and clear', () => {
  it('cancel aborts the transport and marks the turn cancelled', async () => {
    const { chat } = setup()

    const pending = chat.send('slow')
    const call = await waitForCall(0)

    chat.cancel()
    await pending

    expect(call.signal.aborted).toBe(true)
    expect(chat.messages).toMatchObject([{ role: 'user', status: 'cancelled' }])
    expect(chat.sending).toBe(false)

    call.resolve('late')
    await flush()

    expect(chat.messages).toHaveLength(1)
  })

  it('a stale request cannot write into a cleared session or reset the new request', async () => {
    const { chat } = setup()

    const old = chat.send('old')
    const oldCall = await waitForCall(0)
    const conversationId = chat.conversationId

    chat.clear()

    expect(chat.messages).toHaveLength(0)
    expect(chat.conversationId).not.toBe(conversationId)
    expect(oldCall.signal.aborted).toBe(true)

    const fresh = chat.send('new')
    const freshCall = await waitForCall(1)

    await old

    expect(chat.sending).toBe(true)

    oldCall.resolve('old answer')
    freshCall.resolve('new answer')
    await fresh

    expect(chat.messages.map(item => item.content)).toEqual(['new', 'new answer'])
    expect(chat.messages.every(item => item.conversationId === chat.conversationId)).toBe(true)
  })
})

// U06 配置快照
describe('config snapshot', () => {
  it('changing settings mid-request does not alter the in-flight request', async () => {
    const { chat, ai, pet } = setup()

    const pending = chat.send('first')
    const call = await waitForCall(0)

    ai.config.model = 'model-b'
    ai.config.maxContextRounds = 1
    pet.update({ name: '新名字', personality: '活泼' })

    call.resolve('done')
    await pending

    expect(call.body.model).toBe('model-a')
    expect(call.body.messages[0].content).toBe('NAME=小咪;温和')

    const next = chat.send('second')
    const nextCall = await waitForCall(1)

    nextCall.resolve('ok')
    await next

    expect(nextCall.body.model).toBe('model-b')
    expect(nextCall.body.messages[0].content).toBe('NAME=新名字;活泼')
  })
})

// U08 隐私边界（会话状态部分）
describe('serializable state', () => {
  it('contains no key, authorization, controller or promise', async () => {
    const { chat } = setup()

    const pending = chat.send('hello')
    const call = await waitForCall(0)
    const inFlight = JSON.stringify(chat.$state)

    call.resolve('hi')
    await pending

    for (const state of [inFlight, JSON.stringify(chat.$state)]) {
      expect(state).not.toContain(KEY)
      expect(state).not.toContain('Bearer')
      expect(state).not.toMatch(/signal|controller|requestId|Promise/i)
    }

    expect(Object.keys(chat.$state).sort()).toEqual(['conversationId', 'messages', 'sending'])
  })
})
