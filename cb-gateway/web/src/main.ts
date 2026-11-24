import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { setNavigator } from './api/client';

import './styles/app.css';

/**
 * 把「跳登录 / 跳改密」注册给 api 层。
 *
 * 在 router 建好之后、挂载之前注册。`api/client.ts` 不直接 import router 是为了避免
 * `router → View → api → router` 的循环依赖（见那个文件顶部的说明）。
 */
setNavigator((kind) => {
  const name = kind === 'login' ? 'login' : 'password';
  // `replace` 而不是 `push`：401 之后按浏览器后退不该回到那个已经失效的页面。
  // 已经在目标页时不要重复导航，否则 vue-router 会抛冗余导航错误。
  if (router.currentRoute.value.name !== name) {
    void router.replace({ name });
  }
});

createApp(App).use(router).mount('#app');
