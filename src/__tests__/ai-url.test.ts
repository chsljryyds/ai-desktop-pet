import { describe, expect, it, vi } from 'vitest'

import { buildChatCompletionsURL, isAuthorizedBaseURL, normalizeBaseURL } from '@/utils/ai'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

// U01 BaseURL 规范化
describe('normalizeBaseURL', () => {
  it.each([
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['  https://api.example.com/v1///  ', 'https://api.example.com/v1'],
    ['https://api.example.com/custom/v1', 'https://api.example.com/custom/v1'],
    ['https://api.example.com', 'https://api.example.com'],
    ['HTTPS://API.EXAMPLE.COM/v1', 'https://api.example.com/v1'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://localhost:8080/v1/', 'http://localhost:8080/v1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBaseURL(input)).toEqual({ ok: true, value: expected })
  })

  it('never appends /v1 automatically', () => {
    const result = normalizeBaseURL('https://api.example.com')

    expect(result.ok && buildChatCompletionsURL(result.value)).toBe('https://api.example.com/chat/completions')
  })

  it('keeps the existing path prefix when building the endpoint', () => {
    const result = normalizeBaseURL('https://api.example.com/custom/v1/')

    expect(result.ok && buildChatCompletionsURL(result.value)).toBe('https://api.example.com/custom/v1/chat/completions')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['api.example.com/v1', 'invalid'],
    ['/v1', 'invalid'],
    ['ftp://api.example.com/v1', 'protocol'],
    ['file:///etc/passwd', 'protocol'],
    ['javascript:alert(1)', 'protocol'],
    ['http://api.example.com/v1', 'insecure'],
    ['https://user:pass@api.example.com/v1', 'credentials'],
    ['https://user@api.example.com/v1', 'credentials'],
    ['https://api.example.com/v1?key=1', 'query_or_hash'],
    ['https://api.example.com/v1#x', 'query_or_hash'],
    ['https://api.example.com/v1?', 'query_or_hash'],
    ['https://api.example.com/v1/chat/completions', 'full_endpoint'],
    ['https://api.example.com/v1/chat/completions/', 'full_endpoint'],
  ])('rejects %j with %s', (input, code) => {
    expect(normalizeBaseURL(input)).toEqual({ ok: false, code })
  })
})

describe('isAuthorizedBaseURL', () => {
  it('accepts configured https origins and loopback http', () => {
    expect(isAuthorizedBaseURL('https://api.openai.com/v1')).toBe(true)
    expect(isAuthorizedBaseURL('https://api.deepseek.com')).toBe(true)
    expect(isAuthorizedBaseURL('http://127.0.0.1:18080/v1')).toBe(true)
    expect(isAuthorizedBaseURL('http://localhost:11434/v1')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isAuthorizedBaseURL('https://api.example.com/v1')).toBe(false)
    expect(isAuthorizedBaseURL('https://api.openai.com.evil.com/v1')).toBe(false)
    expect(isAuthorizedBaseURL('https://api.openai.com:8443/v1')).toBe(false)
    expect(isAuthorizedBaseURL('http://api.openai.com/v1')).toBe(false)
    expect(isAuthorizedBaseURL('http://192.168.1.2:8080/v1')).toBe(false)
    expect(isAuthorizedBaseURL('not a url')).toBe(false)
  })
})
