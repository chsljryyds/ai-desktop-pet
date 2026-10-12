import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AITransport, AITransportInit } from '@/utils/ai'

import {
  AIError,
  chatOnce,
  classifyTransportError,
  CONNECTION_TEST_PROMPT,
  parseChatResponse,
  sanitizeDetail,
  testConnection,
  toAIErrorInfo,
  validateAIConfig,
} from '@/utils/ai'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

const KEY = 'sk-unit-test-secret-1234567890'
const BASE = 'http://127.0.0.1:18080/v1'

function reply(status: number, body: unknown): AITransport {
  return async () => ({ status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })
}

function completion(content: unknown, finishReason = 'stop') {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] }
}

async function kindOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return toAIErrorInfo(error)
  }

  throw new Error('expected rejection')
}

const params = { baseURL: BASE, model: 'm', apiKey: KEY, timeoutMs: 5000, messages: [{ role: 'user' as const, content: 'hi' }] }

afterEach(() => {
  vi.useRealTimers()
})

// U02 配置与响应校验
describe('validateAIConfig', () => {
  const valid = { schemaVersion: 1 as const, baseURL: `${BASE}/`, model: ' gpt ', timeoutMs: 60000, maxContextRounds: 10 }

  it('normalizes a valid config', () => {
    expect(validateAIConfig(valid)).toEqual({ ok: true, config: { ...valid, baseURL: BASE, model: 'gpt' } })
  })

  it('reports every invalid field', () => {
    const result = validateAIConfig({ baseURL: '', model: '  ', timeoutMs: 1000, maxContextRounds: 0 })

    expect(result).toEqual({
      ok: false,
      errors: { baseURL: 'empty', model: 'model_empty', timeoutMs: 'timeout_range', maxContextRounds: 'rounds_range' },
    })
  })

  it('rejects unauthorized origins, oversized models and non-integers', () => {
    const result = validateAIConfig({ ...valid, baseURL: 'https://api.example.com/v1', model: 'x'.repeat(201), timeoutMs: 6000.5, maxContextRounds: 2.5 })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors).toEqual({
      baseURL: 'not_authorized',
      model: 'model_too_long',
      timeoutMs: 'timeout_range',
      maxContextRounds: 'rounds_range',
    })
  })
})

describe('parseChatResponse', () => {
  it('returns trimmed content and finish reason', () => {
    expect(parseChatResponse(200, JSON.stringify(completion('  hello  ')))).toEqual({ content: 'hello', finishReason: 'stop', truncated: false })
  })

  it('flags truncated replies', () => {
    expect(parseChatResponse(200, JSON.stringify(completion('part', 'length'))).truncated).toBe(true)
  })

  it.each([
    ['non JSON', 'not json'],
    ['HTML', '<html><body>502</body></html>'],
    ['missing choices', JSON.stringify({ id: 'x' })],
    ['empty choices', JSON.stringify({ choices: [] })],
    ['empty content', JSON.stringify(completion('   '))],
    ['non string content', JSON.stringify(completion({ text: 'x' }))],
    ['array root', JSON.stringify([1, 2])],
  ])('%s -> invalid_response', (_, body) => {
    expect(() => parseChatResponse(200, body)).toThrowError(AIError)

    try {
      parseChatResponse(200, body)
    } catch (error) {
      expect((error as AIError).kind).toBe('invalid_response')
    }
  })

  it.each([
    [401, {}, 'unauthorized'],
    [403, {}, 'unauthorized'],
    [404, {}, 'not_found'],
    [408, {}, 'timeout'],
    [413, {}, 'context_too_long'],
    [400, { error: { message: 'maximum context length is 8192 tokens', code: 'context_length_exceeded' } }, 'context_too_long'],
    [400, { error: { message: 'bad request' } }, 'http_error'],
    [429, {}, 'rate_limited'],
    [500, {}, 'server_error'],
    [503, '<html>down</html>', 'server_error'],
    [302, '', 'http_error'],
  ])('status %i -> %s', (status, body, kind) => {
    try {
      parseChatResponse(status as number, typeof body === 'string' ? body : JSON.stringify(body))
      expect.unreachable()
    } catch (error) {
      expect((error as AIError).kind).toBe(kind)
      expect((error as AIError).status).toBe(status)
    }
  })
})

