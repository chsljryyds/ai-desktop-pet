import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAIStore } from '@/stores/ai'
import { useChatStore } from '@/stores/chat'
import { usePetStore } from '@/stores/pet'
import { createChatComposer, shouldSubmitOnEnter } from '@/utils/chat'

const KEY = 'sk-chat-store-secret-0000000'
const BASE = 'http://127.0.0.1:18080/v1'

const http = vi.hoisted(() => ({ fetch: vi.fn() }))
const secret = vi.hoisted(() => ({ getAIKey: vi.fn() }))

vi.mock('@tauri-apps/plugin-http', () => http)
vi.mock('@/utils/ai-secret', () => secret)
vi.mock('@/locales', () => ({
  i18n: { global: { t: (_key: string, params: { name: string, personality: string }) => `NAME=${params.name};${params.personality}` } },
}))

interface KeyGate {
  resolve: (value: string | null) => void
  reject: (reason?: unknown) => void
}

interface Deferred {
  body: { messages: Array<{ content: string }> }
  resolve: (content: string, status?: number) => void
}

let calls: Deferred[] = []

function respondLater() {
  http.fetch.mockImplementation((_url: string, init: { body: string, signal: AbortSignal }) => {
    return new Promise((resolvePromise, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Request cancelled')))

      calls.push({
        body: JSON.parse(init.body),
        resolve: (content, status = 200) => resolvePromise({
          status,
          text: async () => JSON.stringify(status === 200
            ? { choices: [{ message: { content }, finish_reason: 'stop' }] }
            : { error: { message: content } }),
        }),
      })
    })
  })
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

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

  const input = { value: '' }
  const composer = createChatComposer({
    read: () => input.value,
    write: (value) => {
      input.value = value
    },
  })

  return { chat: useChatStore(), input, composer }
}

beforeEach(() => {
  calls = []
  http.fetch.mockReset()
  secret.getAIKey.mockReset()
  respondLater()
})

