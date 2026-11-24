<script setup lang="ts">
/**
 * 通道图标。
 *
 * `icon` 是网关从 `channels/<name>/icon.png` 读出来的 data URI；**缺图时退回 `letter`**
 * （通道名首字）。这两条都由响应决定，前端不维护通道清单、也不内联图片。
 *
 * 注意 2026-11 踩过的坑：插件里曾经有一张**内联的图标表**，Loomy 上线后少了一行，
 * 注释还写着「缺了会退回名字首字母」——而那段兜底根本不存在，实际是静默留白。
 * 所以这里宁可多写一行 `v-else`，也不假设「图标一定有」。
 */
defineProps<{
  icon?: string | null;
  letter?: string;
  /** 显示尺寸（px）。默认 20。 */
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