describe('classifyTransportError', () => {
  it.each([
    ['url not allowed on the configured scope: https://x.com', 'scope_denied', undefined],
    ['Request cancelled', 'cancelled', undefined],
    ['operation timed out', 'timeout', undefined],
    ['invalid peer certificate: UnknownIssuer', 'network', 'tls'],
    ['dns error: failed to lookup address information', 'network', 'dns'],
    ['error sending request: Connection refused (os error 61)', 'network', 'connect'],
  ])('%s', (message, kind, detail) => {
    const error = classifyTransportError(new Error(message))

    expect(error.kind).toBe(kind)
    expect(error.detail).toBe(detail)
  })
})

describe('chatOnce', () => {
  it('posts a non-streaming chat completion to {base}/chat/completions', async () => {
    const transport = vi.fn<AITransport>(reply(200, completion('ok')))

    await chatOnce(params, transport)

    const [url, init] = transport.mock.calls[0] as [string, AITransportInit]

    expect(url).toBe(`${BASE}/chat/completions`)
    expect(init.method).toBe('POST')
    expect(init.maxRedirections).toBe(0)
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(init.body)).toEqual({ model: 'm', messages: params.messages, stream: false })
  })

  it('requires a key and does not call the transport without one', async () => {
    const transport = vi.fn<AITransport>()

    expect(await kindOf(chatOnce({ ...params, apiKey: '' }, transport))).toEqual({ kind: 'missing_key' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('times out while waiting for the response', async () => {
    vi.useFakeTimers()

    const transport: AITransport = () => new Promise(() => {})
    const pending = kindOf(chatOnce(params, transport))

    await vi.advanceTimersByTimeAsync(5000)

    expect(await pending).toEqual({ kind: 'timeout' })
  })

  it('times out while reading the body', async () => {
    vi.useFakeTimers()

    const transport: AITransport = async () => ({ status: 200, text: () => new Promise(() => {}) })
    const pending = kindOf(chatOnce(params, transport))

    await vi.advanceTimersByTimeAsync(5000)

    expect(await pending).toEqual({ kind: 'timeout' })
  })

  it('propagates user cancellation to the transport signal', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined

    const transport: AITransport = (_, init) => {
      signal = init.signal

      return new Promise(() => {})
    }

    const pending = kindOf(chatOnce({ ...params, signal: controller.signal }, transport))

    controller.abort()

    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(signal?.aborted).toBe(true)
  })

  it('rejects immediately with an already aborted signal', async () => {
    const controller = new AbortController()

    controller.abort()

    expect(await kindOf(chatOnce({ ...params, signal: controller.signal }, reply(200, completion('x'))))).toEqual({ kind: 'cancelled' })
  })

  it('classifies transport failures', async () => {
    const transport: AITransport = async () => {
      // plugin-http rejects with plain strings, not Error objects
      // eslint-disable-next-line no-throw-literal
      throw 'url not allowed on the configured scope: https://evil.com/chat/completions'
    }

    expect((await kindOf(chatOnce(params, transport))).kind).toBe('scope_denied')
  })
})

// U08 隐私边界（错误脱敏部分）
describe('error redaction', () => {
  it('removes the key, bearer tokens and sk- tokens from server messages', async () => {
    const info = await kindOf(chatOnce(params, reply(429, { error: { message: `Rate limit for ${KEY}; Authorization: Bearer abc.def; other sk-abcdefghijk` } })))

    expect(info.kind).toBe('rate_limited')
    expect(info.detail).not.toContain(KEY)
    expect(info.detail).not.toContain('abc.def')
    expect(info.detail).not.toContain('sk-abcdefghijk')
    expect(JSON.stringify(info)).not.toContain(KEY)
  })

  it('truncates long details and drops non-string input', () => {
    expect(sanitizeDetail('x'.repeat(500))!.length).toBeLessThanOrEqual(201)
    expect(sanitizeDetail({ message: 'x' })).toBeUndefined()
  })

  it('never exposes raw HTML bodies as detail', async () => {
    const info = await kindOf(chatOnce(params, reply(502, '<html><script>alert(1)</script></html>')))

    expect(info).toEqual({ kind: 'server_error', status: 502 })
  })
})

describe('testConnection', () => {
  it('sends only the fixed short prompt', async () => {
    const transport = vi.fn<AITransport>(reply(200, completion('OK')))

    const result = await testConnection({
      config: { schemaVersion: 1, baseURL: BASE, model: 'm', timeoutMs: 5000, maxContextRounds: 10 },
      apiKey: KEY,
    }, transport)

    const body = JSON.parse((transport.mock.calls[0] as [string, AITransportInit])[1].body)

    expect(body.messages).toEqual([{ role: 'user', content: CONNECTION_TEST_PROMPT }])
    expect(result.reply).toBe('OK')
  })
})
