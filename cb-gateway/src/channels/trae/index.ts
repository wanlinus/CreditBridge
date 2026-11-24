// Trae 通道：一个上游（trae-api-cn）的协议适配器。它**不知道「有几个账号」**——凭据由账号对象
// 传进来，选哪个号是模型 id 的事（`tr-1/glm-5.3-flash`）。
// 坑：上游按**设备**记签到（`did_checked_in` 逐设备不同），同机多号不能共用一个 `x-device-id`。

import { defineChannel } from '../types.ts';
import { configureTraeIdentity, fetchTraeIdentity, mintSelfDeviceId, setTraeLogger } from './auth.ts';
import { traeCatalog, traeModelList, setTraeModelsLogger } from './models.ts';
import { chatTrae, setTraeUpstreamLogger } from './upstream.ts';
import { loginLoopback as traeLoginLoopback, runTraeLogin } from './login.ts';
import {
  claimCheckin,
  getCheckinStatus,
  getTraeCredits,
  readLastCheckin,
  setTraeUsageLogger,
} from './usage.ts';

export { contextOptions } from '../../shared/model-settings.ts';

export const traeChannel = defineChannel({
  id: 'trae',
  idPrefix: 'tr',
  label: 'Trae CN',

  // 客户端身份：三个串作用完全不同，别混。`clientVersion` = product.json 的 `version`（换令牌的
  // 版本门禁）；`channelVersion` = `tronBuildVersion`（授权 URL 的 `plugin_version`）；
  // `appVersion` = `appVersion`（账号接口的 `x-app-version`）。桌面端还在往前更新，不能写死，升级后回来同步。
  identity: {
    clientVersion: '1.107.1',
    channelVersion: '2.3.106768',
    appVersion: '3.4.24',
  },

  async fetchIdentity() {
    return fetchTraeIdentity();
  },

  configure(ctx) {
    setTraeLogger(ctx.log);
    setTraeModelsLogger(ctx.log);
    setTraeUpstreamLogger(ctx.log);
    setTraeUsageLogger(ctx.log);
    configureTraeIdentity(traeChannel.identity);
  },

  async modelsOf(account) {
    // **没有凭据就不给列表**：目录来自服务端配置、也要凭据。抛错时路由会把这个账号跳过——
    // 否则模型列表里会出现十几个调不了的模型。
    return traeModelList(account);
  },

  async catalogOf(account) {
    return traeCatalog(account);
  },

  async creditsOf(account) {
    const usage: any = await getTraeCredits(account);
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

  /** 给这个账号换一套设备身份。上游按**设备**记签到，而客户端一台机器只登一个号，所以多个 Trae 账号不该共用一个设备号；只换自造号（`selfDeviceId`），`checkinDeviceId`（aha 真号）不动。
   * 换号**不是** 9074 的解药：9074 是上游活动瞬时爆满（见 `usage.ts`）。 */
  rotateDeviceIdOf() {
    return { selfDeviceId: mintSelfDeviceId() };
  },

  // 交互式登录：由网关起后台任务、前端轮询状态，不在请求里同步等。
  async login(options) {
    return runTraeLogin({ onUrl: options?.onUrl, signal: options?.signal });
  },

  // Trae 的授权页只肯把浏览器跳回**环回**地址（内网 IP 不跳，实测两次），所以回调必须由「浏览器
  // 那台机器」上的 127.0.0.1:<port> 转发进来；网关在容器里够不到用户的笔记本，只把端口经 SSE 告诉插件。
  loginLoopback() {
    return traeLoginLoopback();
  },

  async chatAs(account, request) {
    return chatTrae(account, request);
  },
});
