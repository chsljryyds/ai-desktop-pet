import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePetStore } from '@/stores/pet'
import { createPetProfile, ensurePetProfile, PET_NAME_MAX_LENGTH, validatePetDraft } from '@/utils/pet'

const defaults = { name: '小咪', personality: '温和' }

// U07 默认宠物初始化
describe('ensurePetProfile', () => {
  it('creates a profile when none exists', () => {
    const { profile, created } = ensurePetProfile(null, defaults, () => 'id-1')

    expect(created).toBe(true)
    expect(profile).toMatchObject({ schemaVersion: 1, id: 'id-1', name: '小咪', personality: '温和', modelId: null })
  })

  it('is idempotent and never creates a second id', () => {
    let counter = 0
    const createId = () => `id-${++counter}`

    const first = ensurePetProfile(null, defaults, createId)
    const second = ensurePetProfile(first.profile, defaults, createId)
    const third = ensurePetProfile(second.profile, { name: 'other', personality: 'other' }, createId)

    expect(second.created).toBe(false)
    expect(third.profile.id).toBe('id-1')
    expect(third.profile).toEqual(first.profile)
    expect(counter).toBe(1)
  })

  it('migrates partial or old data without rebuilding the id', () => {
    const { profile, created } = ensurePetProfile({ id: 'legacy', name: '  ', modelId: '', extra: true }, defaults, () => 'new')

    expect(created).toBe(false)
    expect(profile.id).toBe('legacy')
    expect(profile.name).toBe('小咪')
    expect(profile.modelId).toBeNull()
    expect(profile.schemaVersion).toBe(1)
    expect(profile).not.toHaveProperty('extra')
  })

  it('treats invalid data as missing', () => {
    expect(ensurePetProfile({ id: '' }, defaults, () => 'x').created).toBe(true)
    expect(ensurePetProfile('broken', defaults, () => 'x').created).toBe(true)
  })
})

describe('validatePetDraft', () => {
  it('validates name and personality', () => {
    expect(validatePetDraft({ name: ' ', personality: '' })).toEqual({ name: 'name_empty' })
    expect(validatePetDraft({ name: 'x'.repeat(PET_NAME_MAX_LENGTH + 1), personality: 'y'.repeat(2001) })).toEqual({
      name: 'name_too_long',
      personality: 'personality_too_long',
    })
    expect(validatePetDraft({ name: '小咪', personality: '' })).toEqual({})
  })
})

describe('usePetStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('ensureDefault twice keeps one id; rename and model binding keep the id', () => {
    const store = usePetStore()

    store.ensureDefault(defaults)

    const id = store.profile!.id

    store.ensureDefault(defaults)
    store.update({ name: ' 新名字 ', personality: '活泼' })
    store.bindModel('model-a')
    store.bindModel('model-b')

    expect(store.profile).toMatchObject({ id, name: '新名字', personality: '活泼', modelId: 'model-b' })
  })

  it('bindModel without a profile does not create one', () => {
    const store = usePetStore()

    store.bindModel('model-a')

    expect(store.profile).toBeNull()
  })

  it('createPetProfile clips oversized defaults', () => {
    expect(createPetProfile({ name: 'x'.repeat(50), personality: '' }, () => 'id').name).toHaveLength(PET_NAME_MAX_LENGTH)
  })
})
