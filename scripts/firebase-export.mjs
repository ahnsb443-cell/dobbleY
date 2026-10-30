import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { services } from '../firebase/store.mjs';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) throw Error('Explicit FIREBASE_PROJECT_ID required; no default project.');
const { db } = services(projectId),
  dir = path.resolve(process.env.BACKUP_DIR || 'backups');
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = path.join(
    dir,
    'firestore-' + projectId + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl',
  ),
  handle = await open(file, 'wx', 0o600),
  hash = createHash('sha256');
let count = 0;
function pack(value) {
  if (value instanceof Timestamp)
    return { $firestoreTimestamp: [value.seconds, value.nanoseconds] };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(pack);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pack(v)]));
  return value;
}
async function line(value) {
  const data = JSON.stringify(value) + '\n';
  hash.update(data);
  await handle.write(data);
}
try {
  await line({
    format: 'double-y-firestore-v1',
    projectId,
    createdAt: new Date().toISOString(),
    note: 'Firestore only. Firebase Auth credentials require a separate managed export.',
  });
  for (const collection of await db.listCollections()) {
    if (['auth_sessions', 'attempts', 'idempotency'].includes(collection.id)) continue;
    let last = null;
    for (;;) {
      let q = collection.orderBy(FieldPath.documentId()).limit(200);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) break;
      for (const doc of page.docs) {
        if ((await doc.ref.listCollections()).length)
          throw Error('Nested collections need managed export; refusing incomplete backup.');
        await line({ collection: collection.id, id: doc.id, data: pack(doc.data()) });
        count++;
      }
      last = page.docs.at(-1);
    }
  }
} finally {
  await handle.close();
}
await writeFile(file + '.sha256', hash.digest('hex') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Firestore export complete:', file, 'documents:', count);
console.log(
  'Auth accounts/passwords are not included. This is a portable copy; managed scheduled backups remain required.',
);
