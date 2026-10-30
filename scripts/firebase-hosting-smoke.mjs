import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const origin = 'http://127.0.0.1:5000';
const direct = await fetch('http://127.0.0.1:5001/demo-double-y/asia-northeast3/api/api/status', {
  signal: AbortSignal.timeout(20000),
});
console.log('Functions direct HTTP status:', direct.status);
assert.equal(direct.status, 200, await direct.text());
const status = await fetch(origin + '/api/status').then((r) => r.json());
assert.equal(status.storage, 'firestore');
const password = randomBytes(18).toString('hex');
const created = await fetch(origin + '/api/setup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({
    name: '가상 배포검사',
    username: 'hosting.smoke',
    password,
    setupToken: 'local-smoke-test-only',
  }),
});
const data = await created.json();
assert.equal(created.status, 201, JSON.stringify(data));
const cookie = created.headers.get('set-cookie').split(';')[0];
const me = await fetch(origin + '/api/me', { headers: { Cookie: cookie } }).then((r) => r.json());
assert.equal(me.user.role, 'admin');
const html = await fetch(origin + '/').then((r) => r.text());
assert.ok(html.includes('app.js'));
console.log(
  'PASS: Firebase Hosting rewrite → actual Functions v2 export → Auth session → Firestore, same-origin setup/CSRF response.',
);
