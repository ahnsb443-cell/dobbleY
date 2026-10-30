import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { services } from '../firebase/store.mjs';
import { Timestamp } from 'firebase-admin/firestore';
const file = process.argv[2],
  projectId = process.env.FIREBASE_PROJECT_ID;
if (!file || !projectId) throw Error('FIREBASE_PROJECT_ID and input JSONL path are required.');
if (!projectId.startsWith('demo-') && process.env.CONFIRM_FIREBASE_RESTORE !== projectId)
  throw Error('Set CONFIRM_FIREBASE_RESTORE to the exact isolated destination project ID.');
const bytes = await readFile(file),
  checksum = (await readFile(file + '.sha256', 'utf8')).trim();
if (createHash('sha256').update(bytes).digest('hex') !== checksum)
  throw Error('Backup SHA-256 mismatch.');
const [header, ...rows] = bytes.toString('utf8').trim().split('\n').map(JSON.parse);
if (header.format !== 'double-y-firestore-v1') throw Error('Unsupported export format.');
const { db } = services(projectId);
for (const c of await db.listCollections())
  if (!(await c.limit(1).get()).empty)
    throw Error('Destination Firestore must be completely empty.');
function unpack(v) {
  if (v && typeof v === 'object' && Array.isArray(v.$firestoreTimestamp))
    return new Timestamp(...v.$firestoreTimestamp);
  if (v && typeof v === 'object' && v.$date) return new Date(v.$date);
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
  return v;
}
for (const r of rows) {
  if (
    !/^[a-z_]+$/.test(r.collection) ||
    typeof r.id !== 'string' ||
    r.id.includes('/') ||
    ['auth_sessions', 'attempts', 'idempotency'].includes(r.collection)
  )
    throw Error('Invalid collection/document.');
}
// Fresh destination only. CREATE prevents a second process from overwriting an in-progress restore.
await db
  .collection('control')
  .doc('restore_in_progress')
  .create({ sourceProject: header.projectId, startedAt: new Date().toISOString() });
for (let i = 0; i < rows.length; i += 350) {
  const batch = db.batch();
  for (const r of rows.slice(i, i + 350))
    batch.create(db.collection(r.collection).doc(r.id), unpack(r.data));
  await batch.commit();
}
await db.collection('control').doc('restore_in_progress').delete();
console.log('Restored documents:', rows.length);
console.log(
  'Auth must be restored separately with identical UIDs. Review in isolation before changing the live app project.',
);
