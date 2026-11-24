/**
 * `WebAssembly` 的最小类型声明。
 *
 * ## 为什么需要这个文件
 *
 * 本项目 `tsconfig.json` 的 `lib` 只有 `["ES2023"]`（不引 DOM），而 `WebAssembly`
 * 的全局类型定义在 DOM lib 里。但它是 **Node 自带的能力**（`node --version` 有
 * `WebAssembly` 全局对象），不是浏览器专属。所以不能为了它去引整个 DOM lib——
 * 那会让 `document` / `window` 之类出现在类型里，掩盖「服务端代码误用浏览器 API」。
 *
 * 折中：只声明我们真正用到的 4 个东西。范围窄到不会误伤，够用。
 *
 * ## 什么时候该删掉它
 *
 * 上游哪天把 wasm 换成 HTTP 接口、`cosy/` 整个目录被删时，这个文件一起删。
 */
declare namespace WebAssembly {
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }

  interface ModuleExportDescriptor {
    name: string;
    kind: 'function' | 'table' | 'memory' | 'global';
  }

  interface ModuleImportDescriptor {
    module: string;
    name: string;
    kind: 'function' | 'table' | 'memory' | 'global';
  }

  class Module {
    constructor(bytes: BufferSource);
    static exports(module: Module): ModuleExportDescriptor[];
    static imports(module: Module): ModuleImportDescriptor[];
  }

  interface Exports {
    [key: string]: any;
  }

  class Instance {
    constructor(module: Module, imports?: Record<string, Record<string, any>>);
    readonly exports: Exports;
  }
}
