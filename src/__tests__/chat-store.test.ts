import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAIStore } from '@/stores/ai'
import { useChatStore } from '@/stores/chat'
import { usePetStore } from '@/stores/pet'
import { nextInputDraft } from '@/utils/chat'

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

interface KeyGate {
  resolve: (value: string | null) => void
  reject: (reason?: unknown) => void
}

function deferKey() {
  const gates: KeyGate[] = []

  secret.getAIKey.mockImplementation(() => {
    let resolve!: KeyGate['resolve']
    let reject!: KeyGate['reject']
    const promise = new Promise<string | null>((res, rej) => {
      resolve = res
      reject = rej
    })

    gates.push({ resolve, reject })

    return promise
  })

  return gates
}

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

describe('cancel during key lookup', () => {
  it('cancels a first send before the key returns and does not call the client', async () => {
    const keys = deferKey()
    const { chat } = setup()
    const pending = chat.send('你好')

    await flush()
    expect(chat.sending).toBe(true)

    chat.cancel()

    expect(chat.sending).toBe(false)
    expect(chat.messages).toHaveLength(0)

    keys[0].resolve(KEY)

    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled', restoreDraft: true })
    expect(http.fetch).not.toHaveBeenCalled()
    expect(chat.messages).toHaveLength(0)
    expect(chat.sending).toBe(false)
  })

  it('cancels a retry before the key returns without duplicating the question', async () => {
    const { chat } = setup()
    const failedSend = chat.send('question')

    ;(await waitForCall(0)).resolve('boom', 500)
    await failedSend

    const user = chat.messages[0]
    const keys = deferKey()
    const retry = chat.retry(user.id)

    await flush()
    expect(chat.sending).toBe(true)
    expect(chat.messages).toHaveLength(1)

    chat.cancel()
    keys[0].resolve(KEY)

    await expect(retry).resolves.toEqual({ ok: false, reason: 'cancelled', restoreDraft: false })
    expect(http.fetch).toHaveBeenCalledTimes(1)
    expect(chat.messages).toMatchObject([{ id: user.id, turnId: user.turnId, status: 'cancelled' }])
    expect(chat.sending).toBe(false)
  })

  it('does not stay loading when the old key never returns', async () => {
    const keys = deferKey()
    const { chat } = setup()
    const abandoned = chat.send('old')

    await flush()
    chat.cancel()

    expect(chat.sending).toBe(false)

    const next = chat.send('new')

    expect(chat.sending).toBe(true)
    keys[1].resolve(KEY)
    ;(await waitForCall(0)).resolve('answer')

    await expect(next).resolves.toEqual({ ok: true })
    expect(chat.messages.map(item => item.content)).toEqual(['new', 'answer'])

    keys[0].resolve(KEY)
    await expect(abandoned).resolves.toEqual({ ok: false, reason: 'cancelled', restoreDraft: true })
    expect(chat.messages.map(item => item.content)).toEqual(['new', 'answer'])
    expect(chat.sending).toBe(false)
  })

  it('ignores a late key rejection', async () => {
    const keys = deferKey()
    const { chat } = setup()
    const pending = chat.send('你好')

    await flush()
    chat.cancel()
    keys[0].reject(new Error('key lookup failed'))

    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled', restoreDraft: true })
    expect(chat.messages).toHaveLength(0)
    expect(chat.sending).toBe(false)
  })

  it('keeps a newer request when the old key and old reply arrive late', async () => {
    const keys = deferKey()
    const { chat } = setup()
    const old = chat.send('old')

    await flush()
    chat.cancel()

    const fresh = chat.send('new')

    keys[0].resolve(KEY)
    keys[1].resolve(KEY)

    const call = await waitForCall(0)

    expect(call.body.messages.at(-1)?.content).toBe('new')
    expect(http.fetch).toHaveBeenCalledTimes(1)

    call.resolve('new answer')
    await fresh
    await old

    expect(chat.messages.map(item => item.content)).toEqual(['new', 'new answer'])
    expect(chat.sending).toBe(false)
  })

  it('does not show a reply when the transport ignores abort', async () => {
    http.fetch.mockImplementation(() => {
      return new Promise((resolvePromise) => {
        calls.push({
          url: '',
          body: { model: '', messages: [] },
          signal: new AbortController().signal,
          resolve: content => resolvePromise({
            status: 200,
            text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
          }),
        })
      })
    })

    const { chat } = setup()
    const pending = chat.send('slow')
    const call = await waitForCall(0)

    chat.cancel()
    call.resolve('late reply')
    await pending

    expect(chat.messages).toMatchObject([{ role: 'user', status: 'cancelled' }])
    expect(chat.messages.some(item => item.role === 'assistant')).toBe(false)
  })

  it('drops an old key result after the session is cleared', async () => {
    const keys = deferKey()
    const { chat } = setup()
    const old = chat.send('old')

    await flush()
    chat.clear()

    const fresh = chat.send('new')

    keys[0].reject(new Error('old key failed'))
    keys[1].resolve(KEY)
    ;(await waitForCall(0)).resolve('new answer')
    await fresh
    await old

    expect(chat.messages.map(item => item.content)).toEqual(['new', 'new answer'])
    expect(chat.sending).toBe(false)
  })

  it('treats repeated and empty cancels as no-ops', async () => {
    const { chat } = setup()

    chat.cancel()
    chat.cancel()

    const pending = chat.send('hello')
    const call = await waitForCall(0)

    chat.cancel()
    chat.cancel()
    call.resolve('late')
    await pending

    expect(chat.messages).toMatchObject([{ role: 'user', content: 'hello', status: 'cancelled' }])

    const next = chat.send('again')

    ;(await waitForCall(1)).resolve('ok')
    await next

    expect(chat.messages.map(item => [item.role, item.content])).toEqual([
      ['user', 'hello'],
      ['user', 'again'],
      ['assistant', 'ok'],
    ])
    expect(chat.sending).toBe(false)
  })
})

describe('draft restore', () => {
  it('restores an early-cancelled question only when the input is still empty', () => {
    const cancelled = { ok: false, reason: 'cancelled', restoreDraft: true } as const

    expect(nextInputDraft(cancelled, '', '你好')).toBe('你好')
    expect(nextInputDraft(cancelled, '新的草稿', '你好')).toBe('新的草稿')
    expect(nextInputDraft({ ok: false, reason: 'cancelled', restoreDraft: false }, '', '你好')).toBe('')
    expect(nextInputDraft({ ok: false, reason: 'error', error: { kind: 'missing_key' } }, '', '你好')).toBe('你好')
    expect(nextInputDraft({ ok: true }, '已经在打', '你好')).toBe('已经在打')
  })
})

describe('chat window lifecycle', () => {
  it('hides the window without cancelling, and cancels only when the page is destroyed', () => {
    const source = readFileSync(resolve(__dirname, '../pages/chat/index.vue'), 'utf8')

    expect(source).toMatch(/function handleClose\(\) \{\s*hideWindow\(WINDOW_LABEL\.CHAT\)\s*\}/)
    expect(source).toMatch(/onUnmounted\(\(\) => \{\s*chatStore\.cancel\(\)\s*\}/)
    expect(source).not.toMatch(/function handleClose\(\) \{[^}]*chatStore\.cancel/)
  })
})
