import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'

import type { AIKeyStatus } from '@/types/ai'

import { INVOKE_KEY, LISTEN_KEY } from '@/constants'

/**
 * The key only lives in the Rust process memory and is bound to one normalized base URL.
 * Change notifications carry no payload so the key never travels through events.
 */
export async function setAIKey(baseURL: string, key: string) {
  await invoke(INVOKE_KEY.SET_AI_KEY, { baseUrl: baseURL, key })

  await emit(LISTEN_KEY.AI_KEY_CHANGED)
}

export function getAIKey(baseURL: string) {
  return invoke<string | null>(INVOKE_KEY.GET_AI_KEY, { baseUrl: baseURL })
}

export function getAIKeyStatus() {
  return invoke<AIKeyStatus>(INVOKE_KEY.GET_AI_KEY_STATUS)
}

export async function clearAIKey() {
  await invoke(INVOKE_KEY.CLEAR_AI_KEY)

  await emit(LISTEN_KEY.AI_KEY_CHANGED)
}
