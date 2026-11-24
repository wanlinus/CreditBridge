/// <reference types="vite/client" />

/**
 * `.vue` 文件的类型声明。
 *
 * `vue-tsc` 能直接理解 SFC，但编辑器里的 `tsc` 语言服务需要这个 shim 才知道
 * `import Foo from './Foo.vue'` 是什么。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
