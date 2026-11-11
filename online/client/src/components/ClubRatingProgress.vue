<script setup lang="ts">
import { computed } from 'vue'
import { profileRatingMilestone } from '../profileDetails'
import '../club-profile-qa.css'

const props = defineProps<{ elo: number }>()
const number = new Intl.NumberFormat('ru-RU')
const milestone = computed(() => profileRatingMilestone(props.elo))
const description = computed(() => milestone.value ? `До ${number.format(milestone.value.target)} Эло осталось ${number.format(milestone.value.remaining)}` : '')
</script>

<template>
  <div v-if="milestone" class="club-rating-progress">
    <p>{{ description }}</p>
    <div class="club-rating-track" role="meter" aria-label="Прогресс рейтинга"
      :aria-valuemin="milestone.start" :aria-valuemax="milestone.target" :aria-valuenow="milestone.elo" :aria-valuetext="description">
      <span :style="{ width: `${milestone.percent}%` }" aria-hidden="true"></span>
    </div>
  </div>
</template>
