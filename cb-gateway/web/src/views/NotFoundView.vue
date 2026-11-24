<script setup lang="ts">
/**
 * 404 视图。
 *
 * 放在 ShellLayout 里而不是顶层：地址写错时还能看到导航条，比一屏白好。
 *
 * **两个坑**（都是实测出来的，不是想出来的）：
 *
 * ① **不要自己再写一个 `<h2>没有这个页面</h2>`**。标题已经由 ShellLayout 从
 *    `meta.title` 渲染了，视图里再写一遍就是同屏出现两次「没有这个页面」。
 *
 * ② **路径要用 `location.pathname`，不能用 `route.fullPath`**。vue-router 的
 *    `fullPath` 是**去掉 base 之后**的路径。base 现在是 `/`，两者碰巧一样，但这条
 *    依赖不该存在：要的永远是「用户敲了什么」，所以读浏览器原文。
 */
const path = window.location.pathname + window.location.search;
</script>

<template>
  <div class="card">
    <div class="body">
      <p>
        路径 <code>{{ path }}</code> 在网关里不存在。
      </p>
      <p class="muted">
        如果你是直接敲的地址，检查一下拼写；如果是从别处点过来的，那个链接过期了。
      </p>
      <p><router-link to="/">回概览</router-link></p>
    </div>
  </div>
</template>

<style scoped>
p {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.8;
}
</style>
