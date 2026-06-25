<script setup lang="ts">
import { ref } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { hideWindow } from '@/plugins/window'

const input = ref('')

function handleClose() {
  hideWindow(WINDOW_LABEL.CHAT)
}
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden bg-white/90 backdrop-blur rounded-2xl dark:bg-black/80">
    <div
      class="flex items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/10"
      data-tauri-drag-region
    >
      <span
        class="font-bold text-sm"
        data-tauri-drag-region
      >
        和猫咪聊聊
      </span>

      <div
        class="i-solar:close-circle-bold size-5 cursor-pointer text-black/40 transition dark:text-white/40 hover:text-black/70 dark:hover:text-white/70"
        @click="handleClose"
      />
    </div>

    <div class="flex flex-1 flex-col items-center justify-center gap-2 overflow-auto p-4 text-center text-black/40 dark:text-white/40">
      <div class="i-solar:chat-round-line-bold size-10" />

      <span class="text-sm">聊天窗口已就绪</span>

      <span class="text-xs">AI 对话能力将在第二步接入</span>
    </div>

    <div class="flex items-center gap-2 border-t border-black/5 p-3 dark:border-white/10">
      <input
        v-model="input"
        class="focus:border-blue-400 flex-1 border-black/10 px-3 py-2 outline-none bg-transparent border text-sm rounded-lg dark:border-white/15"
        disabled
        placeholder="和猫咪聊聊…"
      >

      <button
        class="bg-blue-500/50 cursor-not-allowed px-4 py-2 text-white text-sm rounded-lg"
        disabled
      >
        发送
      </button>
    </div>
  </div>
</template>
