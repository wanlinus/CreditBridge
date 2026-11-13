<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string;
    flush?: boolean;
  }>(),
  { title: '', flush: false },
);
</script>

<template>
  <section class="card">
    <div v-if="title || $slots.title || $slots.actions" class="title">
      <slot name="title"><span>{{ title }}</span></slot>
      <span class="grow" />
      <slot name="actions" />
    </div>
    <div class="body" :class="{ flush }">
      <slot />
    </div>
  </section>
</template>
