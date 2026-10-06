<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { useEventListener } from '@vueuse/core'
import { Popconfirm } from 'antdv-next'
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

  if (result.ok || result.reason === 'busy' || result.reason === 'stale') return

  if (!input.value) input.value = text

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
  <div class="h-screen flex flex-col overflow-hidden bg-white/90 backdrop-blur rounded-2xl dark:bg-black/80">
    <div
      class="flex items-center justify-between gap-2 border-b border-black/5 px-4 py-3 dark:border-white/10"
      data-tauri-drag-region
    >
      <span
        class="truncate font-bold text-sm"
        data-tauri-drag-region
      >
        {{ $t('pages.chat.title', { name: petName }) }}
      </span>

      <div class="flex items-center gap-3">
        <Popconfirm
          :cancel-text="$t('pages.chat.buttons.cancel')"
          :ok-text="$t('pages.chat.buttons.clear')"
          :title="$t('pages.chat.hints.clearConfirm')"
          @confirm="chatStore.clear"
        >
          <div
            class="i-solar:trash-bin-minimalistic-linear size-5 cursor-pointer text-black/40 transition dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
            :title="$t('pages.chat.buttons.clear')"
          />
        </Popconfirm>

        <div
          class="i-solar:close-circle-bold size-5 cursor-pointer text-black/40 transition dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
          @click="handleClose"
        />
      </div>
    </div>

    <div
      v-if="setupHint"
      class="flex items-center justify-between gap-2 bg-amber-500/10 px-4 py-2 text-amber-700 text-xs dark:text-amber-300"
    >
      <span>{{ setupHint }}</span>

      <button
        class="text-blue-500 shrink-0 cursor-pointer border-none p-0 underline bg-transparent text-xs"
        @click="openAISettings"
      >
        {{ $t('pages.chat.buttons.openSettings') }}
      </button>
    </div>

    <div
      ref="list"
      class="flex flex-1 flex-col gap-3 overflow-auto p-4"
    >
      <div
        v-if="chatStore.messages.length === 0"
        class="m-auto flex flex-col items-center gap-2 text-center text-black/40 dark:text-white/40"
      >
        <div class="i-solar:chat-round-line-bold size-10" />

        <span class="text-sm">{{ $t('pages.chat.hints.empty', { name: petName }) }}</span>
      </div>

      <template
        v-for="message in chatStore.messages"
        :key="message.id"
      >
        <div
          class="flex flex-col gap-1"
          :class="message.role === 'user' ? 'items-end' : 'items-start'"
        >
          <div
            class="max-w-[85%] whitespace-pre-wrap break-words px-3 py-2 text-sm rounded-xl"
            :class="message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-black/5 text-black/85 dark:bg-white/10 dark:text-white/85'"
          >
            {{ message.content }}
          </div>

          <span
            v-if="message.truncated"
            class="text-amber-600 text-xs"
          >
            {{ $t('utils.ai.truncated') }}
          </span>

          <div
            v-if="message.status === 'failed' || message.status === 'cancelled'"
            class="max-w-[85%] flex flex-wrap items-center justify-end gap-x-2 text-xs"
          >
            <span :class="message.status === 'failed' ? 'text-red-500' : 'text-black/40 dark:text-white/40'">
              {{ message.status === 'failed' && message.error ? formatAIError(message.error, t) : $t('pages.chat.status.cancelled') }}
            </span>

            <button
              class="text-blue-500 cursor-pointer border-none p-0 underline bg-transparent text-xs disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="chatStore.sending"
              @click="handleRetry(message)"
            >
              {{ $t('pages.chat.buttons.retry') }}
            </button>
          </div>
        </div>

        <div
          v-if="message.status === 'pending'"
          class="flex items-center self-start gap-2 bg-black/5 px-3 py-2 text-black/50 text-sm rounded-xl dark:bg-white/10 dark:text-white/50"
        >
          <div class="i-solar:refresh-linear size-4 animate-spin" />

          <span>{{ $t('pages.chat.status.pending', { name: petName }) }}</span>
        </div>
      </template>
    </div>

    <div
      v-if="notice"
      class="text-red-500 px-4 pb-1 text-xs"
    >
      {{ notice }}
    </div>

    <div class="flex items-end gap-2 border-t border-black/5 p-3 dark:border-white/10">
      <textarea
        v-model="input"
        class="focus:border-blue-400 max-h-24 min-h-9 flex-1 resize-none border-black/10 px-3 py-2 outline-none bg-transparent border text-sm rounded-lg dark:border-white/15"
        :placeholder="$t('pages.chat.hints.placeholder', { name: petName })"
        rows="1"
        @keydown="handleKeydown"
      />

      <button
        v-if="chatStore.sending"
        class="bg-red-500 hover:bg-red-600 shrink-0 cursor-pointer border-none px-4 py-2 text-white text-sm rounded-lg"
        @click="chatStore.cancel"
      >
        {{ $t('pages.chat.buttons.cancel') }}
      </button>

      <button
        v-else
        class="bg-blue-500 disabled:bg-blue-500/50 hover:bg-blue-600 shrink-0 cursor-pointer border-none px-4 py-2 text-white text-sm rounded-lg disabled:cursor-not-allowed"
        :disabled="!input.trim()"
        @click="handleSend"
      >
        {{ $t('pages.chat.buttons.send') }}
      </button>
    </div>
  </div>
</template>
