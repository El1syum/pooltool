<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ titleId: string; dialogClass: string; backdropClass?: string; returnFocusSelector?: string }>()
const emit = defineEmits<{ close: [] }>()
const backdrop = ref<HTMLDivElement | null>(null)
const dialog = ref<HTMLElement | null>(null)
let previous: HTMLElement | null = null
const inertSiblings: Array<{ element: HTMLElement; inert: boolean }> = []

function focusable() {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]') || [])]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]')
      && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
}
function onKey(event: KeyboardEvent) {
  const root = dialog.value
  const modals = document.querySelectorAll('[aria-modal="true"]')
  if (!root || modals.item(modals.length - 1) !== root) return
  // App's capture handler owns the match Escape/back-phase policy. Respect it
  // so Esc on surrender confirmation cancels only that confirmation.
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault(); event.stopPropagation(); emit('close'); return
  }
  if (event.key !== 'Tab' || event.defaultPrevented) return
  const elements = focusable(), first = elements[0], last = elements.at(-1)
  const active = document.activeElement
  if (!first || !last) { event.preventDefault(); root.focus(); return }
  const inCycle = elements.includes(active as HTMLElement)
  if (event.shiftKey && (active === first || !inCycle)) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (active === last || !inCycle)) {
    event.preventDefault(); first.focus()
  }
}

onMounted(() => {
  previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  // Inert only siblings along the dialog's ancestor path, never its ancestors.
  // Existing inert state is restored exactly; the scene also keeps its normal
  // modal input gate, independent of keyboard focus.
  let branch: HTMLElement | null = backdrop.value
  while (branch?.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertSiblings.push({ element: sibling, inert: sibling.inert })
        sibling.inert = true
      }
    }
    if (branch.parentElement === document.body) break
    branch = branch.parentElement
  }
  document.addEventListener('keydown', onKey, true)
  if (document.hasFocus()) dialog.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  const closingRoot = dialog.value
  const restore = Boolean(closingRoot?.contains(document.activeElement)) || document.activeElement === document.body
  document.removeEventListener('keydown', onKey, true)
  for (const { element, inert } of inertSiblings) element.inert = inert
  queueMicrotask(() => {
    // Do not steal focus after window blur or from the next dialog in a
    // menu→settings/rules transition, and never request Pointer Lock here.
    const target = previous?.isConnected ? previous
      : props.returnFocusSelector ? document.querySelector<HTMLElement>(props.returnFocusSelector) : null
    const active = document.activeElement
    const unclaimed = active === document.body || Boolean(closingRoot?.contains(active))
    if (restore && unclaimed && document.hasFocus() && target && !target.closest('[inert]')
      && !document.querySelector('[aria-modal="true"]')) target.focus({ preventScroll: true })
  })
})
</script>

<template>
  <div ref="backdrop" class="modal-backdrop" :class="backdropClass" @click.self="emit('close')">
    <section ref="dialog" :class="dialogClass" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
      <slot />
    </section>
  </div>
</template>
