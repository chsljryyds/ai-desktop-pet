<script setup lang="ts">
import { Alert, Button, Input, message, TextArea } from 'antdv-next'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PetDraftErrors } from '@/types/pet'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useModelStore } from '@/stores/model'
import { usePetStore } from '@/stores/pet'
import { PET_NAME_MAX_LENGTH, PET_PERSONALITY_MAX_LENGTH, validatePetDraft } from '@/utils/pet'

const petStore = usePetStore()
const modelStore = useModelStore()
const { t } = useI18n()

const draft = reactive({ name: '', personality: '' })
const errors = ref<PetDraftErrors>({})

watch(() => [petStore.profile?.name, petStore.profile?.personality] as const, ([name, personality]) => {
  if (name === void 0 || personality === void 0) return

  draft.name = name
  draft.personality = personality
}, { immediate: true })

const modelLabel = computed(() => {
  const modelId = petStore.profile?.modelId

  if (!modelId) return t('pages.preference.ai.pet.noModel')

  const model = modelStore.models.find(item => item.id === modelId)

  if (!model) return t('pages.preference.ai.pet.modelMissing')

  return model.isPreset ? t('pages.preference.ai.pet.presetModel', { mode: model.mode }) : model.path.split(/[\\/]/).pop()
})

function handleSave() {
  errors.value = validatePetDraft(draft)

  if (Object.keys(errors.value).length > 0) return

  petStore.update(draft)

  message.success(t('pages.preference.ai.hints.saveSuccess'))
}
</script>

<template>
  <ProList :title="$t('pages.preference.ai.pet.title')">
    <Alert
      v-if="!petStore.profile"
      show-icon
      :title="$t('pages.preference.ai.pet.notReady')"
      type="warning"
    />

    <template v-else>
      <ProListItem
        :description="errors.name ? $t(`pages.preference.ai.pet.errors.${errors.name}`, { max: PET_NAME_MAX_LENGTH }) : $t('pages.preference.ai.pet.hints.name')"
        :title="$t('pages.preference.ai.pet.labels.name')"
      >
        <Input
          v-model:value="draft.name"
          class="w-50"
          :maxlength="PET_NAME_MAX_LENGTH"
          :status="errors.name ? 'error' : void 0"
        />
      </ProListItem>

      <ProListItem
        :description="errors.personality ? $t(`pages.preference.ai.pet.errors.${errors.personality}`, { max: PET_PERSONALITY_MAX_LENGTH }) : $t('pages.preference.ai.pet.hints.personality')"
        :title="$t('pages.preference.ai.pet.labels.personality')"
        vertical
      >
        <TextArea
          v-model:value="draft.personality"
          :auto-size="{ minRows: 3, maxRows: 8 }"
          :maxlength="PET_PERSONALITY_MAX_LENGTH"
          show-count
          :status="errors.personality ? 'error' : void 0"
        />
      </ProListItem>

      <ProListItem
        :description="`ID: ${petStore.profile.id}`"
        :title="$t('pages.preference.ai.pet.labels.model', { model: modelLabel })"
      >
        <Button
          type="primary"
          @click="handleSave"
        >
          {{ $t('pages.preference.ai.pet.buttons.save') }}
        </Button>
      </ProListItem>
    </template>
  </ProList>
</template>
