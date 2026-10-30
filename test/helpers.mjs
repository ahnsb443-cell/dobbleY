import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../lib/db.mjs';
import { seed, addPerson, addMember, addContract, addLesson } from '../lib/domain.mjs';
import { encode } from '../lib/security.mjs';
import { createApp } from '../server.mjs';
export const randomPassword = () => randomBytes(18).toString('hex');
export async function fixture(profile = 'morning') {
  const dir = await mkdtemp(path.join(tmpdir(), 'dy-unit-')),
    s = await openDatabase(dir);
  seed(s);
  const a = { id: 'admin', role: 'admin' };
  s.run(
    "INSERT INTO accounts(id,username,password,role,display_name,must_change) VALUES('admin','owner',?,'admin','가상 관리자',0)",
    encode(randomPassword()),
  );
  const p = addPerson(s, a, { name: '가상 강사', profile, hireMonth: '2026-01' });
  const user = { id: 'employee', role: 'employee', person_id: p.id };
  s.run(
    "INSERT INTO accounts(id,username,password,role,person_id,display_name,must_change) VALUES('employee','teacher',?,'employee',?,'가상 강사',0)",
    encode(randomPassword()),
    p.id,
  );
  const m = addMember(s, a, { name: '가상 회원', personId: p.id });
  const c = addContract(s, a, {
    memberId: m.id,
    paidDate: '2026-10-01',
    startDate: '2026-10-01',
    amount: 5000000,
    quantity: 50,
    carryUsed: 0,
    category: 'pt',
    saleType: 'new',
  });
  return {
    s,
    dir,
    a,
    p,
    user,
    m,
    c,
    async close() {
      s.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export const strokes = [
  [
    [0.1, 0.2],
    [0.2, 0.4],
    [0.3, 0.2],
    [0.4, 0.5],
    [0.5, 0.3],
    [0.6, 0.6],
    [0.7, 0.3],
    [0.8, 0.5],
  ],
];
export async function httpFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dy-api-')),
    app = await createApp({ dataDir: dir }),
    server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function req(route, { method = 'GET', body, auth = {}, key, origin: external } = {}) {
    const r = await fetch(origin + '/api' + route, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth.cookie ? { Cookie: auth.cookie } : {}),
        ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {}),
        ...(method !== 'GET' ? { 'Idempotency-Key': key || randomBytes(16).toString('hex') } : {}),
        ...(external ? { Origin: external } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await r.json();
    return {
      status: r.status,
      body: value,
      auth: {
        cookie: r.headers.get('set-cookie')?.split(';')[0] || auth.cookie,
        csrf: value.csrf || auth.csrf,
      },
    };
  }
  return {
    ...app,
    origin,
    req,
    dir,
    async close() {
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
