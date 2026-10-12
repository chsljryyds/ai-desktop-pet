import { describe, expect, it } from 'vitest'

import type { RecoveryModel } from '@/utils/model-recovery'

import { consumeSuppressedLoad, createLoadGate, loadedModelId, recoverModelLoad, SupersededLoad } from '@/utils/model-recovery'

const custom: RecoveryModel = { id: 'custom', mode: 'keyboard', isPreset: false }
const standard: RecoveryModel = { id: 'standard', mode: 'standard', isPreset: true }
const keyboard: RecoveryModel = { id: 'keyboard', mode: 'keyboard', isPreset: true }
const gamepad: RecoveryModel = { id: 'gamepad', mode: 'gamepad', isPreset: true }
const builtins = [gamepad, keyboard, standard]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe('model load recovery', () => {
  it('falls back to the first built-in model that loads and leaves the pet identity alone', async () => {
    const tried: string[] = []
    const models = [custom, ...builtins]
    const pet = { id: 'pet-1', name: '测试咪', personality: '傲娇', createdAt: '2020-01-01', modelId: 'custom' }

    const outcome = await recoverModelLoad({
      requested: custom,
      models,
      isCurrent: () => true,
      load: async (model) => {
        tried.push(model.id)

        if (model.id === 'custom') throw new Error('missing directory')

        return { shown: model.id }
      },
    })

    const bindId = loadedModelId(outcome)

    if (bindId) pet.modelId = bindId

    expect(tried).toEqual(['custom', 'standard'])
    expect(outcome).toMatchObject({ status: 'loaded', fellBack: true, model: { id: 'standard' } })
    expect(pet).toEqual({ id: 'pet-1', name: '测试咪', personality: '傲娇', createdAt: '2020-01-01', modelId: 'standard' })
    expect(models.map(item => item.id)).toEqual(['custom', 'gamepad', 'keyboard', 'standard'])
  })

  it('keeps trying later built-in models and binds only the one that loads', async () => {
    const tried: string[] = []

    const outcome = await recoverModelLoad({
      requested: custom,
      models: [custom, standard, keyboard, gamepad],
      isCurrent: () => true,
      load: async (model) => {
        tried.push(model.id)

        if (model.id !== 'keyboard') throw new Error('damaged')

        return 'ok'
      },
    })

    expect(tried).toEqual(['custom', 'standard', 'keyboard'])
    expect(loadedModelId(outcome)).toBe('keyboard')
    expect(outcome).toMatchObject({ fellBack: true })
  })

  it('stops after every candidate fails without pretending one was bound', async () => {
    const tried: string[] = []
    const pet = { id: 'pet-1', name: '测试咪', personality: '傲娇', createdAt: '2020-01-01', modelId: 'custom' }

    const outcome = await recoverModelLoad({
      requested: custom,
      models: [custom, standard, keyboard, gamepad],
      isCurrent: () => true,
      load: async (model) => {
        tried.push(model.id)
        throw new Error('unavailable')
      },
    })

    expect(outcome).toEqual({ status: 'failed' })
    expect(loadedModelId(outcome)).toBeNull()
    expect(tried).toEqual(['custom', 'standard', 'keyboard', 'gamepad'])
    expect(pet.modelId).toBe('custom')
    expect(pet.id).toBe('pet-1')
  })

  it('does not let a late load replace the newest request', async () => {
    let generation = 0
    const waits: Array<{ token: number, id: string, resolve: (value: string) => void }> = []

    function start(id: string) {
      const token = ++generation

      return recoverModelLoad({
        requested: { id, mode: 'keyboard', isPreset: false },
        models: [{ id, mode: 'keyboard', isPreset: false }, standard, keyboard],
        isCurrent: () => token === generation,
        load: (model) => {
          const gate = deferred<string>()

          waits.push({ token, id: model.id, resolve: gate.resolve })

          return gate.promise.then((value) => {
            if (token !== generation) throw new SupersededLoad()

            return value
          })
        },
      })
    }

    const older = start('A')
    const newer = start('B')

    waits.find(item => item.token === 1 && item.id === 'A')!.resolve('late-A')
    waits.find(item => item.token === 2 && item.id === 'B')!.resolve('fresh-B')

    await expect(older).resolves.toEqual({ status: 'superseded' })
    await expect(newer).resolves.toMatchObject({ status: 'loaded', model: { id: 'B' }, fellBack: false })
    expect(waits.map(item => `${item.token}:${item.id}`)).toEqual(['1:A', '2:B'])
  })

  it('stops the fallback chain when the load itself is superseded', async () => {
    const tried: string[] = []
    let current = true
    const gate = deferred<void>()

    const outcome = recoverModelLoad({
      requested: custom,
      models: [custom, standard],
      isCurrent: () => current,
      load: async (model) => {
        tried.push(model.id)
        current = false
        await gate.promise
        throw new SupersededLoad()
      },
    })

    gate.resolve()

    await expect(outcome).resolves.toEqual({ status: 'superseded' })
    expect(tried).toEqual(['custom'])
  })

  it('can load a previously failed model again', async () => {
    let broken = true
    const load = async (model: RecoveryModel) => {
      if (broken && model.id === 'custom') throw new Error('missing')

      return 'ready'
    }

    await expect(recoverModelLoad({
      requested: custom,
      models: [custom, standard],
      isCurrent: () => true,
      load,
    })).resolves.toMatchObject({ status: 'loaded', model: { id: 'standard' }, fellBack: true })

    broken = false

    await expect(recoverModelLoad({
      requested: custom,
      models: [custom, standard],
      isCurrent: () => true,
      load,
    })).resolves.toMatchObject({ status: 'loaded', model: { id: 'custom' }, fellBack: false })
  })

  it('ignores the assignment that applies a fallback and still loads a real switch', () => {
    const ignored = consumeSuppressedLoad('standard', 'standard')

    expect(ignored).toEqual({ start: false, suppressedId: null })

    const next = consumeSuppressedLoad('custom', ignored.suppressedId)

    expect(next).toEqual({ start: true, suppressedId: null })
  })

  it('does not let an older canvas load paint after a newer one has started', async () => {
    const gate = createLoadGate()
    let generation = 1
    const order: string[] = []
    const held = deferred<void>()

    const older = gate(async () => {
      order.push('older-start')
      await held.promise

      if (generation !== 1) throw new SupersededLoad()

      order.push('older-paint')

      return 'A'
    })
    const newer = gate(async () => {
      order.push('newer-start')

      if (generation !== 2) throw new SupersededLoad()

      order.push('newer-paint')

      return 'B'
    })

    generation = 2
    held.resolve()

    await expect(older).rejects.toBeInstanceOf(SupersededLoad)
    await expect(newer).resolves.toBe('B')
    expect(order).toEqual(['older-start', 'newer-start', 'newer-paint'])
  })
})
