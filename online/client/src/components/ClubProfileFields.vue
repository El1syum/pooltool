<script setup lang="ts">
import { ref } from 'vue'
import { PROFILE_DETAIL_LIMITS, sanitizeProfileField, type ProfileDetails } from '../profileDetails'
import '../club-profile-qa.css'

const props = defineProps<{ name: string; details: ProfileDetails; disabled?: boolean }>()
const emit = defineEmits<{ 'update:name': [value: string]; 'update:details': [value: ProfileDetails] }>()
const editor = ref<HTMLElement | null>(null)
const assetBase = `${import.meta.env.BASE_URL || '/'}ui/club-menu/`
const fields = [
  { key: 'nickname', id: 'club-profile-display-name', label: 'Псевдоним', edit: 'Изменить псевдоним', limit: 32 },
  { key: 'fullName', id: 'club-profile-full-name', label: 'Имя', edit: 'Изменить имя', limit: PROFILE_DETAIL_LIMITS.fullName },
  { key: 'city', id: 'club-profile-city', label: 'Город', edit: 'Изменить город', limit: PROFILE_DETAIL_LIMITS.city },
] as const

function focusField(id: string) { editor.value?.querySelector<HTMLElement>(`#${id}`)?.focus() }
defineExpose({ focusNickname: () => focusField('club-profile-display-name') })

function update(field: 'nickname' | keyof ProfileDetails, event: Event) {
  if (props.disabled || (event as InputEvent).isComposing) return
  const input = event.target as HTMLInputElement | HTMLTextAreaElement
  if (field === 'nickname') { emit('update:name', input.value); return }
  const value = sanitizeProfileField(field, input.value, true)
  if (input.value !== value) input.value = value
  emit('update:details', { ...props.details, [field]: value })
}
</script>

<template>
  <div ref="editor" class="club-profile-fields">
    <div v-for="field in fields" :key="field.key" class="club-profile-field">
      <label :for="field.id">{{ field.label }}</label>
      <div class="club-profile-value">
        <input :id="field.id" type="text" :value="field.key === 'nickname' ? name : details[field.key]"
          :aria-label="field.key === 'nickname' ? 'Имя игрока' : undefined" aria-describedby="club-profile-visibility"
          :maxlength="field.limit" :disabled="disabled" :autocomplete="field.key === 'nickname' ? 'nickname' : 'off'"
          :required="field.key === 'nickname'" @input="update(field.key, $event)" @compositionend="update(field.key, $event)" />
        <button type="button" class="club-profile-edit" :aria-label="field.edit" :disabled="disabled" @click="focusField(field.id)"><img :src="`${assetBase}pencil-small.svg`" alt="" /></button>
      </div>
    </div>
    <div class="club-profile-about">
      <label for="club-profile-about">О себе</label>
      <div class="club-profile-value">
        <div class="club-profile-about-input">
          <span class="club-profile-about-measure" aria-hidden="true" v-text="`${details.about} `"></span>
          <textarea id="club-profile-about" :value="details.about" rows="1" :maxlength="PROFILE_DETAIL_LIMITS.about"
            aria-describedby="club-profile-visibility" :disabled="disabled" @input="update('about', $event)" @compositionend="update('about', $event)"></textarea>
        </div>
        <button type="button" class="club-profile-edit" aria-label="Изменить описание" :disabled="disabled" @click="focusField('club-profile-about')"><img :src="`${assetBase}pencil-about.svg`" alt="" /></button>
      </div>
    </div>
    <p id="club-profile-visibility" hidden>Только псевдоним виден соперникам.</p>
  </div>
</template>
