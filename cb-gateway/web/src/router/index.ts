import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

import ShellLayout from '@/layouts/ShellLayout.vue';
import LoginView from '@/views/LoginView.vue';
import PasswordView from '@/views/PasswordView.vue';
import NotFoundView from '@/views/NotFoundView.vue';
import OverviewView from '@/views/OverviewView.vue';
import AccountsView from '@/views/AccountsView.vue';
import AccountDetailView from '@/views/AccountDetailView.vue';
import KeysView from '@/views/KeysView.vue';
import ModelsView from '@/views/ModelsView.vue';
import CheckinView from '@/views/CheckinView.vue';
import SettingsView from '@/views/SettingsView.vue';

const routes: RouteRecordRaw[] = [
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
          subtitle: '余额、消耗和账号状态。要改东西去左侧的「账号」或「密钥」。',
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
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
