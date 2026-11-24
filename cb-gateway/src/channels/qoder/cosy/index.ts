/**
 * 把 COSY 签名器包成网关能直接用的接口。
 *
 * ## 已验证的事实（2026-11-22）
 *
 * 用这块 313KB 的 wasm，**不启动 CLI、也不读任何 CLI 文件**，就能生成被上游
 * 接受的请求，收到真实的 `chat.completion.chunk` 流。
 *
 * 所需输入只有四样，全在本地：
 *
 * | 输入 | 来源 |
 * |---|---|
 * | `machineId` | `data/state/qoder-identity.json`（网关自造的稳定 UUID） |
 * | `COSY_VERSION` | 上游客户端版本串（`login.ts` 的 `QODER_CLI_VERSION`） |
 * | `userInfo` | **用 `dt-` 现算**（`deriveRuntimeFields`，见下） |
 * | 请求体 JSON | 我们自己拼 |
 *
 * ## 「userInfo 从 dt- 现算」是替代 CLI 的关键
 *
 * `userInfo` 的三个字段里，`uid` 来自登录，`encrypt_user_info` 和 `key`
 * **不是服务端下发的**——它们是 `generate_runtime_auth_fields()` 用这块 wasm
 * 从 `{uid, security_oauth_token, data_policy_agreed}` 算出来的。
 *
 * 所以一次设备码登录拿到的 `dt-` 就够签对话了，不需要 CLI 登录那一趟。
 * 细节见 `deriveRuntimeFields()` 的注释（尤其「输入必须恰好三个字段」那条）。
 *
 * ## 签名器的输入输出
 *
 * ```
 * new QoderContext(machineId, cosyVersion, userInfoJson, clientMetadataJson)
 *   .prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)
 *   → { url, headers, body }   // body 已加密，headers 含 20 个 cosy-* 头
 * ```
 *
 * ## 三个必须知道的约束
 *
 * 1. **模块只能执行一次**。`glue.mjs`/`imports-object.mjs` 里的值堆（`DAe`/`bmA`）
 *    是模块级状态；执行两次会产生两份堆，句柄互相串号，表现是
 *    `handle=1030 超过 DAe.length` 这种莫名其妙的越界。所以本文件用惰性单例。
 * 2. **`en` 必须在实例化之后注入**。imports 里的函数只在运行时读 `en`，
 *    所以顺序是「执行模块 → 建实例 → `setExports`」。
 * 3. **`Cosy-Key` 不是生成出来的**，它是 `userInfo.key` 的原样透传；
 *    真正的签名在 `authorization: Bearer COSY.<...>` 和加密 body 里。
 *    传空 key 会得到空 `Cosy-Key`，上游回 `Signature invalid`。
 */

import fs from 'node:fs';
import path from 'node:path';

// 版本串的唯一来源在 `login.ts`（那边要拼 `User-Agent`）。
// 这里 re-export 成 `COSY_VERSION`，因为签名器内部和 `sign.ts` 都按这个名字用。
export { QODER_CLI_VERSION as COSY_VERSION } from '../login.ts';

/** 默认推理端点。 */
export const DEFAULT_ENDPOINT = 'https://gateway.qoder.com.cn';

/** wasm 与模块句柄（惰性单例）。 */
interface CosyRuntime {
  exports: WebAssembly.Exports;
  QoderContext: new (
    machineId: string,
    cosyVersion: string,
    userInfoJson: string,
    clientMetadataJson: string,
  ) => any;
  credentialStorageDecrypt: (ciphertext: string, key: string) => string;
  /**
   * 解密上游加密的响应体（`/sash/*` 这类接口会返回密文）。
   */
  decryptServerResponse: (payload: string) => string;
  /**
   * 从 `{uid, security_oauth_token, data_policy_agreed}` 现算
   * `{encrypt_user_info, key}`。
   *
   * 这是「登录可以自实现」的关键：这两个值**不是服务端下发的**，
   * 而是 CLI 本地用 wasm 算出来的（`regenerateRuntimeFields()` 就是这么做的）。
   * 输入形状必须**恰好三个字段**——多传 `organization_id:""` 会让输出从
   * 172 字节变成 236 字节，签名直接失效。
   */
  generateRuntimeAuthFields: (runtimeJson: string) => string;
}

let runtimePromise: Promise<CosyRuntime> | null = null;

function cosyDir(): string {
  // Windows 上 `pathname` 带前导 `/D:/`，必须剥掉；否则 readFileSync 找不到文件。
  const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  return path.dirname(decodeURIComponent(self));
}

/**
 * 加载并初始化签名器。**只会真正执行一次**，并发调用共享同一个 Promise。
 *
 * 「执行一次」这条约束是硬的：模块里的值堆是全局状态，重复执行会让句柄错位，
 * 而错位后的表现是签名算错但不报错——比崩溃难查得多。
 */
