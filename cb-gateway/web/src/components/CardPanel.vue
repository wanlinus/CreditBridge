<script setup lang="ts">
/**
 * 卡片：标题栏（可放任意内容）+ 内容区。
 *
 * **样式不在这里**：外观由 `styles/app.css` 的 `.card` 定义，那是唯一来源。早先组件
 * 自己又写了一遍 scoped 样式，改圆角要记得改两处，漏了只是某个页面看着不一样。
 *
 * 这个文件只负责结构。`#title` 插槽可以放任意节点（图标、徽标、余额），不传时回落到
 * `title` 字符串；`flush` 让内容区去掉内边距，给表格用。
 */
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
