import type { PhysicalPosition } from '@tauri-apps/api/dpi'
import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { LogicalSize } from '@tauri-apps/api/dpi'
import { resolveResource, sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isNil, round } from 'es-toolkit'
import { findKey, nth } from 'es-toolkit/compat'
import { ref } from 'vue'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { createLoadGate, SupersededLoad } from '@/utils/model-recovery'
import { getCursorMonitor } from '@/utils/monitor'
import { isMac } from '@/utils/platform'

import live2d from '../utils/live2d'

const appWindow = getCurrentWebviewWindow()
const digitKeys = '1234567890'.split('') as readonly string[]
const letterKeys = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('') as readonly string[]

export interface ModelSize {
  width: number
  height: number
}

export interface LoadedModelSnapshot {
  width: number
  height: number
  motions: Record<string, MotionInfo[]>
  expressions: ExpressionInfo[]
}

const loadGate = createLoadGate()

/**
 * Loads into the shared Live2D canvas. Calls are serialized, and a stale caller
 * destroys the sprite it just added before the next caller paints.
 */
export async function loadLive2dModel(path: string, isCurrent: () => boolean): Promise<LoadedModelSnapshot> {
  return loadGate(async () => {
    if (!isCurrent()) throw new SupersededLoad()

    await resolveResource(path)

    if (!isCurrent()) throw new SupersededLoad()

    try {
      const loaded = await live2d.load(path)

      if (!isCurrent()) {
        live2d.destroy()
        throw new SupersededLoad()
      }

      return loaded
    } catch (error) {
      if (error instanceof SupersededLoad) throw error

      live2d.destroy()
      throw error
    }
  })
}

export function useModel() {
  const modelStore = useModelStore()
  const catStore = useCatStore()
  const modelSize = ref<ModelSize>()

  function getBehaviorShortcut(index: number) {
    const primary = isMac ? 'Command' : 'Control'

    const modifierGroups = [
      [primary],
      [primary, 'Shift'],
      [primary, 'Alt'],
      [primary, 'Shift', 'Alt'],
    ]

    const tiers = [
      ...modifierGroups.map(modifiers => ({ modifiers, keys: digitKeys })),
      ...modifierGroups.map(modifiers => ({ modifiers, keys: letterKeys })),
    ]

    let nextIndex = index

    for (const tier of tiers) {
      if (nextIndex < tier.keys.length) {
        return [...tier.modifiers, tier.keys[nextIndex]].join('+')
      }

      nextIndex -= tier.keys.length
    }

    return ''
  }

  function getMotionShortcutId(modelId: string, groupName: string, index: number) {
    return `${modelId}:motion:${groupName}:${index}`
  }

  function getExpressionShortcutId(modelId: string, index: number) {
    return `${modelId}:expression:${index}`
  }

  async function applyLoadedModel(modelId: string, snapshot: LoadedModelSnapshot, isCurrent: () => boolean) {
    if (!isCurrent()) return false

    const nextMotions = Object.entries(snapshot.motions)

    modelSize.value = { width: snapshot.width, height: snapshot.height }
    modelStore.currentMotions = nextMotions
    modelStore.currentExpressions = snapshot.expressions

    await handleResize()

    if (!isCurrent()) return false

    const behaviorIds: string[] = []

    for (const [groupName, items] of nextMotions) {
      for (const [index] of items.entries()) {
        behaviorIds.push(getMotionShortcutId(modelId, groupName, index))
      }
    }

    for (const [index] of snapshot.expressions.entries()) {
      behaviorIds.push(getExpressionShortcutId(modelId, index))
    }

    for (const [index, id] of behaviorIds.entries()) {
      if (modelStore.shortcuts[id]) continue

      const shortcut = getBehaviorShortcut(index)

      if (!shortcut) continue

      modelStore.shortcuts[id] = shortcut
    }

    return true
  }

  function handleDestroy() {
    live2d.destroy()
  }

  async function handleResize() {
    if (!modelSize.value) return

    live2d.resizeModel(modelSize.value)

    const { width, height } = modelSize.value

    if (round(innerWidth / innerHeight, 1) !== round(width / height, 1)) {
      await appWindow.setSize(
        new LogicalSize({
          width: innerWidth,
          height: Math.ceil(innerWidth * (height / width)),
        }),
      )
    }

    const size = await appWindow.size()

    catStore.window.scale = round((size.width / width) * 100)
  }

  const handlePress = (key: string) => {
    const path = modelStore.supportKeys[key]

    if (!path) return

    const dirName = nth(path.split(sep()), -2)!
    const prevKey = findKey(modelStore.pressedKeys, (value) => {
      return value.includes(dirName)
    })

    if (prevKey) {
      handleRelease(prevKey)
    }

    modelStore.pressedKeys[key] = path
  }

  const handleRelease = (key: string) => {
    delete modelStore.pressedKeys[key]
  }

  function handleKeyChange(isLeft = true, pressed = true) {
    const id = isLeft ? 'CatParamLeftHandDown' : 'CatParamRightHandDown'

    live2d.setParameterValue(id, pressed)
  }

  function handleMouseChange(key: string, pressed = true) {
    const id = key === 'Left' ? 'ParamMouseLeftDown' : 'ParamMouseRightDown'

    live2d.setParameterValue(id, pressed)
  }

  async function handleMouseMove(cursorPoint: PhysicalPosition) {
    const monitor = await getCursorMonitor(cursorPoint)

    if (!monitor) return

    const { size, position } = monitor

    const xRatio = (cursorPoint.x - position.x) / size.width
    const yRatio = (cursorPoint.y - position.y) / size.height

    for (const id of [
      'ParamMouseX',
      'ParamMouseY',
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamEyeBallX',
      'ParamEyeBallY',
    ]) {
      const range = live2d.getParameterValueRange(id)

      if (!range) continue

      const { min, max } = range

      if (isNil(min) || isNil(max)) continue

      const isXAxis = id.endsWith('X')
      const isYAxis = id.endsWith('Y')
      const isZAxis = id.endsWith('Z')

      let value: number

      if (isZAxis) {
        const dragX = 1 - 2 * xRatio
        const dragY = 1 - 2 * yRatio

        value = dragX * dragY * min
      } else {
        const ratio = isXAxis ? xRatio : yRatio

        value = max - ratio * (max - min)
      }

      if (!isYAxis && catStore.model.mouseMirror) {
        value *= -1
      }

      live2d.setParameterValue(id, value)
    }
  }

  async function handleAxisChange(id: string, value: number) {
    const range = live2d.getParameterValueRange(id)

    if (!range) return

    const { min, max } = range

    live2d.setParameterValue(id, Math.max(min, value * max))
  }

  return {
    modelSize,
    handlePress,
    handleRelease,
    applyLoadedModel,
    handleDestroy,
    handleResize,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
  }
}
