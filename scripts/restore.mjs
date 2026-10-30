import { access, mkdir, copyFile, readFile, chmod, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { digest } from '../lib/utils.mjs';
export async function restoreFile(source, targetDir) {
  const expected = (await readFile(source + '.sha256', 'utf8')).trim(),
    bytes = await readFile(source);
  if (digest(bytes) !== expected) throw Error('Backup checksum mismatch.');
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const target = path.join(targetDir, 'payroll.sqlite');
  try {
    await access(target);
    throw Error('Target DB exists; restore only to a new directory.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await copyFile(source, target);
  await chmod(target, 0o600);
  let db;
  try {
    db = new DatabaseSync(target);
    if (db.prepare('SELECT max(version) version FROM schema_versions').get().version !== 1)
      throw Error('Unsupported backup schema version.');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw Error('Integrity check failed.');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw Error('Foreign key check failed.');
    for (const r of db
      .prepare(
        'SELECT p.strokes,s.payload_hash FROM signature_payloads p JOIN signatures s ON s.id=p.signature_id',
      )
      .iterate())
      if (digest(r.strokes) !== r.payload_hash) throw Error('Signature payload checksum mismatch.');
    db.exec(
      'PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DELETE FROM auth_sessions; DELETE FROM attempts;',
    );
    db.prepare(
      "INSERT INTO audit(actor_id,action,entity,entity_id,reason,details,created_at) VALUES(NULL,'restore','database','local','검증된 백업 복원','{}',?)",
    ).run(new Date().toISOString());
    db.exec('COMMIT');
    return { file: target, revokedSessions: true };
  } catch (e) {
    db?.close();
    db = null;
    await rm(target, { force: true });
    throw e;
  } finally {
    db?.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3])
    throw Error('Usage: npm run restore -- BACKUP.sqlite NEW_DATA_DIR');
  const result = await restoreFile(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
  console.log(
    'Validated restore:',
    result.file,
    '; old sessions revoked. Point DATA_DIR here only after review.',
  );
}
