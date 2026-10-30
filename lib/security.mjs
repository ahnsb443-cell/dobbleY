import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { digest, fail, text, today } from './utils.mjs';
export const token = () => randomBytes(32).toString('hex');
export function password(p) {
  if (typeof p !== 'string' || p.length < 6 || p.length > 128)
    fail(400, '비밀번호는 6~128자로 입력하세요.');
  return p;
}
export function username(s) {
  s = text(s, '아이디', 40);
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(s)) fail(400, '아이디는 영문·숫자·._- 조합 3~40자입니다.');
  return s.toLowerCase();
}
export function encode(p) {
  password(p);
  const salt = token();
  return salt + ':' + scryptSync(p, salt, 64).toString('hex');
}
const dummy = encode(token());
export function verify(p, value = dummy) {
  try {
    if (typeof p !== 'string' || p.length > 128) return false;
    const [salt, hash] = value.split(':');
    return timingSafeEqual(scryptSync(p, salt, 64), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
export function accountView(a) {
  return {
    id: a.id,
    username: a.username,
    role: a.role,
    personId: a.person_id,
    name: a.display_name,
    active: !!a.active,
    mustChange: !!a.must_change,
    version: a.version,
    memberMode: !!a.member_lesson_id,
  };
}
export function throttle(store, key, limit = 10) {
  const now = Date.now(),
    row = store.one('SELECT * FROM attempts WHERE key=?', digest(key));
  if (row && row.reset > now && row.count >= limit)
    fail(429, '시도 횟수를 초과했습니다. 15분 뒤 다시 시도하세요.');
  store.run(
    'INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=?,reset=?',
    digest(key),
    1,
    now + 900000,
    row && row.reset > now ? row.count + 1 : 1,
    row && row.reset > now ? row.reset : now + 900000,
  );
}
export function authenticate(store, req) {
  const raw = req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('__session='))
    ?.slice(10);
  if (!raw) return null;
  return (
    store.one(
      'SELECT a.*,s.csrf,s.hash session_hash,s.member_lesson_id FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.expires>? AND s.password_version=a.version AND a.active=1 AND(a.person_id IS NULL OR EXISTS(SELECT 1 FROM people p WHERE p.id=a.person_id AND(p.end_date IS NULL OR p.end_date>=?)))',
      digest(raw),
      Date.now(),
      today(),
    ) || null
  );
}
export function issue(store, a) {
  const raw = token(),
    csrf = token();
  store.run(
    'INSERT INTO auth_sessions(hash,account_id,csrf,expires,password_version) VALUES(?,?,?,?,?)',
    digest(raw),
    a.id,
    csrf,
    Date.now() + 12 * 3600000,
    a.version,
  );
  return { raw, csrf };
}
export function admin(a) {
  if (a.role !== 'admin') fail(403, '관리자만 사용할 수 있습니다.');
}
export function owner(a, personId) {
  if (a.role !== 'admin' && a.person_id !== personId)
    fail(403, '본인 담당 자료만 사용할 수 있습니다.');
}
export function headers(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}
