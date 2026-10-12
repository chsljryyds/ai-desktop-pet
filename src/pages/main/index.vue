<script setup lang="ts">
import type { MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { message } from 'antdv-next'
import { round } from 'es-toolkit'
import { nth } from 'es-toolkit/compat'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Model } from '@/stores/model'

import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { useGamepad } from '@/composables/useGamepad'
import { loadLive2dModel, useModel } from '@/composables/useModel'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import { usePetStore } from '@/stores/pet'
import { isImage } from '@/utils/is'
import live2d from '@/utils/live2d'
import { consumeSuppressedLoad, loadedModelId, recoverModelLoad } from '@/utils/model-recovery'
import { join } from '@/utils/path'
import { isWindows } from '@/utils/platform'
import { clearObject } from '@/utils/shared'

const { startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const { t } = useI18n()
const { modelSize, applyLoadedModel, handleDestroy, handleResize, handleKeyChange } = useModel()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const petStore = usePetStore()
const resizing = ref(false)
const backgroundImagePath = ref<string>()
const retryToken = ref(0)
let loadGeneration = 0
let suppressedModelId: string | null = null
const { stickActive } = useGamepad()

onMounted(startListening)

onUnmounted(handleDestroy)

const debouncedResize = useDebounceFn(async () => {
  await handleResize()

  resizing.value = false
}, 100)

useEventListener('resize', () => {
  resizing.value = true

  debouncedResize()
})

function retryModelLoad() {
  retryToken.value += 1
}

async function presentModel(model: Model, isCurrent: () => boolean) {
  const path = join(model.path, 'resources', 'background.png')
  const existed = await exists(path)

  if (!isCurrent()) return false

  backgroundImagePath.value = existed ? convertFileSrc(path) : void 0
  clearObject([modelStore.supportKeys, modelStore.pressedKeys])

  const resourcePath = join(model.path, 'resources')

  for await (const groupName of ['left-keys', 'right-keys']) {
    const groupDir = join(resourcePath, groupName)
    const files = await readDir(groupDir).catch(() => [])

    if (!isCurrent()) return false

    for (const file of files.filter(item => isImage(item.name))) {
      modelStore.supportKeys[file.name.split('.')[0]] = join(groupDir, file.name)
    }
  }

  return true
}

watch([() => modelStore.currentModel, retryToken], async ([model]) => {
  const decision = consumeSuppressedLoad(model?.id, suppressedModelId)

  suppressedModelId = decision.suppressedId

  if (!model || !decision.start) return

  const token = ++loadGeneration
  const requested = model
  const models = modelStore.models.slice()
  const isCurrent = () => token === loadGeneration

  modelStore.loadPhase = 'loading'
  modelStore.modelReady = false

  try {
    const outcome = await recoverModelLoad({
      requested,
      models,
      isCurrent,
      load: candidate => loadLive2dModel(candidate.path, isCurrent),
    })

    if (!isCurrent() || outcome.status === 'superseded') return

    const bindId = loadedModelId(outcome)

    if (!bindId || outcome.status !== 'loaded') {
      modelStore.loadPhase = 'error'
      modelStore.modelReady = false
      message.error(t('pages.main.hints.loadFailed'))

      return
    }

    const loaded = models.find(item => item.id === bindId) ?? requested
    const applied = await applyLoadedModel(loaded.id, outcome.snapshot, isCurrent)

    if (!applied || !isCurrent()) return

    const presented = await presentModel(loaded, isCurrent)

    if (!presented || !isCurrent()) return

    if (modelStore.currentModel?.id !== loaded.id) {
      suppressedModelId = loaded.id
      modelStore.currentModel = loaded
    }

    petStore.bindModel(loaded.id)
    modelStore.loadPhase = 'ready'
    modelStore.modelReady = true

    if (outcome.fellBack) message.info(t('pages.main.hints.fellBack'))
  } catch {
    if (!isCurrent()) return

    modelStore.loadPhase = 'error'
    modelStore.modelReady = false
    message.error(t('pages.main.hints.loadFailed'))
  }
}, { immediate: true })

watch([() => catStore.window.scale, modelSize], async ([scale, modelSize]) => {
  if (!modelSize) return

  const { width, height } = modelSize

  appWindow.setSize(
    new PhysicalSize({
      width: Math.round(width * (scale / 100)),
      height: Math.round(height * (scale / 100)),
    }),
  )
}, { immediate: true })

watch([modelStore.pressedKeys, stickActive], ([keys, stickActive]) => {
  const dirs = Object.values(keys).map((path) => {
    return nth(path.split(sep()), -2)!
  })

  const hasLeft = dirs.some(dir => dir.startsWith('left'))
  const hasRight = dirs.some(dir => dir.startsWith('right'))

  handleKeyChange(true, stickActive.left || hasLeft)
  handleKeyChange(false, stickActive.right || hasRight)
}, { deep: true })

watch(() => catStore.window.visible, async (value) => {
  value ? showWindow() : hideWindow()
})

watch(() => catStore.window.passThrough, (value) => {
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

watch(() => catStore.model.motionSound, live2d.setMotionSoundEnabled, { immediate: true })

watch(() => catStore.model.maxFPS, live2d.setMaxFPS, { immediate: true })

useTauriListen<MotionInfo>(LISTEN_KEY.START_MOTION, ({ payload }) => {
  live2d.startMotion(payload)
})

useTauriListen<number>(LISTEN_KEY.SET_EXPRESSION, ({ payload }) => {
  live2d.setExpression(payload)
})

function handleMouseDown() {
  appWindow.startDragging()
}

function handleDoubleClick() {
  showWindow(WINDOW_LABEL.CHAT)
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.shiftKey) return

  const menu = await Menu.new({
    items: [
      ...await getBaseMenu(),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...await getExitMenu(),
    ],
  })

  // Temporarily disable always-on-top on Windows so the context menu is not covered
  if (isWindows && catStore.window.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  await menu.popup()

  // Restore always-on-top after the menu is closed
  if (!isWindows || !catStore.window.alwaysOnTop) return

  setAlwaysOnTop(true)
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, shiftKey, movementX, movementY } = event

  if (buttons !== 2 || !shiftKey) return

  const delta = (movementX + movementY) * 0.5
  const nextScale = Math.max(10, Math.min(catStore.window.scale + delta, 500))

  catStore.window.scale = round(nextScale)
}
</script>

<template>
  <div
    class="relative size-screen overflow-hidden children:(absolute size-full)"
    :class="{ '-scale-x-100': catStore.model.mirror }"
    :style="{
      opacity: catStore.window.opacity / 100,
      borderRadius: `${catStore.window.radius}%`,
    }"
    @contextmenu="handleContextmenu"
    @dblclick="handleDoubleClick"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
  >
    <img
      v-if="backgroundImagePath"
      class="object-cover"
      :src="backgroundImagePath"
    >

    <canvas id="live2dCanvas" />

    <img
      v-for="path in modelStore.pressedKeys"
      :key="path"
      class="object-cover"
      :src="convertFileSrc(path)"
    >

    <div
      v-if="modelStore.loadPhase === 'error' && !resizing"
      class="flex flex-col items-center justify-center gap-4 px-6 bg-black"
    >
      <span class="text-center text-[4vw] text-[#fff] leading-snug">
        {{ $t('pages.main.hints.loadFailed') }}
      </span>

      <button
        class="cursor-pointer b-none px-4 py-2 text-[3vw] color-[#fff] bg-primary rounded-lg"
        type="button"
        @click.stop="retryModelLoad"
        @mousedown.stop
      >
        {{ $t('pages.main.buttons.retryLoad') }}
      </button>
    </div>

    <div
      v-else-if="resizing || modelStore.loadPhase === 'loading'"
      class="flex items-center justify-center bg-black"
    >
      <span class="text-center text-[10vw] text-[#fff]">
        {{ resizing ? $t('pages.main.hints.redrawing') : $t('pages.main.hints.switching') }}
      </span>
    </div>
  </div>
</template>
