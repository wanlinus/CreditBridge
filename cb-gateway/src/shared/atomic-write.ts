// 原子写盘：写临时文件 → fsync → rename 覆盖。
//
// `fs.writeFileSync` 是先截断再写，进程在这中间被杀就留下半截文件。而各个读取点对
// 坏文件的策略都是「当成没有」——账号凭空消失、所有 API key 一起失效、配置悄悄回默认，
// 全是「不报错但状态没了」。
//
// rename 在同一文件系统内是原子的；先 fsync 再 rename 是为了避免
// 「新文件名 + 空内容」（rename 只保证目录项替换原子，不保证内容已落盘）。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子地写一个文本文件。
 *
 * `mode` 只在新建时生效，和 `fs.writeFileSync` 语义一致。Windows 上 chmod 基本不
 * 起作用（真正的权限是 ACL，见 `data-permissions.ts`），失败忽略。
 */
export function writeFileAtomic(target: string, text: string, options: { mode?: number } = {}): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  // 临时文件必须放同一个目录：跨设备 rename 会抛 EXDEV，那时就不是原子的了。
  // pid + 随机后缀避免并发写同一目标时互相踩。
  const temp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, 'w', options.mode ?? 0o644);
    fs.writeFileSync(fd, text, 'utf8');
    // 内容先落盘，再换目录项——顺序反了会得到「新文件名 + 空内容」。
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (options.mode !== undefined) {
      try {
        fs.chmodSync(temp, options.mode);
      } catch {
        /* Windows 上 chmod 基本不起作用 */
      }
    }
    fs.renameSync(temp, target);
  } catch (error) {
    // 没换成就得清掉临时文件，否则目录里会攒一堆垃圾。
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* 已经关了 */
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 删不掉就算了 */
    }
    throw error;
  }
}
