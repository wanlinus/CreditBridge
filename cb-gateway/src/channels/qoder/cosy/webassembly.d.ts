// `WebAssembly` 的最小类型声明：tsconfig 的 `lib` 只有 ES2023（不引 DOM），而 `WebAssembly`
// 的类型在 DOM lib 里；但它其实是 Node 自带能力。引整个 DOM lib 会让 `document`/`window`
// 混进类型、掩盖服务端误用浏览器 API。只声明用到的这几个，`cosy/` 目录删时一起删。
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
