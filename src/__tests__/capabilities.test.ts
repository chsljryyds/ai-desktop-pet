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

  it('model import and key commands are limited to the windows that use them', () => {
    const main = readCapability('main-commands.json')
    const preference = readCapability('preference-commands.json')
    const chat = readCapability('chat.json')
    const defaults = readCapability('default.json')

    expect(main.windows).toEqual(['main'])
    expect(preference.windows).toEqual(['preference'])
    expect(identifiers(main).sort()).toEqual([
      'allow-start-device-listening',
      'allow-start-gamepad-listing',
      'allow-stop-gamepad-listing',
    ])
    expect(identifiers(preference).sort()).toEqual([
      'allow-clear-ai-key',
      'allow-get-ai-key',
      'allow-get-ai-key-status',
      'allow-import-custom-model',
      'allow-set-ai-key',
    ])
    expect(identifiers(chat)).toEqual(expect.arrayContaining(['allow-get-ai-key', 'allow-get-ai-key-status']))
    expect(identifiers(chat).some(id => id.includes('import-custom-model') || id.includes('set-ai-key') || id.includes('clear-ai-key') || id.includes('gamepad') || id.includes('device'))).toBe(false)
    expect(identifiers(defaults).some(id => id.startsWith('allow-'))).toBe(false)
    expect(identifiers(main).some(id => id.includes('import-custom-model') || id.includes('ai-key'))).toBe(false)
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