describe('chat composer and store', () => {
  it('t01 restores the unsent question as soon as cancel happens, without the key', async () => {
    const keys = deferKey()
    const { chat, input, composer } = setup()

    input.value = '问题A'

    const pending = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    await flush()
    expect(chat.sending).toBe(true)
    expect(input.value).toBe('')

    chat.cancel()

    expect(chat.sending).toBe(false)
    expect(input.value).toBe('问题A')
    expect(keys[0]).toBeTruthy()
    expect(http.fetch).not.toHaveBeenCalled()

    await Promise.race([pending, flush()])
    expect(input.value).toBe('问题A')
  })

  it('t02 keeps text the user typed before cancelling', async () => {
    const keys = deferKey()
    const { chat, input, composer } = setup()

    input.value = '问题A'
    const pending = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    await flush()
    input.value = '新草稿'
    chat.cancel()
    keys[0].resolve(KEY)
    await pending

    expect(input.value).toBe('新草稿')
    expect(chat.messages).toHaveLength(0)
  })

  it('t03 does not restore A after B has been sent and completed', async () => {
    const keys = deferKey()
    const { chat, input, composer } = setup()

    input.value = '问题A'
    const pendingA = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    await flush()
    chat.cancel()
    expect(input.value).toBe('问题A')

    input.value = '问题B'
    const pendingB = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    await flush()
    keys[1].resolve(KEY)
    ;(await waitForCall(0)).resolve('回答B')
    await pendingB

    expect(input.value).toBe('')
    expect(chat.messages.map(item => item.content)).toEqual(['问题B', '回答B'])

    keys[0].resolve(KEY)
    await pendingA

    expect(input.value).toBe('')
    expect(chat.messages.map(item => item.content)).toEqual(['问题B', '回答B'])
    expect(chat.sending).toBe(false)
  })

  it('t04 does not restore A after the session is cleared', async () => {
    const keys = deferKey()
    const { chat, input, composer } = setup()

    input.value = '问题A'
    const pending = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    await flush()
    chat.cancel()
    expect(input.value).toBe('问题A')

    composer.invalidate()
    chat.clear()
    input.value = ''
    keys[0].resolve(KEY)
    await pending

    expect(input.value).toBe('')
    expect(chat.messages).toHaveLength(0)
    expect(chat.sending).toBe(false)
  })

  it('t05 ignores a rejected key after cancel', async () => {
    const keys = deferKey()
    const { chat, input, composer } = setup()
    let notice = ''

    input.value = '问题A'
    const pending = composer.submit(
      (text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }),
      (result) => {
        if (!result.ok && result.reason === 'error') notice = result.error.kind
      },
    )

    await flush()
    chat.cancel()
    keys[0].reject(new Error('key lookup failed'))
    await pending

    expect(notice).toBe('')
    expect(input.value).toBe('问题A')
    expect(chat.messages).toHaveLength(0)
    expect(chat.sending).toBe(false)
    expect(http.fetch).not.toHaveBeenCalled()
  })

  it('t06 marks an in-flight HTTP turn cancelled and hides a late reply', async () => {
    secret.getAIKey.mockImplementation(async () => KEY)
    const { chat, input, composer } = setup()

    input.value = '问题A'
    const pending = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))
    const call = await waitForCall(0)

    chat.cancel()
    call.resolve('迟到的回复')
    await pending

    expect(chat.messages).toMatchObject([{ role: 'user', content: '问题A', status: 'cancelled' }])
    expect(chat.messages.some(item => item.role === 'assistant')).toBe(false)
    expect(input.value).toBe('')
  })

  it('t07 cancels a retry without copying the question or sending again', async () => {
    secret.getAIKey.mockImplementation(async () => KEY)
    const { chat, input, composer } = setup()

    input.value = '问题A'
    const failed = composer.submit(text => chat.send(text))

    ;(await waitForCall(0)).resolve('boom', 500)
    await failed

    const keys = deferKey()
    const user = chat.messages[0]
    const retry = chat.retry(user.id)

    await flush()
    chat.cancel()
    keys[0].resolve(KEY)
    await retry

    expect(http.fetch).toHaveBeenCalledTimes(1)
    expect(chat.messages).toMatchObject([{ id: user.id, content: '问题A', status: 'cancelled' }])
    expect(input.value).toBe('')
  })

  it('t08 lets the new request finish after the old key returns', async () => {
    const keys = deferKey()
    const { chat, input, composer } = setup()

    input.value = '问题A'
    const pendingA = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    await flush()
    chat.cancel()
    input.value = '问题B'

    const pendingB = composer.submit((text, restoreDraft) => chat.send(text, { onCancelDraft: restoreDraft }))

    keys[0].resolve(KEY)
    await pendingA
    expect(chat.sending).toBe(true)

    await flush()
    keys[1].resolve(KEY)
    ;(await waitForCall(0)).resolve('回答B')
    await pendingB

    expect(chat.messages.map(item => item.content)).toEqual(['问题B', '回答B'])
    expect(chat.sending).toBe(false)
    expect(input.value).toBe('')
  })
})

describe('chat window lifecycle and enter key', () => {
  it('t09 hides the window without cancelling and keeps the page mounted', () => {
    const source = readFileSync(resolve(__dirname, '../pages/chat/index.vue'), 'utf8')

    expect(source).toMatch(/function handleClose\(\) \{\s*hideWindow\(WINDOW_LABEL\.CHAT\)\s*\}/)
    expect(source).toMatch(/onUnmounted\(\(\) => \{\s*chatStore\.cancel\(\)\s*\}/)
    expect(source).not.toMatch(/function handleClose\(\) \{[^}]*chatStore\.cancel/)
    expect(source).toMatch(/function handleClear\(\) \{\s*composer\.invalidate\(\)\s*chatStore\.clear\(\)\s*\}/)
  })

  it('t10 sends on Enter and keeps IME and Shift+Enter as newlines', () => {
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false)
    expect(shouldSubmitOnEnter({ key: 'a', shiftKey: false, isComposing: false })).toBe(false)

    const source = readFileSync(resolve(__dirname, '../pages/chat/index.vue'), 'utf8')

    expect(source).toContain('if (!shouldSubmitOnEnter(event)) return')
  })
})
