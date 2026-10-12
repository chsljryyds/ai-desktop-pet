export interface PetProfile {
  schemaVersion: 1
  id: string
  name: string
  modelId: string | null
  personality: string
  createdAt: string
}

export interface PetDefaults {
  name: string
  personality: string
}

export type PetDraftErrorCode = 'name_empty' | 'name_too_long' | 'personality_too_long'

export interface PetDraftErrors {
  name?: PetDraftErrorCode
  personality?: PetDraftErrorCode
}
