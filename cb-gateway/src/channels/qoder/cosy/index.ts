/** 把 COSY 签名器包成网关能直接用的接口。三个约束：① **wasm 模块只能执行一次**，两次会产生两份值堆、句柄串号（`handle=1030 超过 DAe.length`）；
 * ② `en` 必须在实例化之后注入（imports 里的函数只在运行时读它）；③ `Cosy-Key` 不是算出来的，是 `userInfo.key` 原样透传，传空上游回内层 `Signature invalid`。 */

import fs from 'node:fs';
import path from 'node:path';

// 版本串的唯一来源在 `login.ts`（那边要拼 `User-Agent`），这里 re-export 成签名器用的名字。
export { QODER_CLI_VERSION as COSY_VERSION } from '../login.ts';

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
  /** 解密上游加密的响应体（`/sash/*` 这类接口会返回密文）。 */
  decryptServerResponse: (payload: string) => string;
  /** 从 `{uid, security_oauth_token, data_policy_agreed}` 现算 `{encrypt_user_info, key}`—— 这两个值**不是服务端下发的**。
   * 输入必须**恰好三个字段**：多传 `organization_id: ""` 输出会从 172 字节变 236 字节，签名直接失效。 */
  generateRuntimeAuthFields: (runtimeJson: string) => string;
}

let runtimePromise: Promise<CosyRuntime> | null = null;

function cosyDir(): string {
  // Windows 上 `pathname` 带前导 `/D:/`，必须剥掉；否则 readFileSync 找不到文件。
  const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  return path.dirname(decodeURIComponent(self));
}

/**
 * 加载并初始化签名器。**只会真正执行一次**，并发调用共享同一个 Promise——
 * 模块里的值堆是全局状态，重复执行会让句柄错位，而错位后的表现是签名算错但不报错。
 */
export function getCosyRuntime(): Promise<CosyRuntime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const dir = cosyDir();
    const wasmBytes = fs.readFileSync(path.join(dir, 'qoder_auth_wasm_bg.wasm'));
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

    // 4 份抄录代码（桩 + helpers + imports-object + glue + exports）拼进**同一个作用域**再执行一次。
    // imports-object 里的函数要引用 helpers 定义的 `DAe`/`bmA`；分两个作用域就各有各的堆、句柄串号。
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

/** 从 `dt-` 现算 COSY 签名要用的 `{uid, encrypt_user_info, key}`——`encrypt_user_info` 和 `key` 是**本地算的**，不是服务端下发。
 * 输入必须**恰好三个字段**：实测同一个 dt-，三字段得 172 字节（与真实值一致）、多带 `organization_id: ""` 得 236、少 `data_policy_agreed` 得 152，长度不对就只表现为 `Signature invalid`，看不出是输入少了字段。 */
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
