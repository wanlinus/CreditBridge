<script setup lang="ts">
/**
 * 外壳布局：导航条 + 面包屑 + 标题区 + 内容插槽。
 *
 * 对应 v2 的 `renderPage()`。三件事和 v2 保持一致：
 *
 *   1. **导航高亮由路由的 `meta.section` 驱动**，不由页面传 `active`——v2 是每页传一遍，
 *      漏传的那页导航条就全不高亮。
 *   2. **计数由后端给**：账号数 / 密钥数取 `/api/accounts` 与 `/api/keys` 返回的数组长度，
 *      不在前端按状态过滤后重数（那会和网关自己的口径分叉）。
 *   3. **面包屑只在二级页出现**，一级页不显示。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { getHealth, logout } from '@/api/config';
import { useAsync } from '@/composables/useAsync';
import { accountCount, keyCount, refreshNavCounts } from '@/composables/useNavCounts';
import { fmtTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const loggingOut = ref(false);

/**
 * 退出：先让服务端清会话，再跳登录页。
 *
 * 顺序不能反——先跳转再清会话的话，用户能在登录页用后退键回到一个「看起来还登录着」
 * 的界面（数据请求会 401，但那一瞬间的旧页面很误导）。
 */
async function signOut(): Promise<void> {
  loggingOut.value = true;
  try {
    await logout();
  } catch {
    // 网关不可达也照样跳：本地已经没有可用的会话了，留在这一页只会一直 401。
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

/**
 * 启动时间。`/api/health` 给的是 ISO 串（UTC），直接显示会比本地时间早 8 小时——
 * 设置页早就改成 `fmtTime()` 了，这里跟着改，否则同一个事实在页脚和设置页不一样。
 */
const startedAtText = computed(() => {
  const raw = health.data.value?.startedAt;
  if (!raw) return '';
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? fmtTime(ts) : String(raw);
});

/**
 * 计数走模块级共享状态（`useNavCounts`），**不是本组件自己发请求**：
 * 否则在密钥页新建一把 key 之后，导航条还是「密钥 0」——看起来像没建成。
 */
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

/** 面包屑：二级页显示「一级 / 当前」。一级页返回空数组。 */
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

/**
 * 副标题。放路由 `meta.subtitle` 而不是让每个视图填插槽——视图渲染在
 * `<router-view />` 里，够不到外壳 `.head` 区域的那个插槽。
 */
const pageSubtitle = computed(() => (route.meta.subtitle as string | undefined) ?? '');

/** 网关是否「看起来是全新的」：一个账号都没有时给一条部署提示。 */
const looksFresh = computed(() => accountCount.value === 0);

/**
 * 404 页上不显示「还没有账号」那条提示。
 *
 * 它是一级页的引导文案，出现在「你打错地址了」的页面上只会让人多看一眼、
 * 而且和 404 的说明互相干扰。
 */
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

/* 「退出」是 button 不是 a：它要发一个请求，不是导航。这里把浏览器默认样式抹平。 */
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
