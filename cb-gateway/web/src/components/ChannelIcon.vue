<script setup lang="ts">
defineProps<{
  icon?: string | null;
  letter?: string;
  size?: number;
  alt?: string;
}>();
</script>

<template>
  <span class="icon" :style="{ width: `${size ?? 20}px`, height: `${size ?? 20}px` }" :title="alt">
    <img v-if="icon" :src="icon" :alt="alt || ''" />
    <span v-else class="letter" :style="{ fontSize: `${Math.round((size ?? 20) * 0.55)}px` }">{{ letter || '?' }}</span>
  </span>
</template>

<style scoped>
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 5px;
  overflow: hidden;
}

img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--card2);
  color: var(--muted);
  font-weight: 600;
  line-height: 1;
}
</style>
