import { groupInstructor } from '../lib/profiles.mjs';
import {
  id,
  day,
  month,
  today,
  text,
  integer,
  version,
  fail,
  digest,
  page,
  cursor,
  only,
} from '../lib/utils.mjs';
import {
  required,
  person,
  owned,
  guard,
  monthRows,
  addLesson,
  changeLesson,
  now,
  trainer,
  admin,
} from './domain.mjs';
export async function createGroupRate(s, a, pid, b) {
  admin(a);
  const p = await person(s, a, pid);
  if (!groupInstructor(p)) fail(400, '그룹레슨을 진행할 선생님을 선택하세요.');
  const effective = day(b.effectiveDate),
    name = text(b.name, '수업명', 80);
  const r = {
    id: id(),
    person_id: pid,
    name,
    class_key: digest(name.normalize('NFC')),
    effective_date: effective,
    hourly_rate: integer(b.hourlyRate, '시간당 수업료', 1, 1000000),
    billable_minutes: integer(b.billableMinutes, '1회 정산 인정시간', 1, 480),
    created_at: now(),
    version: 1,
  };
  await s.put('group_rates', r.id, r, { create: true });
  await s.audit(a, 'group-rate', 'person', pid, text(b.reason, '설정 사유', 300), {
    rateId: r.id,
    hourlyRate: r.hourly_rate,
    billableMinutes: r.billable_minutes,
    effectiveDate: effective,
  });
  return r;
}
export async function groupRates(s, a, pid = null) {
  if (a.role !== 'admin') pid = a.person_id;
  if (pid) await person(s, a, pid);
  return s.query('group_rates', pid ? [['person_id', '==', pid]] : []);
}
async function groupGuard(s, a, pid, date) {
  const p = await person(s, a, pid, date.slice(0, 7));
  if (
    !groupInstructor(p) ||
    date > today() ||
    date.slice(0, 7) < p.hire_month ||
    (p.end_date && date > p.end_date)
  )
    fail(400, '담당자·근무 기간·수업일을 확인하세요.');
  await guard(s, date.slice(0, 7), pid);
  return p;
}
const groupSlot = (r) => JSON.stringify([r.person_id, r.date, r.time]);
export async function addGroupLesson(s, a, b) {
  only(b, ['rateId', 'date', 'time', 'participants']);
  const rate = await owned(s, a, 'group_rates', b.rateId),
    date = day(b.date),
    time = text(b.time, '시작 시간', 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || date < rate.effective_date)
    fail(400, '단가 적용일 이후의 수업 날짜·시간을 입력하세요.');
  await groupGuard(s, a, rate.person_id, date);
  const latest = (await groupRates(s, a, rate.person_id))
    .filter((r) => r.class_key === rate.class_key && r.effective_date <= date)
    .sort(
      (a, b) =>
        b.effective_date.localeCompare(a.effective_date) ||
        b.created_at.localeCompare(a.created_at) ||
        b.id.localeCompare(a.id),
    )[0];
  if (latest.id !== rate.id)
    fail(409, '적용 단가가 변경되었습니다. 해당 날짜의 최신 단가를 선택하세요.');
  const r = {
    id: id(),
    person_id: rate.person_id,
    date,
    month: date.slice(0, 7),
    time,
    name: rate.name,
    rate_id: rate.id,
    rate_version: rate.version,
    hourly_rate: rate.hourly_rate,
    billable_minutes: rate.billable_minutes,
    participants: integer(b.participants ?? 0, '참여인원', 0, 500),
    amount: Math.round((rate.hourly_rate * rate.billable_minutes) / 60),
    status: 'active',
    version: 1,
    reason: '',
    created_at: now(),
  };
  await s.unique('group-slot', groupSlot(r), r.id);
  await s.put('group_lessons', r.id, r, { create: true });
  await s.audit(a, 'group-record', 'group-lesson', r.id, '', { rateId: rate.id, amount: r.amount });
  return r;
}
export async function changeGroupLesson(s, a, key, b) {
  const old = await owned(s, a, 'group_lessons', key);
  version(old, b.version);
  if (old.status !== 'active') fail(409, '취소된 기록입니다.');
  const date = day(b.date || old.date),
    time = b.time || old.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(400, '시간을 확인하세요.');
  await groupGuard(s, a, old.person_id, date);
  await guard(s, old.month, old.person_id);
  const reason = text(b.reason, '정정 사유', 300);
  if (b.hourlyRate !== undefined || b.billableMinutes !== undefined) admin(a);
  const rate =
      b.hourlyRate === undefined
        ? old.hourly_rate
        : integer(b.hourlyRate, '시간당 단가', 1, 1000000),
    mins =
      b.billableMinutes === undefined
        ? old.billable_minutes
        : integer(b.billableMinutes, '인정 시간', 1, 480);
  const r = {
    ...old,
    date,
    month: date.slice(0, 7),
    time,
    hourly_rate: rate,
    billable_minutes: mins,
    amount: Math.round((rate * mins) / 60),
    participants: integer(b.participants ?? old.participants, '참여인원', 0, 500),
    status: b.void ? 'void' : 'active',
    version: old.version + 1,
    reason,
  };
  await s.release('group-slot', groupSlot(old), old.id);
  if (!b.void) await s.unique('group-slot', groupSlot(r), r.id);
  await s.put('group_lessons', key, r);
  await s.audit(a, b.void ? 'group-void' : 'group-correct', 'group-lesson', key, reason, {
    before: old,
    after: r,
  });
  return r;
}
export async function listGroups(s, a, url) {
  const m = month(url.searchParams.get('month')),
    pid = a.role === 'admin' ? url.searchParams.get('personId') : a.person_id,
    { after, limit } = page(url);
  let rows = (await monthRows(s, 'group_lessons', m, pid)).sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  if (after)
    rows = rows.filter((r) => r.date > after[0] || (r.date === after[0] && r.id > after[1]));
  const items = [];
  for (const r of rows.slice(0, limit))
    items.push({ ...r, instructor: (await required(s, 'people', r.person_id)).name });
  return { items, next: rows.length > limit ? cursor(items.at(-1).date, items.at(-1).id) : null };
}
export async function addDuet(s, a, b) {
  only(b, ['contractIds', 'date', 'time']);
  if (
    !Array.isArray(b.contractIds) ||
    b.contractIds.length !== 2 ||
    new Set(b.contractIds).size !== 2
  )
    fail(400, '서로 다른 두 회원의 회원권을 선택하세요.');
  const [first, second] = await Promise.all(
    b.contractIds.map((key) => owned(s, a, 'contracts', key)),
  );
  if (
    first.member_id === second.member_id ||
    first.person_id !== second.person_id ||
    first.category !== second.category
  )
    fail(400, '같은 선생님·같은 종목의 서로 다른 두 회원을 선택하세요.');
  const date = day(b.date),
    key = id(),
    time = text(b.time, '시작 시간', 5);
  const slot = JSON.stringify([first.person_id, date, time, ...[first.id, second.id].sort()]);
  await s.unique('duet-slot', slot, key);
  const lessons = [];
  for (const c of [first, second])
    lessons.push(await addLesson(s, a, { contractId: c.id, date, time }, { duetSessionId: key }));
  const r = {
    id: key,
    person_id: first.person_id,
    date,
    month: date.slice(0, 7),
    time,
    category: first.category,
    contract_ids: [first.id, second.id],
    member_ids: [first.member_id, second.member_id],
    lesson_ids: lessons.map((l) => l.id),
    status: 'active',
    version: 1,
    created_at: now(),
    reason: '',
  };
  await s.put('duet_sessions', key, r, { create: true });
  await s.audit(a, 'duet-create', 'duet', key, '', { lessonIds: r.lesson_ids });
  return { ...r, lessons };
}
export async function changeDuet(s, a, key, b) {
  const old = await owned(s, a, 'duet_sessions', key);
  version(old, b.version);
  if (old.status !== 'active') fail(409, '취소된 듀엣 수업입니다.');
  const reason = text(b.reason, '정정 사유', 300),
    date = day(b.date || old.date),
    time = b.time || old.time;
  const next = {
    ...old,
    date,
    month: date.slice(0, 7),
    time,
    status: b.void ? 'void' : 'active',
    version: old.version + 1,
    reason,
  };
  const slot = (r) => JSON.stringify([r.person_id, r.date, r.time, ...[...r.contract_ids].sort()]);
  await s.release('duet-slot', slot(old), key);
  if (!b.void) await s.unique('duet-slot', slot(next), key);
  for (const lid of old.lesson_ids) {
    const l = await required(s, 'lessons', lid);
    await changeLesson(
      s,
      a,
      l.id,
      { date, time, void: !!b.void, version: l.version, reason },
      { duetSessionId: key },
    );
  }
  await s.put('duet_sessions', key, next);
  await s.audit(a, b.void ? 'duet-void' : 'duet-correct', 'duet', key, reason, {
    before: old,
    after: next,
  });
  return next;
}
export async function duetDetail(s, a, key) {
  const row = await owned(s, a, 'duet_sessions', key),
    lessons = [];
  for (const lid of row.lesson_ids) {
    const l = await required(s, 'lessons', lid);
    lessons.push({ ...l, member: (await required(s, 'members', l.member_id)).name });
  }
  return { ...row, lessons };
}
