<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { useEventListener } from '@vueuse/core'
import { Button, Flex, Popconfirm } from 'antdv-next'
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AIKeyStatus } from '@/types/ai'
import type { ChatMessage } from '@/types/chat'

import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { hideWindow, showWindow } from '@/plugins/window'
import { useAIStore } from '@/stores/ai'
import { useChatStore } from '@/stores/chat'
import { usePetStore } from '@/stores/pet'
import { validateAIConfig } from '@/utils/ai'
import { formatAIError } from '@/utils/ai-message'
import { getAIKeyStatus } from '@/utils/ai-secret'
import { nextInputDraft } from '@/utils/chat'

const chatStore = useChatStore()
const aiStore = useAIStore()
const petStore = usePetStore()
const { t } = useI18n()
const input = ref('')
const notice = ref<string>()
const keyStatus = ref<AIKeyStatus>({ configured: false, baseUrl: null })
const listRef = useTemplateRef<HTMLElement>('list')

const petName = computed(() => petStore.profile?.name ?? '')

const setupHint = computed(() => {
  if (!petStore.profile) return t('pages.chat.hints.petNotReady')

  const validation = validateAIConfig(aiStore.config)

  if (!validation.ok) return t('pages.chat.hints.notConfigured')

  if (!keyStatus.value.configured || keyStatus.value.baseUrl !== validation.config.baseURL) {
    return t('pages.chat.hints.keyMissing')
  }

  return ''
})

const status = computed(() => {
  if (chatStore.sending) return { text: t('pages.chat.status.pending', { name: petName.value }), dot: 'bg-primary animate-pulse' }

  if (setupHint.value) return { text: t('pages.chat.status.offline'), dot: 'bg-[--ant-color-warning]' }

  return { text: t('pages.chat.status.online'), dot: 'bg-[--ant-color-success]' }
})

async function refreshKeyStatus() {
  try {
    keyStatus.value = await getAIKeyStatus()
  } catch {
    keyStatus.value = { configured: false, baseUrl: null }
  }
}

onMounted(refreshKeyStatus)

useTauriListen(LISTEN_KEY.AI_KEY_CHANGED, refreshKeyStatus)

useEventListener('focus', refreshKeyStatus)

onUnmounted(() => {
  chatStore.cancel()
})

watch(() => chatStore.messages.map(item => item.status).join(), async () => {
  await nextTick()

  listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior: 'smooth' })
})

async function handleSend() {
  if (chatStore.sending) return

  const text = input.value

  if (!text.trim()) return

  notice.value = void 0
  input.value = ''

  const result = await chatStore.send(text)

  input.value = nextInputDraft(result, input.value, text)

  if (result.ok || result.reason === 'busy' || result.reason === 'stale' || result.reason === 'cancelled') return

  if (result.reason === 'error') {
    notice.value = formatAIError(result.error, t)
  } else if (result.reason === 'not_ready') {
    notice.value = t('pages.chat.hints.petNotReady')
  }
}

