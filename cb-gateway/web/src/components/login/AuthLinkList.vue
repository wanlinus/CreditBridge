<script setup lang="ts">
/**
 * 授权链接列表（Qoder / Trae 这类走 URL 登录的通道）。
 *
 * **可能不止一个链接**：Qoder 要授权两次（设备流、对话态）。只显示第一个会让用户
 * 卡在「进行中」——他点完第一次，页面还在等第二次，但他不知道还有第二次。
 * 所以全部列出并标上第几次。
 */
defineProps<{
  urls: string[];
}>();

/** 链接太长时中间省略，但保留开头域名和结尾，用户能认出是哪个站。 */
function shorten(url: string): string {
  if (url.length <= 72) return url;
  return `${url.slice(0, 40)}…${url.slice(-24)}`;
}
</script>

<template>
  <div v-if="urls.length > 0" class="urls">
    <div v-for="(url, index) in urls" :key="url" class="url">
      <span class="tag">{{ urls.length > 1 ? `第 ${index + 1} 次授权` : '授权' }}</span>
      <a class="link" :href="url" target="_blank" rel="noreferrer">
        <span class="text">{{ shorten(url) }}</span>
        <span class="open">打开 ↗</span>
      </a>
    </div>
    <p class="note">已尝试自动打开新标签页；没看到就点上面的链接。</p>
  </div>
</template>

<style scoped>
.urls {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
}

.url {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tag {
  flex: none;
  font-size: 11px;
  color: var(--muted);
  background: var(--card2);
  border-radius: 99px;
  padding: 1px 8px;
}

.link {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}

.link:hover .text {
  text-decoration: underline;
}

.text {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.open {
  flex: none;
  font-size: 11px;
}

.note {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
