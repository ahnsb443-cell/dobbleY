import { randomUUID, createHash } from 'node:crypto';
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new AppError(status, message);
};
export const id = () => randomUUID();
export const digest = (s) => createHash('sha256').update(s).digest('hex');
export const json = (s) => (s == null ? null : JSON.parse(s));
export const today = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export function day(s) {
  if (
    typeof s !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s + 'T00:00:00Z')) ||
    new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s
  )
    fail(400, '날짜를 확인하세요.');
  return s;
}
export function month(s) {
  if (typeof s !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s))
    fail(400, '정산 월을 확인하세요.');
  return s;
}
export function bounds(m) {
  month(m);
  const d = new Date(m + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return [m + '-01', d.toISOString().slice(0, 10)];
}
export function text(v, name, max = 80) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max)
    fail(400, name + '을 확인하세요.');
  return v.trim();
}
export function integer(v, name, min = 0, max = 10000000000) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    fail(400, name + '을 확인하세요.');
  return v;
}
export function number(v, name, min = 0, max = 10000) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    fail(400, name + '을 확인하세요.');
  return v;
}
export function version(row, v) {
  if (!row) fail(404, '자료를 찾을 수 없습니다.');
  if (row.version !== v) fail(409, '다른 사용자가 변경했습니다. 새로고침 후 다시 입력하세요.');
}
export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function page(url) {
  const raw = url.searchParams.get('after');
  let after = null;
  if (raw) {
    try {
      after = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (
        !Array.isArray(after) ||
        after.length !== 2 ||
        after.some((s) => typeof s !== 'string' || s.length > 100)
      )
        throw Error();
    } catch {
      fail(400, '페이지 커서를 확인하세요.');
    }
  }
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));
  if (!Number.isInteger(limit)) fail(400, '표시 건수를 확인하세요.');
  return { after, limit };
}
export const cursor = (sort, key) => Buffer.from(JSON.stringify([sort, key])).toString('base64url');
export function only(body, keys) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !keys.includes(k))
  )
    fail(400, '허용하지 않는 입력 항목입니다.');
}
