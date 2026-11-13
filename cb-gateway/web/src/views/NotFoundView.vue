<script setup lang="ts">
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
