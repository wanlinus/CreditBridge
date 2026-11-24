/**
 * wasm-bindgen 的 import 对象——**从 bundle 原文抄录**，不要手改。
 *
 * ## 为什么用原文而不是自己写
 *
 * 这些函数看着简单（取长度、建数组、取随机数），但**指针和堆句柄混在一起**：
 *
 *   __wbg_length_(A)                A 是**堆句柄** -> eB(A).length
 *   __wbg_new_with_length_(A)       A 是**数字**    -> Mw(new Uint8Array(A>>>0))
 *   __wbg_prototypesetcall_(A,e,t)  前两个是指针，第三个是句柄
 *
 * 还有一套**空闲链表**的堆管理（Mw 入堆、xel 回收、eB 出堆）。
 * 自己实现极易写成「单调递增」而漏掉槽位复用——
 * 表现是签名算出来是错的但不报错，最难查的一类。
 *
 * 第一版手写胶水就是这么错的：构造 QoderContext 时报
 *   Cannot read properties of undefined (reading call)
 * 栈里全是单字母变量名，只能靠给每个 import 套日志才定位到。
 *
 * ## 使用时必须和 helpers.mjs 在同一作用域
 *
 * 它引用 helpers 里定义的 `en`/`DAe`/`bmA`。分成两份作用域就会各有各的值堆，
 * 句柄串号（表现是 `handle=1030 超过 DAe.length` 这类越界）。
 * 所以由 `index.ts` 把两个文件拼进同一个 Function 再执行。
 */
export function createImportsObject(){return{__proto__:null,"./qoder_auth_wasm_bg.js":{__proto__:null,__wbg_Error_2e59b1b37a9a34c3:function(A,e){return Mw(Error(YD(A,e)))},__wbg___wbindgen_is_function_49868bde5eb1e745:function(A){return"function"==typeof eB(A)},__wbg___wbindgen_is_object_40c5a80572e8f9d3:function(A){let e=eB(A);return"object"==typeof e&&null!==e},__wbg___wbindgen_is_string_b29b5c5a8065ba1a:function(A){return"string"==typeof eB(A)},__wbg___wbindgen_is_undefined_c0cca72b82b86f4d:function(A){return void 0===eB(A)},__wbg___wbindgen_throw_81fc77679af83bc6:function(A,e){throw new Error(YD(A,e))},__wbg_call_d578befcc3145dee:function(){return RmA(function(A,e,t){return Mw(eB(A).call(eB(e),eB(t)))},arguments)},__wbg_crypto_38df2bab126b63dc:function(A){return Mw(eB(A).crypto)},__wbg_getRandomValues_c44a50d8cfdaebeb:function(){return RmA(function(A,e){eB(A).getRandomValues(eB(e))},arguments)},__wbg_getRandomValues_d49329ff89a07af1:function(){return RmA(function(A,e){globalThis.crypto.getRandomValues(tYe(A,e))},arguments)},__wbg_length_0c32cb8543c8e4c8:function(A){return eB(A).length},__wbg_msCrypto_bd5a034af96bcba6:function(A){return Mw(eB(A).msCrypto)},__wbg_new_99cabae501c0a8a0:function(){return Mw(new Map)},__wbg_new_with_length_9cedd08484b73942:function(A){return Mw(new Uint8Array(A>>>0))},__wbg_node_84ea875411254db1:function(A){return Mw(eB(A).node)},__wbg_now_88621c9c9a4f3ffc:function(){return Date.now()},__wbg_process_44c7a14e11e9f69e:function(A){return Mw(eB(A).process)},__wbg_prototypesetcall_3e05eb9545565046:function(A,e,t){Uint8Array.prototype.set.call(tYe(A,e),eB(t))},__wbg_randomFillSync_6c25eac9869eb53c:function(){return RmA(function(A,e){eB(A).randomFillSync(Kk(e))},arguments)},__wbg_require_b4edbdcf3e2a1ef0:function(){return RmA(function(){return Mw(module.require)},arguments)},__wbg_set_08463b1df38a7e29:function(A,e,t){return Mw(eB(A).set(eB(e),eB(t)))},__wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f:function(){let A=typeof globalThis>"u"?null:globalThis;return yAe(A)?0:Mw(A)},__wbg_static_accessor_GLOBAL_f2e0f995a21329ff:function(){let A=typeof global>"u"?null:global;return yAe(A)?0:Mw(A)},__wbg_static_accessor_SELF_24f78b6d23f286ea:function(){let A=typeof self>"u"?null:self;return yAe(A)?0:Mw(A)},__wbg_static_accessor_WINDOW_59fd959c540fe405:function(){let A=typeof window>"u"?null:window;return yAe(A)?0:Mw(A)},__wbg_subarray_0f98d3fb634508ad:function(A,e,t){return Mw(eB(A).subarray(e>>>0,t>>>0))},__wbg_versions_276b2795b1c6a219:function(A){return Mw(eB(A).versions)},__wbindgen_cast_0000000000000001:function(A,e){return Mw(tYe(A,e))},__wbindgen_cast_0000000000000002:function(A,e){return Mw(YD(A,e))},__wbindgen_object_clone_ref:function(A){return Mw(eB(A))},__wbindgen_object_drop_ref:function(A){Kk(A)}}}}
