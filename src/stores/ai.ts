import { defineStore } from 'pinia'
import { reactive } from 'vue'

import type { AIConfig } from '@/types/ai'

import { DEFAULT_AI_CONFIG, ROUNDS_RANGE, TIMEOUT_RANGE } from '@/utils/ai'

/** Non-sensitive AI settings only. The API key is never stored here. */
export const useAIStore = defineStore('ai', () => {
  const config = reactive<AIConfig>({ ...DEFAULT_AI_CONFIG })

  const init = () => {
    if (typeof config.baseURL !== 'string') config.baseURL = DEFAULT_AI_CONFIG.baseURL
    if (typeof config.model !== 'string') config.model = DEFAULT_AI_CONFIG.model

    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < TIMEOUT_RANGE.min || config.timeoutMs > TIMEOUT_RANGE.max) {
      config.timeoutMs = DEFAULT_AI_CONFIG.timeoutMs
    }

    if (!Number.isInteger(config.maxContextRounds) || config.maxContextRounds < ROUNDS_RANGE.min || config.maxContextRounds > ROUNDS_RANGE.max) {
      config.maxContextRounds = DEFAULT_AI_CONFIG.maxContextRounds
    }

    config.schemaVersion = 1
  }

  const save = (next: AIConfig) => {
    Object.assign(config, next)
  }

  return {
    config,
    init,
    save,
  }
})
