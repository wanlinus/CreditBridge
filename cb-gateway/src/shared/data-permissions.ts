// `data/` 的目录权限收紧（**仅 Windows**）。
//
// ## 为什么需要这层
//
// Node 的 `fs.writeFileSync(path, data, { mode: 0o600 })` 只在 POSIX 上生效，
// **Windows 上落地是 0o666**（实测 `stat().mode === 0o100666`），真正决定谁能读的
// 是 ACL——而它默认从父目录继承，结果是同一台机器上任何已认证用户都能读到
// `data/gateway.db` 里的明文 token。
//
// ## 为什么收紧整个 `data/`（v4 之前只收紧 auth/ 和 accounts/）
//
// v4 把凭据、账号、key 全部搬进了 `data/gateway.db`，而 WAL 模式下同一个库还有
// `gateway.db-wal` / `gateway.db-shm` 两个附属文件——它们由 SQLite 创建，我们**没有
// 机会在创建那一刻给它们设权限**。只给 `gateway.db` 设 ACL 会留下两个仍然宽继承的
// 副本，等于白紧一半。
//
// 所以范围改成 `data/` 整个目录：`(OI)(CI)` 的继承标志让已有的和以后新建的文件都
// 跟着受限，包括 `-wal` / `-shm`。代价是同机其他账户读不到 `logs/`——这台机器上
// 网关就是单用户工具，这个代价可以接受；排错用管理员身份即可。
//
// ## 为什么对目录整体设而不是逐个文件
//
// `(OI)(CI)` 这两个继承标志会让已有的和以后新建的文件都跟着受限，写一次就够，
// 不用在每次写 token 之后重复调用——而漏调一次就是一个明文可读的文件。
//
// 失败只记日志、不挡启动：某些受限环境（组策略、只读盘）不允许改 ACL，那种情况下
// 网关照常工作，只是权限停留在继承来的宽设置上。

import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { DATA_DIR } from './paths.ts';

/** 含明文凭据的目录。加新目录前先问一句：里面有没有 token。 */
const SECRET_DIRS = [DATA_DIR];

export function restrictAuthDirPermissions(log: (...args: unknown[]) => void) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME;
  if (!user) {
    log('收紧 data 目录权限：拿不到当前用户名，跳过');
    return;
  }

  for (const dir of SECRET_DIRS) {
    try {
      // 还没登录过时目录不存在；先建出来，icacls 才有对象可设。
      fs.mkdirSync(dir, { recursive: true });
    } catch (error: any) {
      log(`收紧 ${dir} 权限：建目录失败（不影响运行）${error.message}`);
      continue;
    }

    execFile(
      'icacls',
      [
        dir,
        // 去掉从父目录继承来的那些 ACE（Users / Authenticated Users 就在这一层）。
        '/inheritance:r',
        // /grant:r 替换该账户已有的授权，避免累积出重复项。
        '/grant:r',
        `${user}:(OI)(CI)F`,
        '/grant',
        'SYSTEM:(OI)(CI)F',
      ],
      { windowsHide: true },
      (error) => {
        if (error) log(`收紧 ${dir} 权限失败（不影响运行）：${error.message}`);
        else log(`${dir} 权限已收紧到 ${user} + SYSTEM（同机其他账户不可读）`);
      },
    );
  }
}
