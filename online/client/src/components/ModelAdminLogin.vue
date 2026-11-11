<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
const props = defineProps<{ busy: boolean; error: string; configured: boolean }>()
const emit = defineEmits<{ submit: [credentials: { username: string; password: string }]; close: [] }>()
const username = ref(''), password = ref('')
const dialog = ref<HTMLElement | null>(null), usernameInput = ref<HTMLInputElement | null>(null)
const canSubmit = computed(() => props.configured && !props.busy && username.value.trim().length > 0 && password.value.length > 0)
let previousFocus: HTMLElement | null = null
function submit() {
  if (!canSubmit.value) return
  const credentials = { username: username.value.trim(), password: password.value }
  password.value = ''
  emit('submit', credentials)
}
function close() { password.value = ''; emit('close') }
function onKey(event: KeyboardEvent) {
  const root = dialog.value
  const modals = document.querySelectorAll('[aria-modal="true"]')
  if (!root || modals.item(modals.length - 1) !== root || event.defaultPrevented) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const elements = [...root.querySelectorAll<HTMLElement>('button, input, a[href], select, textarea, [tabindex], [contenteditable="true"]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]')
      && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
  const first = elements[0], last = elements.at(-1)
  const active = document.activeElement
  if (!first || !last) { event.preventDefault(); root.focus(); return }
  const outsideCycle = !(active instanceof HTMLElement) || !elements.includes(active)
  if (event.shiftKey && (active === first || outsideCycle)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || outsideCycle)) { event.preventDefault(); first.focus() }
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  document.addEventListener('keydown', onKey, true)
  if (document.hasFocus()) {
    if (props.configured && !props.busy) usernameInput.value?.focus({ preventScroll: true })
    else dialog.value?.focus({ preventScroll: true })
  }
})
onBeforeUnmount(() => {
  const closingRoot = dialog.value
  const restore = Boolean(closingRoot?.contains(document.activeElement)) || document.activeElement === document.body
  document.removeEventListener('keydown', onKey, true)
  password.value = ''
  queueMicrotask(() => {
    // Return only unclaimed foreground focus; a new dialog or another window
    // keeps ownership. This never resumes game input or requests Pointer Lock.
    const active = document.activeElement
    const unclaimed = active === document.body || Boolean(closingRoot?.contains(active))
    if (restore && unclaimed && document.hasFocus() && previousFocus?.isConnected && !previousFocus.closest('[inert]')
      && !document.querySelector('[aria-modal="true"]')) previousFocus.focus({ preventScroll: true })
  })
})
</script>

<template>
  <div class="model-admin-backdrop" @click.self="close">
    <section ref="dialog" class="model-admin-login" role="dialog" aria-modal="true" aria-labelledby="model-admin-title" aria-describedby="model-admin-description" tabindex="-1">
      <header><span class="model-admin-seal" aria-hidden="true">8</span><button type="button" aria-label="Закрыть вход администратора" @click="close">Закрыть</button></header>
      <p class="model-admin-eyebrow">POOLTOOL · БИБЛИОТЕКА АССЕТОВ</p>
      <h1 id="model-admin-title">Вход администратора</h1>
      <p id="model-admin-description">Управление общими моделями стола и окружения. Игровой профиль не предоставляет административный доступ.</p>
      <p v-if="!configured" class="model-admin-warning" role="status">Доступ администратора ещё не настроен на сервере. Обратитесь к владельцу проекта.</p>
      <p v-if="error" class="model-admin-warning" role="alert">{{ error }}</p>
      <form v-if="configured" @submit.prevent="submit">
        <label><span>Логин</span><input ref="usernameInput" v-model="username" name="username" autocomplete="username" maxlength="160" :disabled="busy" required /></label>
        <label><span>Пароль</span><input v-model="password" name="password" type="password" autocomplete="current-password" maxlength="256" :disabled="busy" required /></label>
        <p class="model-admin-security">Пароль не сохраняется в настройках игры. Доступ действует только в текущей административной сессии.</p>
        <button class="model-admin-submit" type="submit" :disabled="!canSubmit">{{ busy ? 'Проверяем доступ…' : 'Войти в библиотеку' }}</button>
      </form>
      <button v-else class="model-admin-submit" type="button" @click="close">Вернуться к библиотеке</button>
    </section>
  </div>
</template>

<style scoped>
.model-admin-backdrop { position:fixed; inset:0; z-index:80; overflow:auto; display:flex; padding:32px 20px; background:rgba(7,15,12,.85); color:#f1ede1; font-family:'Pooltool Inter',sans-serif; }
.model-admin-login { width:480px; max-width:100%; margin:auto; padding:32px; background:rgba(17,27,25,.98); border:1px solid #465048; border-radius:12px; box-shadow:0 18px 64px #0008; outline:none; }
.model-admin-login header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:24px; }
.model-admin-seal { display:flex; align-items:center; justify-content:center; width:42px; height:42px; border:1px solid #c7aa72; border-radius:50%; color:#c7aa72; font:30px 'Pooltool Lora',serif; }
.model-admin-login button { color:inherit; font:inherit; cursor:pointer; }
.model-admin-login header button { border:0; background:none; padding:8px 0; font-size:12px; color:#a5aea6; }
.model-admin-eyebrow { margin:0 0 12px; font-size:9px; color:#c7aa72; letter-spacing:2px; }
.model-admin-login h1 { margin:0 0 16px; font:32px/1.2 'Pooltool Lora',serif; color:#f1ede1; }
.model-admin-login p { color:#a5aea6; font-size:12px; line-height:1.7; }
.model-admin-login form { display:flex; flex-direction:column; gap:18px; margin-top:24px; }
.model-admin-login label { display:flex; flex-direction:column; align-items:stretch; gap:8px; margin:0; font-size:12px; font-weight:400; }
.model-admin-login input:not([type=range]):not([type=checkbox]) { display:block; width:100%; max-width:100%; height:46px; border:1px solid #465048; border-radius:5px; padding:0 14px; color:#f1ede1; background:#0b1312; font:14px 'Pooltool Inter',sans-serif; }
.model-admin-login .model-admin-warning { color:#e5b38d; border-left:2px solid #c7aa72; padding-left:12px; }
.model-admin-login .model-admin-security { margin:0; font-size:11px; }
.model-admin-login .model-admin-submit { display:block; width:100%; min-height:54px; border:1px solid #c7aa72; border-radius:5px; padding:12px 18px; background:#c7aa72; color:#1a201b; font-size:15px; font-weight:600; }
.model-admin-login .model-admin-submit:hover:not(:disabled) { background:#d4bb8c; }
.model-admin-login button:disabled { cursor:not-allowed; opacity:.5; }
.model-admin-login button:focus-visible, .model-admin-login input:focus-visible { outline:2px solid #c7aa72; outline-offset:3px; }
@media(max-width:480px) { .model-admin-backdrop { padding:20px 16px; } .model-admin-login { padding:24px 20px; } .model-admin-login h1 { font-size:28px; } }
</style>
