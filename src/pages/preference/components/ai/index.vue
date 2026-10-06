<script setup lang="ts">
import { Alert, Button, Flex, Input, InputNumber, InputPassword, message, SpaceAddon, SpaceCompact, Tag } from 'antdv-next'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AIConfig, AIConfigErrorCode, AIConfigField, AIKeyStatus } from '@/types/ai'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { useAIStore } from '@/stores/ai'
import {
  AUTHORIZED_HTTPS_ORIGINS,
  AUTHORIZED_LOOPBACK_HOSTS,
  buildChatCompletionsURL,
  normalizeBaseURL,
  ROUNDS_RANGE,
  testConnection,
  TIMEOUT_RANGE,
  toAIErrorInfo,
  validateAIConfig,
} from '@/utils/ai'
import { formatAIError } from '@/utils/ai-message'
import { clearAIKey, getAIKey, getAIKeyStatus, setAIKey } from '@/utils/ai-secret'

import PetProfile from './components/pet-profile/index.vue'

const aiStore = useAIStore()
const { t } = useI18n()

const draft = reactive({
  baseURL: '',
  model: '',
  timeoutSeconds: 60,
  maxContextRounds: 10,
})
const keyInput = ref('')
const keyStatus = ref<AIKeyStatus>({ configured: false, baseUrl: null })
const errors = ref<Partial<Record<AIConfigField, AIConfigErrorCode>>>({})
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ type: 'success' | 'info' | 'warning' | 'error', text: string }>()
let testController: AbortController | null = null

const authorizedList = [
  ...AUTHORIZED_HTTPS_ORIGINS,
  ...AUTHORIZED_LOOPBACK_HOSTS.map(host => `http://${host}:<port>`),
]

function resetDraft(config: AIConfig) {
  draft.baseURL = config.baseURL
  draft.model = config.model
  draft.timeoutSeconds = Math.round(config.timeoutMs / 1000)
  draft.maxContextRounds = config.maxContextRounds
}

watch(() => ({ ...aiStore.config }), resetDraft, { immediate: true })

const draftConfig = computed<Partial<AIConfig>>(() => ({
  schemaVersion: 1,
  baseURL: draft.baseURL,
  model: draft.model,
  timeoutMs: typeof draft.timeoutSeconds === 'number' ? Math.round(draft.timeoutSeconds * 1000) : Number.NaN,
  maxContextRounds: draft.maxContextRounds,
}))

const normalizedDraftURL = computed(() => {
  const result = normalizeBaseURL(draft.baseURL)

  return result.ok ? result.value : null
})

const requestURL = computed(() => {
  return normalizedDraftURL.value ? buildChatCompletionsURL(normalizedDraftURL.value) : ''
})

const keyState = computed(() => {
  if (!keyStatus.value.configured) return 'none'

  return keyStatus.value.baseUrl === normalizedDraftURL.value ? 'bound' : 'mismatch'
})

async function refreshKeyStatus() {
  try {
    keyStatus.value = await getAIKeyStatus()
  } catch (error) {
    message.error(String(error))
  }
}

onMounted(refreshKeyStatus)

useTauriListen(LISTEN_KEY.AI_KEY_CHANGED, refreshKeyStatus)

function fieldError(field: AIConfigField) {
  const code = errors.value[field]

  if (!code) return

  return t(`pages.preference.ai.errors.${code}`, {
    min: field === 'timeoutMs' ? TIMEOUT_RANGE.min / 1000 : ROUNDS_RANGE.min,
    max: field === 'timeoutMs' ? TIMEOUT_RANGE.max / 1000 : ROUNDS_RANGE.max,
  })
}

function validateDraft() {
  const result = validateAIConfig(draftConfig.value)

  errors.value = result.ok ? {} : result.errors

  return result
}

async function handleSave() {
  if (saving.value) return

  const result = validateDraft()

  if (!result.ok) return

  saving.value = true

  try {
    const { config } = result
    const key = keyInput.value.trim()

    if (key) {
      await setAIKey(config.baseURL, key)
    } else if (keyStatus.value.configured && keyStatus.value.baseUrl !== config.baseURL) {
      await clearAIKey()

      message.warning(t('pages.preference.ai.hints.keyClearedForNewURL'))
    }

    aiStore.save(config)
    keyInput.value = ''

    await refreshKeyStatus()

    message.success(t('pages.preference.ai.hints.saveSuccess'))
  } catch (error) {
    message.error(String(error))
  } finally {
    saving.value = false
  }
}

async function handleClearKey() {
  try {
    await clearAIKey()
    keyInput.value = ''

    await refreshKeyStatus()

    message.success(t('pages.preference.ai.hints.keyCleared'))
  } catch (error) {
    message.error(String(error))
  }
}

async function handleTest() {
  if (testing.value) return

  const result = validateDraft()

  if (!result.ok) return

  testing.value = true
  testResult.value = void 0

  const controller = new AbortController()

  testController = controller

  try {
    const { config } = result
    const apiKey = keyInput.value.trim() || await getAIKey(config.baseURL) || ''

    const { reply, truncated, elapsedMs } = await testConnection({ config, apiKey, signal: controller.signal })

    testResult.value = {
      type: truncated ? 'warning' : 'success',
      text: t('pages.preference.ai.hints.testSuccess', { reply, seconds: (elapsedMs / 1000).toFixed(1) })
        + (truncated ? ` ${t('utils.ai.truncated')}` : ''),
    }
  } catch (error) {
    const info = toAIErrorInfo(error)

    testResult.value = {
      type: info.kind === 'cancelled' ? 'info' : 'error',
      text: formatAIError(info, t),
    }
  } finally {
    if (testController === controller) testController = null

    testing.value = false
  }
}

