<script setup lang="ts">
/**
 * 扫码验证卡片：显示上游给的二维码，用户用已登录的豆包扫。
 *
 * 二维码是**会过期**的（上游 60 秒）。到期后不能继续用同一张码，
 * 要换一张——这个动作交给用户点「刷新二维码」，不自动做。
 *
 * 为什么不让网关自动换：换码只发生在后端，界面上的 `<img>` 还是旧数据。
 * 用户对着旧二维码扫，永远扫不进去，而他不知道图已经变了。让用户点一下，
 * 界面才会真的换图。
 *
 * **别用 `qrcode_index_url`**：那个字段名像图片，实际是 `scan-login` 的 HTML 页面
 * （40KB、`<!DOCTYPE`），塞进 `<img src>` 白板一片。真正的图在 `qrcode` 字段。
 */
import { computed } from 'vue';

const props = defineProps<{
  /** 二维码图片地址（data URI 或远程 URL）。 */
  src: string;
  /** 网关处理中，刷新按钮要禁掉（防连点换掉两张）。 */
  disabled: boolean;
}>();

const emit = defineEmits<{ (e: 'refresh'): void }>();

/** 上游给的是 512×512 PNG，但按 200 显示更合适——太高会撑破弹窗。 */
const imageSrc = computed(() => props.src);
</script>

<template>
  <div class="qr">
    <div class="frame">
      <img class="image" :src="imageSrc" alt="扫码验证二维码" referrerpolicy="no-referrer" />
    </div>
    <div class="actions">
      <button type="button" class="btn sm" :disabled="disabled" @click="emit('refresh')">
        刷新二维码
      </button>
      <span class="hint">二维码大约 60 秒过期，过期就点这里换一张</span>
    </div>
    <p class="note">用已登录豆包的手机扫这个码，在手机上点确认，然后回来点按钮。</p>
  </div>
</template>

<style scoped>
.qr {
  display: grid;
  gap: 10px;
  justify-items: center;
}

.frame {
  position: relative;
  width: 200px;
  height: 200px;
  padding: 8px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 10px;
}

.image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* 二维码必须保持像素锐利，缩放模糊会扫不出来 */
  image-rendering: pixelated;
}

/* 刷新按钮和说明同一行：说明是按钮的注释，分两行会被忽略。 */
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.hint {
  font-size: 11px;
  color: var(--muted);
}

.note {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  text-align: center;
}
</style>
