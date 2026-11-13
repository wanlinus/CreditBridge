import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(target: string, text: string, options: { mode?: number } = {}): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const temp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, 'w', options.mode ?? 0o644);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (options.mode !== undefined) {
      try {
        fs.chmodSync(temp, options.mode);
      } catch {
      }
    }
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
    }
    throw error;
  }
}
