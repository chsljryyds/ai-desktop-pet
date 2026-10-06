import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { AUTHORIZED_HTTPS_ORIGINS, AUTHORIZED_LOOPBACK_HOSTS } from '@/utils/ai'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

interface Capability {
  windows: string[]
  permissions: Array<string | { identifier: string, allow?: Array<{ url: string }> }>
}

function readCapability(name: string): Capability {
  return JSON.parse(readFileSync(resolve(__dirname, '../../src-tauri/capabilities', name), 'utf8'))
}

function identifiers(capability: Capability) {
  return capability.permissions.map(item => typeof item === 'string' ? item : item.identifier)
}

describe('capabilities', () => {
  it('ai-network.json only targets chat and preference', () => {
    expect(readCapability('ai-network.json').windows.sort()).toEqual(['chat', 'preference'])
  })

  it('ai-network.json allow list matches the frontend authorized list', () => {
    const capability = readCapability('ai-network.json')
    const http = capability.permissions.find(item => typeof item !== 'string' && item.identifier === 'http:default')

    const urls = typeof http === 'object' ? (http.allow ?? []).map(item => item.url) : []

    const expected = [
      ...AUTHORIZED_HTTPS_ORIGINS.map(origin => `${origin}/*`),
      ...AUTHORIZED_LOOPBACK_HOSTS.map(host => `http://${host}:*/*`),
    ]

    expect(urls.sort()).toEqual(expected.sort())
    expect(urls.every(url => url.startsWith('https://') || /^http:\/\/(?:127\.0\.0\.1|localhost):/.test(url))).toBe(true)
  })

  it('main window gets no http permission and chat gets no fs/dialog/shortcut/updater', () => {
    const defaults = readCapability('default.json')
    const chat = readCapability('chat.json')

    expect(defaults.windows).not.toContain('chat')
    expect(identifiers(defaults).some(id => id.startsWith('http:'))).toBe(false)
    expect(identifiers(defaults).some(id => id.startsWith('updater:'))).toBe(false)
    expect(chat.windows).toEqual(['chat'])
    expect(identifiers(chat).some(id => /^(?:fs|dialog|global-shortcut|updater|http):/.test(id))).toBe(false)
  })
})
