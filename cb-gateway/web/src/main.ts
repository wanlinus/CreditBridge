import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { setNavigator } from './api/client';

import './styles/app.css';

setNavigator((kind) => {
  const name = kind === 'login' ? 'login' : 'password';
  if (router.currentRoute.value.name !== name) {
    void router.replace({ name });
  }
});

createApp(App).use(router).mount('#app');
