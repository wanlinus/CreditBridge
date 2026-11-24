// `data/` 的目录权限收紧（**仅 Windows**）。
// `fs.writeFileSync(..., { mode: 0o600 })` 只在 POSIX 生效，**Windows 上落地是 0o666**，真正决定谁能读的
// 是 ACL，而它默认从父目录继承——结果是同机任何已认证用户都能读到 `data/gateway.db` 里的明文 token。
//
// 所以收紧整个 `data/` 而不是逐个文件：`(OI)(CI)` 让已有的和以后新建的都跟着受限，包括 SQLite 自己
// 创建的 `-wal` / `-shm`（它们没机会在创建那一刻设权限）。失败只记日志不挡启动：组策略/只读盘下改不了 ACL。

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
