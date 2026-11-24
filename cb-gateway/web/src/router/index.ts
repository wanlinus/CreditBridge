/**
 * 路由表。
 *
 * **`meta.section` 决定导航高亮**，而不是每个页面自己传 `active`——v2 是每页传一遍，
 * 漏传的那页导航条就全不高亮。这里一处声明就够了。
 *
 * 用 **history 模式**：地址栏是 `/accounts/tr-3` 而不是 `/#/accounts/tr-3`。
 * 代价是服务端必须把未知的 GET 路径回 index.html（见 `src/app.ts` 的 `createSpaApp`），
 * 否则刷新一次就 404。
 *
 * ## 视图一律懒加载（2026-11-22）
 *
 * 改前是 11 个静态 `import`，全部打进一个 664.9 KB 的 `index-*.js`。而那里面
 * **476.7 KB 是 ECharts**（`installCanvasRenderer` 那个 chunk），它只被
 * `TrendChart.vue` / `DayUsageView.vue` 用到——也就是说**打开登录页也要先把图表库
 * 下完**。
 *
 * 实测（改完真的构建了一次）：
 *
 *   首屏 JS   664.9 KB → 106.9 KB
 *   首屏 CSS   26.6 KB →   5.5 KB
 *   首屏合计  691.5 KB → 112.4 KB（−84%）
 *   代价：文件数 1 → 25，总体积 +8.5 KB（模块包装开销），首屏到内页多一次往返
 *
 * **`ShellLayout` 保持静态 import**：它是所有内页的壳，懒加载它没有任何收益
 * （每个内页都要它），只会多一次串行往返。
 *
 * 别改回静态 import：那样首屏又会把 ECharts 一起拖下来，而且**不会有任何报错**
 * ——只是打开页面变慢一点，没人会注意到。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import ShellLayout from '@/layouts/ShellLayout.vue';

const LoginView = () => import('@/views/LoginView.vue');
const PasswordView = () => import('@/views/PasswordView.vue');
const NotFoundView = () => import('@/views/NotFoundView.vue');
const OverviewView = () => import('@/views/OverviewView.vue');
const DayUsageView = () => import('@/views/DayUsageView.vue');
const AccountsView = () => import('@/views/AccountsView.vue');
const AccountDetailView = () => import('@/views/AccountDetailView.vue');
const KeysView = () => import('@/views/KeysView.vue');
const ModelsView = () => import('@/views/ModelsView.vue');
const CheckinView = () => import('@/views/CheckinView.vue');
const SettingsView = () => import('@/views/SettingsView.vue');

const routes: RouteRecordRaw[] = [
  // login / password 不用 ShellLayout：它们没有导航条（对应 v2 里 `renderPage` 之外的
  // 那两条路径）。密码页尤其不能有——用户这时还没进系统。
  { path: '/login', name: 'login', component: LoginView },
  { path: '/password', name: 'password', component: PasswordView },

  {
    path: '/',
    component: ShellLayout,
    children: [
      {
        path: '',
        name: 'overview',
        component: OverviewView,
        meta: {
          section: 'overview',
          title: '概览',
          // 副标题放 meta 而不是视图里：它渲染在外壳的标题区（`.head .sub`），
          // 视图本身在 `<router-view />` 里，够不到那个插槽。
          subtitle: '余额、消耗和账号状态。要改东西去左侧的「账号」或「密钥」。',
        },
      },
      {
        path: 'day/:date',
        name: 'day',
        component: DayUsageView,
        meta: {
          section: 'overview',
          title: '单日用量',
          subtitle: '某一天按 24 小时拆开：Token 和折合费用可以切，峰时段是实色。',
        },
      },
      {
        path: 'accounts',
        name: 'accounts',
        component: AccountsView,
        meta: {
          section: 'accounts',
          title: '账号',
          subtitle: '一个通道可以挂多个上游号，每个号一套模型 id，花的是它自己的额度。',
        },
      },
      // 三条路由共用 `AccountDetailView`，tab 由路径决定（见那个文件头部的说明）。
      {
        path: 'accounts/:id',
        name: 'account-detail',
        component: AccountDetailView,
        meta: {
          section: 'accounts',
          title: '账号详情',
          subtitle: '排查一个号：余额、签到、这个号实际能用到哪些模型。',
        },
      },
      {
        path: 'accounts/:id/usage',
        name: 'account-usage',
        component: AccountDetailView,
        meta: { section: 'accounts', title: '账号用量', subtitle: '这个号最近的消耗，按模型拆。' },
      },
      {
        path: 'accounts/:id/models',
        name: 'account-models',
        component: AccountDetailView,
        meta: { section: 'accounts', title: '账号模型', subtitle: '上游实际给了这个号哪些模型（不受可见性影响）。' },
      },
      {
        path: 'models',
        name: 'models',
        component: ModelsView,
        meta: {
          section: 'models',
          title: '模型',
          subtitle: '哪些模型愿意暴露给 /v1/models。关掉的，DSH 下一次同步就看不到了。',
        },
      },
      {
        path: 'keys',
        name: 'keys',
        component: KeysView,
        meta: {
          section: 'keys',
          title: '密钥',
          subtitle: '给程序用的凭据。浏览器会话和它是两套，互不影响。',
        },
      },
      {
        path: 'checkin',
        name: 'checkin',
        component: CheckinView,
        meta: {
          section: 'checkin',
          title: '签到',
          subtitle: '每天自动签一次；这里能看历史，也能手动补一次。',
        },
      },
      {
        path: 'settings',
        name: 'settings',
        component: SettingsView,
        meta: {
          section: 'settings',
          title: '设置',
          subtitle: '改密码、改签到时间、看网关信息。都是低频操作。',
        },
      },
      // 兜底的 404 放在 ShellLayout 里：地址写错时还能看到导航条，不至于变成一屏白。
      {
        path: ':pathMatch(.*)*',
        name: 'not-found',
        component: NotFoundView,
        meta: { title: '没有这个页面' },
      },
    ],
  },
];

export const router = createRouter({
  // base 取 Vite 的 `BASE_URL`，它由 `vite.config.ts` 的 `base` 决定（现在是 `/`）。
  // 不硬编码 `'/'`：万一以后要挂到子路径，改一处就够，不用回来翻路由表。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
