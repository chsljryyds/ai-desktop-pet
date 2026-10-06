import { nanoid } from 'nanoid'

import type { PetDefaults, PetDraftErrors, PetProfile } from '@/types/pet'

export const PET_NAME_MAX_LENGTH = 20

export const PET_PERSONALITY_MAX_LENGTH = 2000

export function createPetProfile(defaults: PetDefaults, createId: () => string = nanoid, now = new Date()): PetProfile {
  return {
    schemaVersion: 1,
    id: createId(),
    name: defaults.name.slice(0, PET_NAME_MAX_LENGTH),
    modelId: null,
    personality: defaults.personality.slice(0, PET_PERSONALITY_MAX_LENGTH),
    createdAt: now.toISOString(),
  }
}

/**
 * Returns the existing profile (normalized, same id) or a newly created default one.
 * Idempotent: calling it again with its own result never produces a new id.
 */
export function ensurePetProfile(current: unknown, defaults: PetDefaults, createId: () => string = nanoid) {
  const value = typeof current === 'object' && current !== null ? current as Partial<Record<keyof PetProfile, unknown>> : null

  if (!value || typeof value.id !== 'string' || !value.id) {
    return { profile: createPetProfile(defaults, createId), created: true }
  }

  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, PET_NAME_MAX_LENGTH) : defaults.name

  const profile: PetProfile = {
    schemaVersion: 1,
    id: value.id,
    name,
    modelId: typeof value.modelId === 'string' && value.modelId ? value.modelId : null,
    personality: typeof value.personality === 'string' ? value.personality.slice(0, PET_PERSONALITY_MAX_LENGTH) : defaults.personality,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }

  return { profile, created: false }
}

export function validatePetDraft(draft: { name: string, personality: string }): PetDraftErrors {
  const errors: PetDraftErrors = {}
  const name = draft.name.trim()

  if (!name) {
    errors.name = 'name_empty'
  } else if (name.length > PET_NAME_MAX_LENGTH) {
    errors.name = 'name_too_long'
  }

  if (draft.personality.length > PET_PERSONALITY_MAX_LENGTH) {
    errors.personality = 'personality_too_long'
  }

  return errors
}