function handleCancelTest() {
  testController?.abort()
}
</script>

<template>
  <ProList :title="$t('pages.preference.ai.labels.connection')">
    <ProListItem
      :title="$t('pages.preference.ai.labels.baseURL')"
      vertical
    >
      <Input
        v-model:value="draft.baseURL"
        allow-clear
        placeholder="https://api.example.com/v1"
        :status="errors.baseURL ? 'error' : void 0"
      />

      <template #description>
        <div
          v-if="fieldError('baseURL')"
          class="color-red-5"
        >
          {{ fieldError('baseURL') }}
        </div>

        <div v-if="requestURL">
          {{ $t('pages.preference.ai.hints.requestURL', { url: requestURL }) }}
        </div>

        <div>{{ $t('pages.preference.ai.hints.baseURL') }}</div>

        <div>{{ $t('pages.preference.ai.hints.authorized', { list: authorizedList.join(', ') }) }}</div>
      </template>
    </ProListItem>

    <ProListItem
      :title="$t('pages.preference.ai.labels.model')"
      vertical
    >
      <Input
        v-model:value="draft.model"
        allow-clear
        :placeholder="$t('pages.preference.ai.hints.modelPlaceholder')"
        :status="errors.model ? 'error' : void 0"
      />

      <template #description>
        <div
          v-if="fieldError('model')"
          class="color-red-5"
        >
          {{ fieldError('model') }}
        </div>

        <div>{{ $t('pages.preference.ai.hints.model') }}</div>
      </template>
    </ProListItem>

    <ProListItem
      :title="$t('pages.preference.ai.labels.apiKey')"
      vertical
    >
      <Flex gap="small">
        <InputPassword
          v-model:value="keyInput"
          autocomplete="off"
          class="flex-1"
          :placeholder="$t('pages.preference.ai.hints.keyPlaceholder')"
        />

        <Button
          danger
          :disabled="!keyStatus.configured"
          @click="handleClearKey"
        >
          {{ $t('pages.preference.ai.buttons.clearKey') }}
        </Button>
      </Flex>

      <template #description>
        <Flex
          align="center"
          gap="small"
          wrap
        >
          <Tag
            v-if="keyState === 'bound'"
            color="success"
          >
            {{ $t('pages.preference.ai.status.keyBound') }}
          </Tag>

          <Tag
            v-else-if="keyState === 'mismatch'"
            color="warning"
          >
            {{ $t('pages.preference.ai.status.keyMismatch') }}
          </Tag>

          <Tag v-else>
            {{ $t('pages.preference.ai.status.keyNone') }}
          </Tag>
        </Flex>

        <div class="mt-1">
          {{ $t('pages.preference.ai.hints.keyMemoryOnly') }}
        </div>
      </template>
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.ai.labels.requestPolicy')">
    <ProListItem :title="$t('pages.preference.ai.labels.timeout')">
      <SpaceCompact>
        <InputNumber
          v-model:value="draft.timeoutSeconds"
          class="w-24"
          :max="TIMEOUT_RANGE.max / 1000"
          :min="TIMEOUT_RANGE.min / 1000"
          :precision="0"
          :status="errors.timeoutMs ? 'error' : void 0"
        />

        <SpaceAddon>s</SpaceAddon>
      </SpaceCompact>

      <template #description>
        <div
          v-if="fieldError('timeoutMs')"
          class="color-red-5"
        >
          {{ fieldError('timeoutMs') }}
        </div>
      </template>
    </ProListItem>

    <ProListItem
      :description="fieldError('maxContextRounds') ?? $t('pages.preference.ai.hints.maxContextRounds')"
      :title="$t('pages.preference.ai.labels.maxContextRounds')"
    >
      <InputNumber
        v-model:value="draft.maxContextRounds"
        class="w-24"
        :max="ROUNDS_RANGE.max"
        :min="ROUNDS_RANGE.min"
        :precision="0"
        :status="errors.maxContextRounds ? 'error' : void 0"
      />
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.ai.labels.actions')">
    <ProListItem
      :description="$t('pages.preference.ai.hints.testCost')"
      :title="$t('pages.preference.ai.labels.testConnection')"
    >
      <Flex gap="small">
        <Button
          v-if="testing"
          danger
          @click="handleCancelTest"
        >
          {{ $t('pages.preference.ai.buttons.cancelTest') }}
        </Button>

        <Button
          :loading="testing"
          @click="handleTest"
        >
          {{ $t('pages.preference.ai.buttons.test') }}
        </Button>

        <Button
          :loading="saving"
          type="primary"
          @click="handleSave"
        >
          {{ $t('pages.preference.ai.buttons.save') }}
        </Button>
      </Flex>
    </ProListItem>

    <Alert
      v-if="testResult"
      class="break-all"
      show-icon
      :title="testResult.text"
      :type="testResult.type"
    />

    <Alert
      :description="$t('pages.preference.ai.hints.privacy')"
      show-icon
      :title="$t('pages.preference.ai.labels.privacy')"
      type="info"
    />
  </ProList>

  <PetProfile />
</template>
