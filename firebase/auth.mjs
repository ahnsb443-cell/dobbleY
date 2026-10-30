import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store, atomic } from './store.mjs';
import { fail, digest, today } from '../lib/utils.mjs';
import { password, username, accountView } from '../lib/security.mjs';
import { person } from './domain.mjs';
export { username, password, accountView };
export const token = () => randomBytes(32).toString('hex');
export const emailFor = (name) => digest(username(name)) + '@accounts.double-y.invalid';
export function authEndpoint(projectId) {
  const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator && !projectId.startsWith('demo-') && process.env.NODE_ENV === 'production')
    throw Error('Emulator forbidden in production.');
  return emulator
    ? 'http://' + emulator + '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'
    : 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
}
export async function signIn(projectId, name, pass) {
  if (typeof pass !== 'string' || pass.length > 128) fail(401, '아이디 또는 비밀번호가 다릅니다.');
  const key =
    process.env.WEB_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY ||
    (process.env.FIREBASE_AUTH_EMULATOR_HOST ? 'demo-key' : '');
  if (!key) throw Error('WEB_API_KEY is required.');
  const res = await fetch(authEndpoint(projectId) + '?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailFor(name), password: pass, returnSecureToken: true }),
    signal: AbortSignal.timeout(10000),
  });
  const value = await res.json();
  if (!res.ok)
    fail(
      res.status === 429 ? 429 : 401,
      res.status === 429 ? '잠시 후 다시 로그인하세요.' : '아이디 또는 비밀번호가 다릅니다.',
    );
  return value;
}
export async function throttle(db, key, limit = 10) {
  await atomic(db, async (s) => {
    const hash = digest(key),
      old = await s.get('attempts', hash),
      now = Date.now();
    if (old && old.reset > now && old.count >= limit)
      fail(429, '시도 횟수를 초과했습니다. 15분 뒤 다시 시도하세요.');
    await s.put('attempts', hash, {
      id: hash,
      count: old && old.reset > now ? old.count + 1 : 1,
      reset: old && old.reset > now ? old.reset : now + 900000,
      expiresAt: new Date(now + 900000),
    });
  });
}
export function sessionCookie(raw, secure, age = 43200) {
  return (
    '__session=' +
    raw +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
    age +
    (secure ? '; Secure' : '')
  );
}
export async function issueSession(svc, idToken, secure, res) {
  const claims = await svc.auth.verifyIdToken(idToken),
    s = new Store(svc.db),
    account = await s.get('accounts', claims.uid);
  await allowed(s, account);
  const raw =
      (await svc.auth.createSessionCookie(idToken, { expiresIn: 43200000 })) + '.' + token(),
    csrf = token(),
    key = digest(raw);
  await atomic(svc.db, async (store) => {
    const a = await store.get('accounts', claims.uid);
    await allowed(store, a);
    await store.put('auth_sessions', key, {
      id: key,
      account_id: a.id,
      csrf,
      expires: Date.now() + 43200000,
      expiresAt: new Date(Date.now() + 43200000),
      password_version: a.version,
      member_lesson_id: null,
    });
  });
  res.setHeader('Set-Cookie', sessionCookie(raw, secure));
  return { user: await userView(s, account), csrf };
}
async function allowed(s, a) {
  if (!a || !a.active) fail(401, '사용 가능한 계정이 아닙니다.');
  const p = a.person_id ? await s.get('people', a.person_id) : null;
  if (p?.end_date && p.end_date < today()) fail(401, '계약이 종료된 계정입니다.');
}
export async function authenticate(svc, req) {
  const raw = req.headers.cookie
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('__session='))
    ?.slice(10);
  if (!raw) fail(401, '로그인이 필요합니다.');
  let claims;
  try {
    const parts = raw.split('.');
    if (parts.length !== 4 || !/^[a-f0-9]{64}$/.test(parts[3]))
      fail(401, '로그인이 만료되었습니다.');
    claims = await svc.auth.verifySessionCookie(parts.slice(0, 3).join('.'), true);
  } catch {
    fail(401, '로그인이 만료되었습니다.');
  }
  const key = digest(raw),
    s = new Store(svc.db),
    session = await s.get('auth_sessions', key),
    a = await s.get('accounts', claims.uid);
  if (
    !session ||
    session.expires < Date.now() ||
    session.account_id !== claims.uid ||
    session.password_version !== a?.version
  )
    fail(401, '로그인이 만료되었습니다.');
  await allowed(s, a);
  return {
    ...a,
    session_hash: key,
    csrf: session.csrf,
    member_lesson_id: session.member_lesson_id,
  };
}
export async function userView(s, a) {
  return { ...accountView(a), person: a.person_id ? await person(s, a, a.person_id) : null };
}
export function checkSession(a, path, method) {
  if (a.must_change && !['/api/me', '/api/password', '/api/logout'].includes(path))
    fail(403, '임시 비밀번호를 먼저 변경하세요.');
  if (
    a.member_lesson_id &&
    (![
      '/api/me',
      '/api/logout',
      '/api/member-mode',
      '/api/member-mode/sign',
      '/api/member-mode/exit',
    ].includes(path) ||
      (path === '/api/member-mode' && method !== 'GET'))
  ) {
    const e = new Error('회원 확인 화면이 진행 중입니다.');
    e.status = 403;
    e.code = 'MEMBER_MODE';
    throw e;
  }
}
export async function freshActor(s, a) {
  const current = await s.get('accounts', a.id),
    session = await s.get('auth_sessions', a.session_hash);
  await allowed(s, current);
  if (!session || session.expires < Date.now() || session.password_version !== current.version)
    fail(401, '로그인이 만료되었습니다.');
  return {
    ...current,
    session_hash: a.session_hash,
    csrf: session.csrf,
    member_lesson_id: session.member_lesson_id,
  };
}
export async function provision(svc, b, save) {
  const name = username(b.username);
  password(b.password);
  const uid = digest('account:' + name);
  let created = false;
  try {
    await svc.auth.createUser({
      uid,
      email: emailFor(name),
      password: b.password,
      displayName: b.name || name,
    });
    created = true;
    return await save(uid, name);
  } catch (e) {
    if (created) {
      // Profile commit succeeded but later response/session failed: never delete a committed user.
      if (!(await new Store(svc.db).get('accounts', uid)))
        await svc.auth.deleteUser(uid).catch(() => {});
    }
    if (e.code === 'auth/email-already-exists' || e.code === 'auth/uid-already-exists')
      fail(409, '이미 사용 중인 아이디입니다.');
    throw e;
  }
}