export function getCosyRuntime(): Promise<CosyRuntime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const dir = cosyDir();
    const wasmBytes = fs.readFileSync(path.join(dir, 'qoder_auth_wasm_bg.wasm'));
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

    // 把 4 份抄录代码拼进**同一个作用域**，然后执行一次。
    //
    // | 片段 | 作用 |
    // |---|---|
    // | 两个桩 `w`/`Bt` | 替代原 bundle 的打包器 |
    // | `helpers.mjs` | 字符串↔内存互转 + 值堆管理（Mw/eB/xel） |
    // | `imports-object.mjs` | wasm 需要的 31 个 import（原文） |
    // | `glue.mjs` | 4 个 class（QoderContext / RequestResult / ...） |
    // | `exports.mjs` | 15 个导出包装函数（含 credential_storage_decrypt） |
    //
    // **必须同一作用域**：`imports-object.mjs` 里的函数要引用 `helpers.mjs`
    // 定义的 `DAe`/`bmA`。分成两份作用域就会各有各的堆，句柄串号
    // （表现是 `handle=1030 超过 DAe.length` 这种越界）。
    const importsSource = read('imports-object.mjs')
      .replace(/^\/\*[\s\S]*?\*\/\s*/u, '')
      .replace('export function createImportsObject()', 'function G9i()');

    const source = [
      'function w(fn){ try { fn(); } catch (e) {} }',
      'function Bt(target, getters){ return target; }',
      read('helpers.mjs'),
      importsSource,
      read('glue.mjs'),
      read('exports.mjs'),
    ].join('\n');

    // 用 `new Function` 而不是 eval：作用域干净，也不会污染调用方。
    const factory = new Function(`
      "use strict";
      ${source}
      return {
        imports: G9i(),
        setExports(x) { en = x; },
        api: {
          QoderContext: UmA,
          credentialStorageDecrypt: pel,
          generateRuntimeAuthFields: Eel,
          decryptServerResponse: hel,
        },
      };
    `);

    const built = factory();
    const mod = new WebAssembly.Module(wasmBytes);
    const instance = new WebAssembly.Instance(mod, built.imports);
    // 实例化完成后再注入 `en`——imports 里的函数只在运行时读它。
    built.setExports(instance.exports);

    return {
      exports: instance.exports,
      QoderContext: built.api.QoderContext,
      credentialStorageDecrypt: built.api.credentialStorageDecrypt,
      generateRuntimeAuthFields: built.api.generateRuntimeAuthFields,
      decryptServerResponse: built.api.decryptServerResponse,
    };
  })();

  return runtimePromise;
}

/**
 * 从 `dt-` 现算 COSY 签名要用的 `{uid, encrypt_user_info, key}`。
 *
 * ## 这一步是「登录能自实现」的关键
 *
 * `encrypt_user_info` 和 `key` 看起来像服务端下发的东西，其实是**本地算的**：
 * CLI 的 `regenerateRuntimeFields()` 里就是
 *
 * ```js
 * let A = JSON.stringify({uid, security_oauth_token, organization_id,
 *                         organization_tags, data_policy_agreed});
 * let e = JSON.parse(wasm.generate_runtime_auth_fields(A));
 * cachedUserInfo.encrypt_user_info = e.encrypt_user_info;
 * cachedUserInfo.key = e.key;
 * ```
 *
 * ## 输入形状必须**恰好三个字段**
 *
 * 实测对照（同一个 dt-）：
 *
 * | 输入 | encrypt_user_info 长度 |
 * |---|---|
 * | `{uid, security_oauth_token, data_policy_agreed}` | **172**（和真实值一致） |
 * | 多带 `organization_id: ""` | 236 |
 * | 不带 `data_policy_agreed` | 152 |
 *
 * 长度不对签名就过不了，而且**只表现为 `Signature invalid`**，看不出是输入少了字段。
 * 所以别"顺手"把 `organization_id` 加上——CLI 那段代码里虽然有它，但那是
 * `regenerateRuntimeFields()` 的另一个分支。
 */
export async function deriveRuntimeFields(input: {
  uid: string;
  token: string;
  dataPolicyAgreed: boolean;
}): Promise<{ uid: string; encrypt_user_info: string; key: string }> {
  const rt = await getCosyRuntime();
  const raw = rt.generateRuntimeAuthFields(
    JSON.stringify({
      uid: input.uid,
      security_oauth_token: input.token,
      data_policy_agreed: input.dataPolicyAgreed,
    }),
  );
  const parsed = JSON.parse(raw);
  if (typeof parsed.encrypt_user_info !== 'string' || typeof parsed.key !== 'string') {
    throw new Error('generate_runtime_auth_fields 返回里缺 encrypt_user_info 或 key');
  }
  return { uid: input.uid, encrypt_user_info: parsed.encrypt_user_info, key: parsed.key };
}
