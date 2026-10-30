import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldPath } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { id, digest, fail } from '../lib/utils.mjs';

export function services(
  projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
) {
  if (!projectId) throw Error('FIREBASE_PROJECT_ID is required.');
  if (
    process.env.K_SERVICE &&
    !process.env.FUNCTIONS_EMULATOR &&
    (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)
  )
    throw Error('Emulator endpoints are forbidden in deployed Functions.');
  const app =
    getApps().find((a) => a.options.projectId === projectId) ||
    initializeApp({ projectId }, projectId);
  return { db: getFirestore(app), auth: getAuth(app), projectId };
}
export class Store {
  constructor(db, tx) {
    this.db = db;
    this.tx = tx;
    this.pending = new Map();
    this.cache = new Map();
    this.queryCache = new Map();
  }
  ref(table, key) {
    if (typeof key !== 'string' || !key || key.includes('/') || key.length > 200)
      fail(400, '자료 번호를 확인하세요.');
    return this.db.collection(table).doc(key);
  }
  async get(table, key) {
    const tag = table + '/' + key;
    if (this.pending.has(tag)) return this.pending.get(tag).data;
    if (!this.cache.has(tag)) {
      const ref = this.ref(table, key);
      const snap = this.tx ? await this.tx.get(ref) : await ref.get();
      this.cache.set(tag, snap.exists ? decode(table, snap.data()) : null);
    }
    return this.cache.get(tag);
  }
  // All writes are buffered until every read/validation completes. Transaction retries have no Auth side effects.
  async query(table, filters = [], { order = [], limit = 12000, after, allowMore = false } = {}) {
    if (limit > 12000) throw Error('Query limit exceeded.');
    let q = this.db.collection(table);
    for (const [field, op, val] of filters)
      q = q.where(field === '__name__' ? FieldPath.documentId() : field, op, val);
    for (const [field, direction = 'asc'] of order)
      q = q.orderBy(field === '__name__' ? FieldPath.documentId() : field, direction);
    if (after) q = q.startAfter(...after);
    q = q.limit(limit + 1);
    const cacheKey = JSON.stringify([table, filters, order, limit, after]);
    if (!this.queryCache.has(cacheKey))
      this.queryCache.set(cacheKey, this.tx ? await this.tx.get(q) : await q.get());
    const snap = this.queryCache.get(cacheKey);
    if (!allowMore && snap.size > limit) fail(413, '한 번에 처리할 범위를 줄여주세요.');
    const rows = new Map(
      snap.docs.map((d) => {
        const value = decode(table, d.data());
        this.cache.set(table + '/' + d.id, value);
        return [d.id, value];
      }),
    );
    for (const [tag, w] of this.pending) {
      if (!tag.startsWith(table + '/')) continue;
      const key = tag.slice(table.length + 1);
      const matches =
        w.data &&
        filters.every(([f, op, v]) => {
          const x = f === '__name__' ? key : w.data[f];
          return op === '=='
            ? x === v
            : op === '>='
              ? x >= v
              : op === '<='
                ? x <= v
                : op === '>'
                  ? x > v
                  : op === '<'
                    ? x < v
                    : op === '!='
                      ? x !== v
                      : op === 'in'
                        ? v.includes(x)
                        : false;
        });
      if (matches) rows.set(key, w.data);
      else rows.delete(key);
    }
    let out = [...rows.values()];
    if (order.length)
      out.sort((a, b) => {
        for (const [f, d = 'asc'] of order) {
          const x = f === '__name__' ? a.id : a[f],
            y = f === '__name__' ? b.id : b[f];
          if (x !== y) return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1);
        }
        return 0;
      });
    return out;
  }
  async put(table, key, data, { create = false } = {}) {
    if (!this.tx) throw Error('Write outside transaction.');
    const tag = table + '/' + key;
    if (['signatures', 'signature_payloads', 'payroll_versions', 'audit'].includes(table))
      create = true;
    if (create && (await this.get(table, key))) fail(409, '이미 저장된 자료입니다.');
    if (Buffer.byteLength(JSON.stringify(data)) > 800000) fail(413, '단일 기록이 너무 큽니다.');
    this.pending.set(tag, { ref: this.ref(table, key), data, create });
  }
  async del(table, key) {
    if (['signatures', 'signature_payloads', 'payroll_versions', 'audit'].includes(table))
      fail(409, '원본 기록은 삭제할 수 없습니다.');
    await this.get(table, key);
    this.pending.set(table + '/' + key, { ref: this.ref(table, key), data: null });
  }
  async unique(namespace, value, target) {
    const key = digest(namespace + ':' + value),
      old = await this.get('unique_keys', key);
    if (old && old.target !== target)
      fail(409, '중복된 아이디·등록번호 또는 수업 날짜/시간입니다.');
    await this.put('unique_keys', key, { id: key, target });
  }
  async release(namespace, value, target) {
    const key = digest(namespace + ':' + value),
      row = await this.get('unique_keys', key);
    if (row?.target === target) await this.del('unique_keys', key);
  }
  async audit(a, action, entity, entity_id, reason = '', details = {}) {
    const key = Date.now().toString().padStart(13, '0') + '-' + id();
    await this.put('audit', key, {
      id: key,
      actor_id: a?.id || null,
      actor: a?.display_name || '시스템',
      action,
      entity,
      entity_id,
      reason,
      details,
      created_at: new Date().toISOString(),
    });
  }
  flush() {
    if (this.pending.size > 450) fail(413, '한 번에 저장할 항목이 많습니다. 나눠서 입력하세요.');
    for (const { ref, data, create } of this.pending.values()) {
      if (!data) this.tx.delete(ref);
      else if (create) this.tx.create(ref, encode(ref.parent.id, data));
      else this.tx.set(ref, encode(ref.parent.id, data));
    }
  }
}
export async function atomic(db, fn) {
  return db.runTransaction(
    async (tx) => {
      const s = new Store(db, tx),
        control = (await s.get('control', 'state')) || { revision: 0 };
      const result = await fn(s);
      if (s.pending.size) {
        await s.put('control', 'state', { ...control, revision: control.revision + 1 });
        s.flush();
      }
      return result;
    },
    { maxAttempts: 5 },
  );
}

function encode(table, row) {
  return table === 'rules' ? { ...row, body: JSON.stringify(row.body) } : row;
}
function decode(table, row) {
  return table === 'rules' && typeof row.body === 'string'
    ? { ...row, body: JSON.parse(row.body) }
    : row;
}
