// Trae 通道：一个上游（trae-api-cn）的协议适配器。
//
// v2 起它**不知道「有几个账号」**：凭据由账号对象传进来，通道只做协议翻译。选哪个号
// 是模型 id 的事（`tr-1/glm-5.3-flash`），路由层解析好了才叫到这里。
//
// 文件职责和另外三个通道一致：`auth` 凭据与请求头、`login` 交互式登录、
// `models` 模型目录、`upstream` 对话传输、`usage` 余额与签到。本文件只做声明和转发。

import { defineChannel } from '../types.ts';
import { configureTraeIdentity, mintSelfDeviceId, setTraeLogger } from './auth.ts';
import { traeCatalog, traeModelList, setTraeModelsLogger } from './models.ts';
import { chatTrae, setTraeUpstreamLogger } from './upstream.ts';
import { loginLoopback as traeLoginLoopback, runTraeLogin } from './login.ts';
import {
  claimCheckin,
  getCheckinStatus,
  getTraeUsage,
  readLastCheckin,
  setTraeUsageLogger,
} from './usage.ts';

/**
 * 上下文窗口的可选阶梯：50% / 75% / 100% of 这个模型自己的上限。
 *
 * 实现在 `shared/model-settings.ts`（凡是上游没给档位表的通道都用这套比例推三档），
 * 这里保留同名导出只为回归测试（`test/trae-config.mjs`）。
 */
export { contextOptions } from '../../shared/model-settings.ts';

export const traeChannel = defineChannel({
  id: 'trae',
  idPrefix: 'tr',
  label: 'Trae CN',

  // 客户端身份：三个串作用完全不同，别混。
  //   clientVersion  = 桌面端 product.json 的 version（换令牌时上游拿它做版本门禁）
  //   channelVersion = 同文件的 tronBuildVersion（授权 URL 的 plugin_version）
  //   appVersion     = 同文件的 appVersion（账号接口的 x-app-version，签到/额度用）
  // 取法（本机装了 Trae CN）：
  //   node -e "const p=require(process.env.LOCALAPPDATA+'/Programs/Trae CN/resources/app/product.json');console.log(p.version,p.tronBuildVersion,p.appVersion)"
  // Linux 包实测（2026-11-13，TRAE_CN-linux-x64）：1.107.1 / 2.3.102035 / 3.4.17。
  // Windows 客户端抓包发的是 3.4.18，说明桌面端还在往前更新——所以这里不能写死，
  // 每次升级客户端要回来同步。
  identity: {
    clientVersion: '1.107.1',
    channelVersion: '2.3.102035',
    appVersion: '3.4.17',
  },

  configure(ctx) {
    setTraeLogger(ctx.log);
    setTraeModelsLogger(ctx.log);
    setTraeUpstreamLogger(ctx.log);
    setTraeUsageLogger(ctx.log);
    configureTraeIdentity(traeChannel.identity);
  },

  async modelsOf(account) {
    // **没有凭据就不给列表。** 目录来自服务端配置（`models.ts` 的
    // batch_get_detail_param），那一步也要凭据。拿凭据当闸门：抛错时路由会把这个
    // 账号跳过——否则模型列表里会出现十几个调不了的模型。
    return traeModelList(account);
  },

  async catalogOf(account) {
    return traeCatalog(account);
  },

  async creditsOf(account) {
    const usage: any = await getTraeUsage(account);
    return {
      ...usage,
      totalRemain: usage.remaining,
      account: {
        uid: account.profile?.uid || account.credential?.userId,
        username: account.profile?.username || account.credential?.username,
        tokenExpiresAt: account.credential?.expiresAt ? new Date(account.credential.expiresAt).toISOString() : null,
        source: account.credential?.source,
      },
    };
  },

  /** 凭据还能不能用：读一次签到状态（最轻的账号接口）。 */
  async probe(account) {
    await getCheckinStatus(account);
    return {
      uid: account.credential?.userId,
      username: account.credential?.username,
    };
  },

  async checkinStatusOf(account) {
    return getCheckinStatus(account);
  },

  async checkinClaimOf(account) {
    return claimCheckin(account);
  },

  lastCheckinOf(account) {
    return readLastCheckin(account);
  },

  /**
   * 给这个账号换一套设备身份。
   *
   * 上游按**设备**记签到（`x-device-id`，`did_checked_in` 逐设备不同），而客户端一台
   * 机器只登一个号，所以多个 Trae 账号不该共用一个设备号。新登录的号自动带独立设备号，
   * 已经存在的账号凭据里还是老号，需要这个动作换掉。
   *
   * 只换自造号（`selfDeviceId`）。`checkinDeviceId`（aha 真号）不动——那是客户端在
   * 本机真实注册的号，换掉等于放弃唯一「上游可能认可」的值。
   *
   * 换号**不是** 9074 的解药：9074 是上游活动瞬时爆满，与设备号无关（见 `usage.ts`）。
   */
  rotateDeviceIdOf() {
    return { selfDeviceId: mintSelfDeviceId() };
  },

  // 交互式登录：由网关起后台任务、前端轮询状态，不在请求里同步等。
  async login(options) {
    return runTraeLogin({ onUrl: options?.onUrl, signal: options?.signal });
  },

  // Trae 的授权页只肯把浏览器跳回**环回**地址（内网 IP 不跳，2026-11-09 实测两次），
  // 所以回调必须由「浏览器那台机器」上的 127.0.0.1:<port> 转发进来。网关自己不做
  // 这件事——它在容器里，够不到用户的笔记本——只把端口通过 SSE 事件告诉插件。
  loginLoopback() {
    return traeLoginLoopback();
  },

  // Trae 没有上游注销接口：删账号就够了，令牌到期自然失效。
  // （不实现 `logoutOf`，管理台会隐藏「退出上游」按钮。）

  async chatAs(account, request) {
    return chatTrae(account, request);
  },
});
