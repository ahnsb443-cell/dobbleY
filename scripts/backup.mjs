import { access, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { digest } from '../lib/utils.mjs';
export async function backupFile(source, target) {
  await access(source);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await access(target);
    throw Error('Target already exists; refusing overwrite.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  await chmod(target, 0o600);
  const checksum = digest(await readFile(target));
  await writeFile(target + '.sha256', checksum + '\n', { mode: 0o600 });
  return { file: target, checksum };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.resolve(process.env.DATA_DIR || '.data', 'payroll.sqlite'),
    target = path.resolve(
      process.argv[2] ||
        path.join(
          process.env.BACKUP_DIR || 'backups',
          'payroll-' + new Date().toISOString().replaceAll(':', '-') + '.sqlite',
        ),
    );
  const r = await backupFile(source, target);
  console.log('Consistent backup created:', r.file);
  console.log('Contains private payroll, accounts and signatures. Store securely.');
}
