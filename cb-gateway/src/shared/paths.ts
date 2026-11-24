// 文件系统锚点。`data/` 是唯一存放可变状态的地方：
//
//   data/
//   ├─ config.json   host / port / checkinTime（运维手改）
//   ├─ gateway.db    库：账本、账号、key、密码、签到、模型设置（WAL）
//   ├─ logs/         按天日志
//   └─ state/        只有三样：Trae / Qoder 的设备身份（必须跨登录稳定）、
//                    Qoder 的模型名单缓存（删了会自动重取）
//
// **不做数据迁移**：布局变了就是变了，不写「旧路径搬到新路径」的兼容代码。
// `data/` 里没有不可再生的东西（凭据点一次登录就回来），而迁移表会带来
// 「搬错了没人知道」的风险。要清场直接删文件或整个目录，各模块会自己 mkdirSync。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 数据目录。`QB_DATA_DIR` 只为一件事存在：让测试跑在临时目录里——否则跑一次测试
 * 就会把用户的真实状态改掉（比如把网关密码重置成 admin/admin）。
 */
export const DATA_DIR = process.env.QB_DATA_DIR
  ? path.resolve(process.env.QB_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
export const STATE_DIR = path.join(DATA_DIR, 'state');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
