import { parseSource } from '../lib/daygym.mjs';
import { csvRows, importHeader } from '../lib/import.mjs';
import { id, fail, text, day, integer, digest, version, page, cursor } from '../lib/utils.mjs';
import {
  admin,
  now,
  required,
  addMember,
  addContract,
  monthRows,
  confirmation,
} from './domain.mjs';
export { importHeader };
const norm = (s) =>
  String(s || '')
    .normalize('NFC')
    .replace(/\s+/g, '');
async function external(s, kind, ref, table) {
  const unique = await s.get('unique_keys', digest(kind + ':' + ref));
  return unique ? await s.get(table, unique.target) : null;
}
export async function memberPreview(s, a, b) {
  admin(a);
  const rows = [],
    errors = [],
    seen = new Set(),
    lines = csvRows(b.text),
    heads = importHeader.split('\t');
  if (!lines.length || heads.some((h, i) => lines[0][i]?.trim() !== h))
    fail(400, '제공된 열 제목을 그대로 사용하세요.');
  if (lines.length > 41) fail(400, 'Firebase 일괄 이관은 한 번에 40건 이하로 나눠주세요.');
  const people = await s.query('people');
  for (let i = 1; i < lines.length; i++)
    try {
      const r = lines[i].map((v) => v.trim());
      if (r.length !== 10) fail(400, '열 개수가 다릅니다.');
      const ref = text(r[0], '회원번호'),
        name = text(r[1], '회원명'),
        code = text(r[3], '등록번호');
      if (seen.has(code)) fail(400, '등록번호 중복입니다.');
      seen.add(code);
      const start = day(r[4]),
        paid = day(r[5]),
        carryDate = day(r[9]),
        p = people.filter(
          (p) =>
            p.name === r[2] &&
            p.hire_month <= carryDate.slice(0, 7) &&
            (!p.end_date || p.end_date >= carryDate),
        );
      if (p.length !== 1 || !r[6] || carryDate < start)
        fail(400, '담당·공급가액·기준일을 확인하세요.');
      const amount = integer(Number(r[6]), '공급가액'),
        quantity = integer(Number(r[7]), '횟수', 1, 10000),
        carryUsed = integer(Number(r[8]), '기진행', 0, quantity);
      const m = await external(s, 'member', ref, 'members'),
        c = await external(s, 'contract', code, 'contracts');
      if (m && (m.person_id !== p[0].id || m.name !== name))
        fail(400, '같은 회원번호의 이름·담당이 다릅니다.');
      if (
        c &&
        (!m ||
          c.member_id !== m.id ||
          c.amount !== amount ||
          c.quantity !== quantity ||
          c.carry_used !== carryUsed ||
          c.paid_date !== paid ||
          c.start_date !== start ||
          c.carry_date !== carryDate)
      )
        fail(400, '기존 등록번호의 내용이 다릅니다.');
      rows.push({
        ref,
        name,
        personId: p[0].id,
        personName: p[0].name,
        code,
        startDate: start,
        paidDate: paid,
        amount,
        quantity,
        carryUsed,
        carryDate,
        duplicate: !!c,
      });
    } catch (e) {
      errors.push(i + 1 + '행: ' + e.message);
    }
  // Validate same member reference repeated within this batch too.
  const refs = new Map();
  for (const r of rows) {
    const old = refs.get(r.ref);
    if (old && (old.name !== r.name || old.personId !== r.personId))
      errors.push('같은 회원번호의 이름·담당이 다릅니다.');
    refs.set(r.ref, r);
  }
  return { rows, errors };
}
export async function importMembers(s, a, b) {
  const p = await memberPreview(s, a, b);
  if (p.errors.length) fail(400, p.errors.join(' '));
  let members = 0,
    contracts = 0,
    duplicates = 0;
  for (const r of p.rows) {
    if (r.duplicate) {
      duplicates++;
      continue;
    }
    let m = await external(s, 'member', r.ref, 'members');
    if (!m) {
      m = await addMember(s, a, { name: r.name, personId: r.personId, externalRef: r.ref });
      members++;
    }
    await addContract(s, a, {
      ...r,
      memberId: m.id,
      category: 'pt',
      saleType: 'new',
      externalRef: r.code,
    });
    contracts++;
  }
  await s.audit(a, 'import', 'members', id(), '', { members, contracts, duplicates });
  return { members, contracts, duplicates };
}
export async function sourcePreview(s, a, b) {
  admin(a);
  const p = parseSource(b.text);
  if (p.rows.length > 200) fail(400, 'Firebase 다짐 가져오기는 한 번에 200건 이하로 나눠주세요.');
  const rows = [];
  for (const r of p.rows) {
    const old = await s.get('source_records', r.slot);
    rows.push({
      ...r,
      kind: !old
        ? 'new'
        : old.state === r.state && old.ticket === r.ticket
          ? 'duplicate'
          : 'changed',
      existingVersion: old?.version || 0,
    });
  }
  return { ...p, rows };
}
export async function importSource(s, a, b) {
  const preview = await sourcePreview(s, a, b);
  if (preview.errors.length) fail(400, preview.errors.join(' '));
  const updates = new Set(Array.isArray(b.updates) ? b.updates : []),
    people = await s.query('people'),
    memberCache = new Map(),
    batch = id();
  let count = 0;
  for (const r of preview.rows) {
    if (r.kind === 'duplicate' || (r.kind === 'changed' && !updates.has(r.slot))) continue;
    const choices = people.filter(
      (p) =>
        norm(p.name) === norm(r.instructor) &&
        p.hire_month <= r.date.slice(0, 7) &&
        (!p.end_date || p.end_date >= r.date),
    );
    const pid = b.personId || (choices.length === 1 ? choices[0].id : null);
    if (pid) await required(s, 'people', pid);
    if (pid && !memberCache.has(pid)) {
      const current = await s.query('members', [['person_id', '==', pid]]),
        assign = await s.query('member_assignments', [['person_id', '==', pid]]);
      const map = new Map(current.map((m) => [m.id, m]));
      for (const x of assign)
        if (!map.has(x.member_id)) map.set(x.member_id, await required(s, 'members', x.member_id));
      memberCache.set(pid, [...map.values()]);
    }
    const matches = pid ? memberCache.get(pid).filter((m) => norm(m.name) === norm(r.member)) : [],
      old = await s.get('source_records', r.slot);
    const row = old
      ? { ...old, state: r.state, ticket: r.ticket, batch_id: batch, version: old.version + 1 }
      : {
          id: r.slot,
          batch_id: batch,
          slot: r.slot,
          person_id: pid,
          member_id: matches.length === 1 ? matches[0].id : null,
          contract_id: null,
          date: r.date,
          month: r.date.slice(0, 7),
          time: r.time,
          end_time: r.endTime,
          instructor: r.instructor,
          member_name: r.member,
          state: r.state,
          ticket: r.ticket,
          version: 1,
        };
    await s.put('source_records', row.id, row);
    count++;
  }
  await s.put(
    'source_batches',
    batch,
    {
      id: batch,
      month: preview.rows[0]?.date.slice(0, 7) || '0000-00',
      created_at: now(),
      actor_id: a.id,
      count,
    },
    { create: true },
  );
  await s.audit(a, 'import', 'source-batch', batch, '', { count });
  return { count, duplicates: preview.rows.filter((r) => r.kind === 'duplicate').length };
}
export async function reconcile(s, m, pid = null) {
  const records = await monthRows(s, 'source_records', m, pid),
    lessons = (await monthRows(s, 'lessons', m, pid)).filter((l) => l.status === 'active'),
    used = new Set(),
    out = [],
    index = new Map(),
    counts = new Map(),
    group = (r) => JSON.stringify([r.person_id, r.member_id, r.date, r.time]);
  for (const r of records) {
    const k = group(r);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(r);
  }
  for (const l of lessons) counts.set(group(l), (counts.get(group(l)) || 0) + 1);
  for (const l of lessons) {
    const found = (index.get(group(l)) || []).filter(
      (r) => !r.contract_id || r.contract_id === l.contract_id,
    );
    found.forEach((r) => used.add(r.id));
    const kind = !found.length
      ? 'payroll-only'
      : found.length > 1 || (counts.get(group(l)) > 1 && found.some((r) => !r.contract_id))
        ? 'ambiguous'
        : found[0].state === 'attended'
          ? 'matched'
          : 'payroll-' + found[0].state;
    out.push({
      key: 'lesson:' + l.id,
      lessonId: l.id,
      date: l.date,
      time: l.time,
      member: (await required(s, 'members', l.member_id)).name,
      personId: l.person_id,
      kind,
      sourceIds: found.map((r) => r.id),
      lessonVersion: l.version,
      confirmation: (await confirmation(s, l)).state,
      sourceVersions: found.map((r) => [r.id, r.version]),
    });
  }
  for (const r of records)
    if (!used.has(r.id))
      out.push({
        key: 'source:' + r.id,
        date: r.date,
        time: r.time,
        member: r.member_name,
        personId: r.person_id,
        kind: !r.person_id || !r.member_id ? 'unlinked' : 'source-' + r.state,
        sourceIds: [r.id],
        sourceVersions: [[r.id, r.version]],
      });
  const result = [];
  for (const r of out) {
    const fingerprint = digest(JSON.stringify(r)),
      review = await s.get('review_decisions', digest(m + ':' + r.key));
    result.push({
      ...r,
      fingerprint,
      reviewed: review?.fingerprint === fingerprint,
      reviewNote: review?.fingerprint === fingerprint ? review.note : '',
    });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}
export async function review(s, a, b) {
  admin(a);
  const row = (await reconcile(s, b.month)).find((r) => r.key === b.key);
  if (!row || row.fingerprint !== b.fingerprint) fail(409, '대조 내용이 바뀌었습니다.');
  const key = digest(b.month + ':' + row.key),
    note = text(b.note, '검수 사유', 500);
  await s.put('review_decisions', key, {
    id: key,
    month: b.month,
    item_key: row.key,
    note,
    actor_id: a.id,
    fingerprint: row.fingerprint,
    created_at: now(),
  });
  await s.audit(a, 'review', 'reconciliation', row.key, note, { month: b.month });
  return { ok: true };
}
export async function linkSource(s, a, key, b) {
  admin(a);
  const old = await required(s, 'source_records', key);
  version(old, b.version);
  const p = b.personId ? await required(s, 'people', b.personId) : null,
    m = b.memberId ? await required(s, 'members', b.memberId) : null,
    c = b.contractId ? await required(s, 'contracts', b.contractId) : null;
  const historic =
    m &&
    p &&
    (
      await s.query('member_assignments', [
        ['member_id', '==', m.id],
        ['person_id', '==', p.id],
        ['effective_date', '<=', old.date],
      ])
    ).length;
  if (
    (m && m.person_id !== p?.id && !historic) ||
    (c && (c.member_id !== m?.id || c.person_id !== p?.id))
  )
    fail(400, '강사·회원·계약 연결이 다릅니다.');
  await s.put('source_records', key, {
    ...old,
    person_id: p?.id || null,
    member_id: m?.id || null,
    contract_id: c?.id || null,
    version: old.version + 1,
  });
  await s.audit(a, 'source-link', 'source', key, text(b.reason, '연결 사유', 200));
  return { ok: true };
}
export async function sourceSummary(s, m, url) {
  const rows = await monthRows(s, 'source_records', m),
    groups = new Map();
  for (const r of rows.sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  )) {
    const key = JSON.stringify([r.person_id, r.member_id, r.instructor, r.member_name]);
    if (!groups.has(key))
      groups.set(key, {
        id: digest(key),
        name: r.member_name,
        instructor: r.instructor,
        personId: r.person_id,
        memberId: r.member_id,
        attended: 0,
        absent: 0,
        reserved: 0,
        cancelled: 0,
        dates: [],
      });
    const g = groups.get(key);
    g[r.state]++;
    if (r.state === 'attended') g.dates.push(r.date.slice(5) + ' ' + r.time);
  }
  const { after, limit } = page(url);
  let out = [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id),
  );
  if (after) {
    const at = out.findIndex((r) => r.name === after[0] && r.id === after[1]);
    if (at < 0) fail(409, '집계가 바뀌었습니다.');
    out = out.slice(at + 1);
  }
  const items = out.slice(0, limit);
  return { items, next: out.length > limit ? cursor(items.at(-1).name, items.at(-1).id) : null };
}
