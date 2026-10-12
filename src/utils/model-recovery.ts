export const BUILTIN_MODE_ORDER = ['standard', 'keyboard', 'gamepad'] as const

export interface RecoveryModel {
  id: string
  mode: string
  isPreset: boolean
}

export type RecoveryOutcome<TSnapshot>
  = | { status: 'loaded', model: RecoveryModel, snapshot: TSnapshot, fellBack: boolean }
    | { status: 'failed' }
    | { status: 'superseded' }

export class SupersededLoad extends Error {
  constructor() {
    super('superseded')
    this.name = 'SupersededLoad'
  }
}

export function builtinFallbackModels<T extends RecoveryModel>(models: readonly T[], excludeIds: ReadonlySet<string>) {
  return models
    .filter(model => model.isPreset && !excludeIds.has(model.id))
    .sort((left, right) => modeRank(left.mode) - modeRank(right.mode))
}

function modeRank(mode: string) {
  const index = BUILTIN_MODE_ORDER.indexOf(mode as typeof BUILTIN_MODE_ORDER[number])

  return index === -1 ? BUILTIN_MODE_ORDER.length : index
}

/**
 * Tries the requested model once, then each unused built-in model at most once.
 * A superseded load stops the chain so an older attempt cannot keep selecting models.
 */
export async function recoverModelLoad<TModel extends RecoveryModel, TSnapshot>(options: {
  requested: TModel
  models: readonly TModel[]
  isCurrent: () => boolean
  load: (model: TModel) => Promise<TSnapshot>
}): Promise<RecoveryOutcome<TSnapshot>> {
  const tried = new Set<string>()
  const queue = [options.requested, ...builtinFallbackModels(options.models, new Set([options.requested.id]))]

  for (const model of queue) {
    if (tried.has(model.id)) continue

    tried.add(model.id)

    if (!options.isCurrent()) return { status: 'superseded' }

    try {
      const snapshot = await options.load(model)

      if (!options.isCurrent()) return { status: 'superseded' }

      return {
        status: 'loaded',
        model,
        snapshot,
        fellBack: model.id !== options.requested.id,
      }
    } catch (error) {
      if (error instanceof SupersededLoad || !options.isCurrent()) return { status: 'superseded' }
    }
  }

  if (!options.isCurrent()) return { status: 'superseded' }

  return { status: 'failed' }
}

/** The model id that may be written onto the pet. Failed and superseded loads bind nothing. */
export function loadedModelId<T>(outcome: RecoveryOutcome<T>) {
  return outcome.status === 'loaded' ? outcome.model.id : null
}

/**
 * When a successful fallback assigns currentModel, the watcher must ignore that
 * one assignment. Any other id still starts a load.
 */
export function consumeSuppressedLoad(modelId: string | undefined, suppressedId: string | null) {
  if (!modelId) return { start: false, suppressedId }

  if (suppressedId === modelId) return { start: false, suppressedId: null }

  return { start: true, suppressedId }
}

/** Serializes shared-canvas loads. A later load cannot paint until the earlier one has released the canvas. */
export function createLoadGate() {
  let chain: Promise<void> = Promise.resolve()

  return function gate<T>(task: () => Promise<T>) {
    const run = chain.then(task, task)

    chain = run.then(() => undefined, () => undefined)

    return run
  }
}
