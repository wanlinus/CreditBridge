<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getHealth, logout } from '@/api/config';
import { useAsync } from '@/composables/useAsync';
import { accountCount, keyCount, refreshNavCounts } from '@/composables/useNavCounts';
import { fmtTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const loggingOut = ref(false);

async function signOut(): Promise<void> {
  loggingOut.value = true;
  try {
    await logout();
  } catch {
  } finally {
    loggingOut.value = false;
    void router.push('/login');
  }
}

interface NavItem {
  key: string;
  label: string;
  to: string;
  count?: number;
}

const health = useAsync(getHealth);

const startedAtText = computed(() => {
  const raw = health.data.value?.startedAt;
  if (!raw) return '';
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? fmtTime(ts) : String(raw);
});

onMounted(() => {
  void refreshNavCounts();
});

const navItems = computed<NavItem[]>(() => [
  { key: 'overview', label: '概览', to: '/' },
  { key: 'accounts', label: '账号', to: '/accounts', count: accountCount.value ?? undefined },
  { key: 'keys', label: '密钥', to: '/keys', count: keyCount.value ?? undefined },
  { key: 'models', label: '模型', to: '/models' },
  { key: 'checkin', label: '签到', to: '/checkin' },
  { key: 'settings', label: '设置', to: '/settings' },
]);

const activeSection = computed(() => (route.meta.section as string | undefined) ?? '');

const crumb = computed<{ label: string; to?: string }[]>(() => {
  if (route.name === 'account-detail' || route.name === 'account-usage' || route.name === 'account-models') {
    const id = String(route.params.id ?? '');
    return [
      { label: '账号', to: '/accounts' },
      { label: id },
    ];
  }
  return [];
});

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '');

const pageSubtitle = computed(() => (route.meta.subtitle as string | undefined) ?? '');

const looksFresh = computed(() => accountCount.value === 0);

const showFreshHint = computed(() => looksFresh.value && route.name !== 'not-found');
</script>

<template>
  <div class="shell">
    <div class="wrap">
      <nav class="nav">
        <span class="brand"><span class="dot" />积分桥</span>

        <router-link
          v-for="item in navItems"
          :key="item.key"
          :to="item.to"
          class="item"
          :class="{ active: activeSection === item.key }"
          :aria-current="activeSection === item.key ? 'page' : undefined"
        >
          {{ item.label }}
          <span v-if="typeof item.count === 'number'" class="count">{{ item.count }}</span>
        </router-link>

        <span class="right">
          <span v-if="health.data.value" class="where">
            v{{ health.data.value.version }} · 签到 {{ health.data.value.checkinTime }}
          </span>
          <button type="button" class="item link" :disabled="loggingOut" @click="signOut">
            {{ loggingOut ? '退出中…' : '退出' }}
          </button>
        </span>
      </nav>

      <p v-if="showFreshHint" class="fresh">
        还没有任何账号。去
        <router-link to="/accounts">账号页</router-link>
        点「+ 添加账号」，登录完它会自动出现在列表里。
      </p>

      <div v-if="crumb.length" class="crumb">
        <template v-for="(item, index) in crumb" :key="item.label">
          <router-link v-if="item.to" :to="item.to">{{ item.label }}</router-link>
          <span v-else>{{ item.label }}</span>
          <span v-if="index < crumb.length - 1" class="sep">/</span>
        </template>
      </div>

      <div class="head">
        <div>
          <h1>{{ pageTitle }}</h1>
          <p v-if="pageSubtitle" class="sub">{{ pageSubtitle }}</p>
        </div>
      </div>

      <router-view />

      <footer class="foot">
        CreditBridge · 网关管理台
        <template v-if="startedAtText"> · 启动于 {{ startedAtText }}</template>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.nav {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 12px 0;
  margin-bottom: 22px;
  border-bottom: 1px solid var(--line);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  margin-right: 14px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
}

.item {
  padding: 5px 11px;
  border-radius: 7px;
  color: var(--muted);
}

button.item.link {
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
  cursor: pointer;
}

button.item.link:disabled {
  opacity: 0.6;
  cursor: default;
}

.item:hover {
  background: var(--card2);
  color: var(--fg);
  text-decoration: none;
}

.item.active {
  background: var(--accent);
  color: #fff;
}

.count {
  display: inline-block;
  min-width: 17px;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--card2);
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

.item:hover .count {
  background: #e4e7ec;
}

.item.active .count {
  background: rgba(255, 255, 255, 0.26);
  color: #fff;
}

.right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.where {
  color: var(--muted);
  font-size: 12px;
  margin-right: 10px;
}

.crumb {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 6px;
}

.crumb a {
  color: var(--muted);
}

.crumb a:hover {
  color: var(--accent);
}

.sep {
  margin: 0 6px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.head h1 {
  font-size: 20px;
  margin: 0 0 3px;
  font-weight: 600;
  letter-spacing: -0.2px;
}

.sub {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.fresh {
  margin: 0 0 16px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  background: var(--accent-weak);
  font-size: 13px;
}

.foot {
  margin-top: 32px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
</style>