async function handleRetry(message: ChatMessage) {
  notice.value = void 0

  const result = await chatStore.retry(message.id)

  if (!result.ok && result.reason === 'error' && result.error.kind === 'invalid_config') {
    notice.value = formatAIError(result.error, t)
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return

  if (event.isComposing || event.keyCode === 229) return

  event.preventDefault()

  handleSend()
}

function openAISettings() {
  showWindow(WINDOW_LABEL.PREFERENCE)

  emit(LISTEN_KEY.OPEN_PREFERENCE_TAB, 'ai')
}

function handleClose() {
  hideWindow(WINDOW_LABEL.CHAT)
}
</script>

<template>
  <Flex
    class="h-screen overflow-hidden b-1 b-solid bg-container b-border-sec rounded-2xl"
    vertical
  >
    <div
      class="flex shrink-0 items-center gap-3 b-b-1 b-b-solid px-4 py-3 b-border-sec"
      data-tauri-drag-region
    >
      <div
        class="size-9 flex shrink-0 items-center justify-center bg-primary rounded-full"
        data-tauri-drag-region
      >
        <div class="i-solar:cat-bold size-5 color-[#fff]" />
      </div>

      <div
        class="min-w-0 flex flex-1 flex-col"
        data-tauri-drag-region
      >
        <span
          class="truncate text-3.5 font-semibold color-text"
          data-tauri-drag-region
        >
          {{ petName || $t('pages.chat.hints.unnamed') }}
        </span>

        <span
          class="flex items-center gap-1.5 text-3 color-text-tertiary"
          data-tauri-drag-region
        >
          <span
            class="size-1.5 rounded-full"
            :class="status.dot"
          />

          {{ status.text }}
        </span>
      </div>

      <Popconfirm
        :cancel-text="$t('pages.chat.buttons.cancel')"
        :ok-text="$t('pages.chat.buttons.clear')"
        :title="$t('pages.chat.hints.clearConfirm')"
        @confirm="chatStore.clear"
      >
        <div
          class="size-8 flex cursor-pointer items-center justify-center transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-secondary] hover:color-text"
          :title="$t('pages.chat.buttons.clear')"
        >
          <div class="i-solar:trash-bin-minimalistic-linear size-4.5" />
        </div>
      </Popconfirm>

      <div
        class="size-8 flex cursor-pointer items-center justify-center transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-secondary] hover:color-text"
        @click="handleClose"
      >
        <div class="i-solar:close-circle-linear size-5" />
      </div>
    </div>

    <div
      v-if="setupHint"
      class="flex shrink-0 items-center justify-between gap-2 b-b-1 b-[--ant-color-warning-border] b-b-solid bg-[--ant-color-warning-bg] px-4 py-2 text-3 color-[--ant-color-warning-text]"
    >
      <span class="flex items-center gap-1.5">
        <div class="i-solar:danger-circle-linear size-4 shrink-0" />

        {{ setupHint }}
      </span>

      <Button
        size="small"
        type="link"
        @click="openAISettings"
      >
        {{ $t('pages.chat.buttons.openSettings') }}
      </Button>
    </div>

    <div
      ref="list"
      class="flex flex-1 flex-col gap-4 overflow-auto bg-[--ant-color-fill-quaternary] px-4 py-4"
    >
      <div
        v-if="chatStore.messages.length === 0"
        class="m-auto flex flex-col items-center gap-3 text-center"
      >
        <div class="size-16 flex items-center justify-center bg-[--ant-color-primary-bg] rounded-full">
          <div class="i-solar:cat-bold size-9 color-primary" />
        </div>

        <span class="text-3.5 font-medium color-text-secondary">
          {{ $t('pages.chat.hints.empty', { name: petName }) }}
        </span>

        <span class="text-3 color-text-quaternary">
          {{ $t('pages.chat.hints.emptySub') }}
        </span>
      </div>

      <template
        v-for="message in chatStore.messages"
        :key="message.id"
      >
        <div
          v-if="message.role === 'user'"
          class="flex flex-col items-end gap-1"
        >
          <div class="max-w-[80%] whitespace-pre-wrap break-words px-3.5 py-2 text-3.5 color-[#fff] leading-relaxed bg-primary rounded-2xl rounded-tr-md shadow-sm">
            {{ message.content }}
          </div>

          <div
            v-if="message.status === 'failed' || message.status === 'cancelled'"
            class="max-w-[85%] flex flex-wrap items-center justify-end gap-x-2 text-3"
          >
            <span :class="message.status === 'failed' ? 'color-[--ant-color-error]' : 'color-text-tertiary'">
              {{ message.status === 'failed' && message.error ? formatAIError(message.error, t) : $t('pages.chat.status.cancelled') }}
            </span>

            <span
              class="flex cursor-pointer items-center gap-0.5 color-primary hover:opacity-80"
              :class="{ 'pointer-events-none opacity-50': chatStore.sending }"
              @click="handleRetry(message)"
            >
              <div class="i-solar:restart-linear size-3.5" />

              {{ $t('pages.chat.buttons.retry') }}
            </span>
          </div>
        </div>

        <div
          v-else
          class="flex items-start gap-2"
        >
          <div class="size-7 flex shrink-0 items-center justify-center bg-[--ant-color-primary-bg] rounded-full">
            <div class="i-solar:cat-bold size-4 color-primary" />
          </div>

          <div class="max-w-[80%] flex flex-col gap-1">
            <div class="whitespace-pre-wrap break-words b-1 b-solid px-3.5 py-2 text-3.5 leading-relaxed color-text bg-container b-border-sec rounded-2xl rounded-tl-md shadow-sm">
              {{ message.content }}
            </div>

            <span
              v-if="message.truncated"
              class="text-3 color-[--ant-color-warning-text]"
            >
              {{ $t('utils.ai.truncated') }}
            </span>
          </div>
        </div>

        <div
          v-if="message.status === 'pending'"
          class="flex items-start gap-2"
        >
          <div class="size-7 flex shrink-0 items-center justify-center bg-[--ant-color-primary-bg] rounded-full">
            <div class="i-solar:cat-bold size-4 color-primary" />
          </div>

          <div class="flex items-center gap-1 b-1 b-solid px-4 py-3 bg-container b-border-sec rounded-2xl rounded-tl-md shadow-sm">
            <span
              v-for="index in 3"
              :key="index"
              class="size-1.5 animate-bounce bg-[--ant-color-text-quaternary] rounded-full"
              :style="{ animationDelay: `${(index - 1) * 0.15}s` }"
            />
          </div>
        </div>
      </template>
    </div>

    <div class="shrink-0 b-t-1 b-t-solid px-3 pb-3 pt-2 bg-container b-border-sec">
      <div
        v-if="notice"
        class="pb-2 text-3 color-[--ant-color-error]"
      >
        {{ notice }}
      </div>

      <div class="flex items-end gap-2 b-1 b-solid bg-[--ant-color-fill-quaternary] py-1.5 pl-3 pr-1.5 transition b-border rounded-2xl focus-within:b-primary">
        <textarea
          v-model="input"
          class="max-h-24 min-h-6 flex-1 resize-none b-none py-1 text-3.5 leading-relaxed outline-none color-text bg-transparent placeholder:color-text-quaternary"
          :placeholder="$t('pages.chat.hints.placeholder', { name: petName })"
          rows="1"
          @keydown="handleKeydown"
        />

        <Button
          v-if="chatStore.sending"
          danger
          shape="circle"
          type="primary"
          @click="chatStore.cancel"
        >
          <template #icon>
            <div class="i-solar:stop-bold m-auto size-4" />
          </template>
        </Button>

        <Button
          v-else
          :disabled="!input.trim()"
          shape="circle"
          type="primary"
          @click="handleSend"
        >
          <template #icon>
            <div class="i-solar:plain-bold m-auto size-4" />
          </template>
        </Button>
      </div>

      <div class="pt-1.5 text-center text-2.75 color-text-quaternary">
        {{ $t('pages.chat.hints.shortcut') }}
      </div>
    </div>
  </Flex>
</template>
