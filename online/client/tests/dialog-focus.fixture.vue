<script setup>
import { ref, watch } from 'vue'
import AccessibleDialog from '../src/components/AccessibleDialog.vue'
const open = ref(false), next = ref(false), changed = ref(false), disabledNext = ref(false), claimOnClose = ref(false)
window.disableNextControl = value => { disabledNext.value = value }
window.resetDialogContents = () => { changed.value = false }
window.claimFocusOnClose = value => { claimOnClose.value = value }
watch(open, value => { if (!value && claimOnClose.value) document.querySelector('#background').focus() }, { flush: 'post' })
</script>
<template>
  <main><button id="opener" @click="open=true">Открыть меню</button><button id="background">Фоновое действие</button><div id="already-inert" inert><button>Ранее недоступно</button></div></main>
  <AccessibleDialog v-if="open" title-id="test-title" dialog-class="club-match-dialog" return-focus-selector="#opener" @close="open=false">
    <h1 id="test-title">Меню матча</h1><p>Проверка клавиатуры</p>
    <div class="club-dialog-actions"><button v-if="!changed" id="replace" @click="changed=true">Изменить содержимое</button>
      <button id="next" :disabled="disabledNext" @click="open=false;next=true">Следующий диалог</button><button id="close" @click="open=false">Закрыть</button></div>
  </AccessibleDialog>
  <AccessibleDialog v-if="next" title-id="next-title" dialog-class="club-match-dialog" return-focus-selector="#opener" @close="next=false"><h1 id="next-title">Правила</h1><button id="next-close" @click="next=false">Закрыть правила</button></AccessibleDialog>
</template>
