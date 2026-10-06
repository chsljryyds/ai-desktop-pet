import { isEqual } from 'es-toolkit'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import type { PetDefaults, PetProfile } from '@/types/pet'

import { ensurePetProfile } from '@/utils/pet'

export const usePetStore = defineStore('pet', () => {
  const profile = ref<PetProfile | null>(null)

  /** Only the main window may call this, after the persisted state has been loaded. */
  const ensureDefault = (defaults: PetDefaults) => {
    const result = ensurePetProfile(profile.value, defaults)

    if (!isEqual(result.profile, profile.value)) {
      profile.value = result.profile
    }

    return result
  }

  /** One-way binding: the main window reports the model it actually loaded. */
  const bindModel = (modelId: string) => {
    if (!profile.value || profile.value.modelId === modelId) return

    profile.value.modelId = modelId
  }

  const update = (next: Pick<PetProfile, 'name' | 'personality'>) => {
    if (!profile.value) return

    profile.value.name = next.name.trim()
    profile.value.personality = next.personality
  }

  return {
    profile,
    ensureDefault,
    bindModel,
    update,
  }
})
