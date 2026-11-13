import { execFile } from 'node:child_process';
import fs from 'node:fs';

import { ACCOUNTS_DIR, AUTH_DIR } from './paths.ts';

const SECRET_DIRS = [AUTH_DIR, ACCOUNTS_DIR];

export function restrictAuthDirPermissions(log: (...args: unknown[]) => void) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME;
  if (!user) {
    log('收紧 data 凭据目录权限：拿不到当前用户名，跳过');
    return;
  }

  for (const dir of SECRET_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error: any) {
      log(`收紧 ${dir} 权限：建目录失败（不影响运行）${error.message}`);
      continue;
    }

    execFile(
      'icacls',
      [
        dir,
        '/inheritance:r',
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
