import {
  id,
  fail,
  text,
  day,
  month,
  bounds,
  integer,
  today,
  version,
  digest,
  page,
  cursor,
} from '../lib/utils.mjs';
import { profiles, trainer, rate } from '../lib/profiles.mjs';
import { admin, owner } from '../lib/security.mjs';
import { strokesValid } from '../lib/domain.mjs';
export { profiles, trainer, admin, owner };
export const now = () => new Date().toISOString();
export const pair = (a, b) => a + '_' + b;
export async function required(s, t, key) {
  const r = await s.get(t, key);
  if (!r) fail(404, '자료를 찾을 수 없습니다.');
  return r;
}
export async function person(s, a, key, m = today().slice(0, 7)) {
  const p = await required(s, 'people', key);
  owner(a, p.id);
  const terms = await termsAt(s, p.id, m);
  return { ...p, profile: terms?.profile || p.profile };
}
export async function termsAt(s, pid, m) {
  return (
    (
      await s.query(
        'salary_terms',
        [
          ['person_id', '==', pid],
          ['effective_month', '<=', m],
        ],
        { order: [['effective_month', 'desc']], limit: 1, allowMore: true },
      )
    )[0] || null
  );
}
export async function owned(s, a, t, key) {
  const r = await required(s, t, key);
  owner(a, r.person_id);
  return r;
}
export async function guard(s, m, pid, global = false) {
  month(m);
  if ((await s.get('periods', m))?.state === 'closed')
    fail(409, '마감된 월입니다. 먼저 마감을 해제하세요.');
  const runs = global
    ? await s.query('payroll_runs', [['month', '==', m]])
    : [await s.get('payroll_runs', pair(pid, m))];
  if (runs.some((r) => r && r.state !== 'draft'))
    fail(409, '제출·승인된 정산입니다. 먼저 반려하세요.');
}
export async function contractLessons(s, cid) {
  return s.query(
    'lessons',
    [
      ['contract_id', '==', cid],
      ['status', '==', 'active'],
    ],
    { order: [['date'], ['time'], ['id']] },
  );
}
export async function progress(s, c) {
  const used = c.carry_used + (await contractLessons(s, c.id)).length;
  return { ...c, used, remaining: c.quantity - used };
}
export async function snapshot(s, lid) {
  const l = await required(s, 'lessons', lid);
  if (l.status !== 'active') return null;
  const c = await required(s, 'contracts', l.contract_id),
    m = await required(s, 'members', l.member_id),
    p = await required(s, 'people', l.person_id),
    rows = await contractLessons(s, c.id);
  const ordinal = c.carry_used + rows.findIndex((x) => x.id === lid) + 1;
  return {
    lessonId: l.id,
    contractId: c.id,
    memberId: m.id,
    personId: p.id,
    member: m.name,
    instructor: p.name,
    date: l.date,
    time: l.time,
    ordinal,
    registered: c.quantity,
    remaining: c.quantity - ordinal,
    category: c.category,
  };
}
export async function confirmation(s, l) {
  const sig = l.latest_signature_id ? await s.get('signatures', l.latest_signature_id) : null;
  const snap = sig ? await snapshot(s, l.id) : null;
  return {
    state: !sig
      ? 'unsigned'
      : snap && digest(JSON.stringify(snap)) === sig.fingerprint
        ? 'signed'
        : 'stale',
    signatureId: sig?.id || null,
    signedAt: sig?.signed_at || null,
  };
}
export async function addPerson(s, a, b) {
  admin(a);
  const profile = b.profile;
  if (!profiles[profile]) fail(400, '직책을 확인하세요.');
  const p = {
    id: id(),
    name: text(b.name, '이름'),
    profile,
    hire_month: month(b.hireMonth),
    end_date: null,
    active: 1,
    version: 1,
  };
  const terms = {
    id: pair(p.id, p.hire_month),
    person_id: p.id,
    effective_month: p.hire_month,
    profile,
    base: integer(b.base ?? profiles[profile].base, '기본급'),
    tax_bps: integer(b.taxBps ?? profiles[profile].tax, '세율', 0, 10000),
    version: 1,
  };
  await s.put('people', p.id, p, { create: true });
  await s.put('salary_terms', terms.id, terms, { create: true });
  await s.audit(a, 'create', 'person', p.id, '', { profile });
  return p;
}
export async function addMember(s, a, b) {
  const p = await person(s, a, b.personId || a.person_id);
  if (!trainer(p) || (p.end_date && p.end_date < today()))
    fail(400, '현재 근무 중인 트레이너를 선택하세요.');
  const r = {
    id: id(),
    person_id: p.id,
    name: text(b.name, '회원명'),
    external_ref: b.externalRef ? text(b.externalRef, '회원번호') : null,
    created_at: now(),
    active: 1,
    version: 1,
  };
  if (r.external_ref) await s.unique('member', r.external_ref, r.id);
  await s.put('members', r.id, r, { create: true });
  const assignment = {
    id: id(),
    member_id: r.id,
    person_id: p.id,
    effective_date: '0001-01-01',
    created_at: now(),
  };
  await s.put('member_assignments', assignment.id, assignment, { create: true });
  await s.audit(a, 'create', 'member', r.id);
  return r;
}
export async function addContract(s, a, b) {
  const m = await owned(s, a, 'members', b.memberId),
    p = await person(s, a, m.person_id);
  const paid = day(b.paidDate),
    start = day(b.startDate || paid),
    carryDate = day(b.carryDate || start);
  if (carryDate < start || (p.end_date && paid > p.end_date))
    fail(400, '등록일·기준일·직원 계약 기간을 확인하세요.');
  if (!['pt', 'pilates'].includes(b.category) || !['new', 'renew'].includes(b.saleType))
    fail(400, '등록 구분을 확인하세요.');
  if (b.vatIncluded !== undefined && typeof b.vatIncluded !== 'boolean')
    fail(400, 'VAT 포함 여부를 확인하세요.');
  await guard(s, paid.slice(0, 7), p.id, true);
  const qty = integer(b.quantity, '등록횟수', 1, 10000),
    raw = integer(b.amount, '결제금액');
  const c = {
    id: id(),
    member_id: m.id,
    person_id: p.id,
    paid_date: paid,
    start_date: start,
    carry_date: carryDate,
    category: b.category,
    sale_type: b.saleType,
    amount: b.vatIncluded ? Math.round(raw / 1.1) : raw,
    quantity: qty,
    carry_used: integer(b.carryUsed || 0, '기진행횟수', 0, qty),
    external_ref: b.externalRef || null,
    active: 1,
    version: 1,
  };
  if (c.external_ref) await s.unique('contract', c.external_ref, c.id);
  await s.put('contracts', c.id, c, { create: true });
  const sale = {
    id: id(),
    person_id: p.id,
    member_id: m.id,
    contract_id: c.id,
    date: paid,
    month: paid.slice(0, 7),
    category: c.category,
    kind: 'sale',
    amount: c.amount,
    original_id: null,
    legacy_refund: 0,
    note: b.saleType === 'new' ? '신규 PT 등록' : '기존 회원 추가 결제',
    version: 1,
  };
  await s.put('sales', sale.id, sale, { create: true });
  await s.audit(a, 'create', 'contract', c.id, '', { amount: c.amount, quantity: qty });
  return { ...c, used: c.carry_used, remaining: qty - c.carry_used };
}
async function lessonGuard(s, c, date) {
  await guard(s, date.slice(0, 7), c.person_id);
  const rows = await contractLessons(s, c.id);
  for (const m of new Set(rows.filter((l) => l.date >= date).map((l) => l.date.slice(0, 7))))
    await guard(s, m, c.person_id);
}
const slot = (l) => JSON.stringify([l.contract_id, l.date, l.time]);
export async function addLesson(s, a, b) {
  const c = await owned(s, a, 'contracts', b.contractId),
    p = await person(s, a, c.person_id);
  const date = day(b.date),
    time = text(b.time, '시간', 5);
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    date > today() ||
    date < c.start_date ||
    date < c.carry_date ||
    date.slice(0, 7) < p.hire_month ||
    (p.end_date && date > p.end_date) ||
    !c.active
  )
    fail(400, '수업 날짜·시간 또는 계약 상태를 확인하세요.');
  await lessonGuard(s, c, date);
  if ((await progress(s, c)).remaining <= 0) fail(409, '잔여 횟수가 없습니다.');
  const l = {
    id: id(),
    contract_id: c.id,
    person_id: c.person_id,
    member_id: c.member_id,
    date,
    time,
    month: date.slice(0, 7),
    status: 'active',
    reason: '',
    version: 1,
    created_at: now(),
    latest_signature_id: null,
  };
  await s.unique('lesson', slot(l), l.id);
  await s.put('lessons', l.id, l, { create: true });
  await s.audit(a, 'create', 'lesson', l.id, '', { contractId: c.id, date, time });
  return { ...l, confirmation: await confirmation(s, l) };
}
export async function changeLesson(s, a, key, b) {
  const l = await owned(s, a, 'lessons', key);
  version(l, b.version);
  if (l.status !== 'active') fail(409, '이미 취소된 수업입니다.');
  const c = await required(s, 'contracts', l.contract_id),
    p = await person(s, a, l.person_id);
  const date = day(b.date || l.date),
    time = b.time || l.time,
    reason = text(b.reason, '수정 사유', 200);
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    date > today() ||
    date < c.start_date ||
    date < c.carry_date ||
    date.slice(0, 7) < p.hire_month ||
    (p.end_date && date > p.end_date)
  )
    fail(400, '수업 날짜·시간을 확인하세요.');
  await lessonGuard(s, c, [l.date, date].sort()[0]);
  if (b.void && (await confirmation(s, l)).state !== 'unsigned') admin(a);
  const r = {
    ...l,
    date,
    time,
    month: date.slice(0, 7),
    status: b.void ? 'void' : 'active',
    reason,
    version: l.version + 1,
  };
  await s.release('lesson', slot(l), l.id);
  if (!b.void) await s.unique('lesson', slot(r), l.id);
  await s.put('lessons', key, r);
  await s.audit(a, b.void ? 'void' : 'correct', 'lesson', key, reason, {
    before: { date: l.date, time: l.time },
    after: { date, time },
  });
  return { ...r, confirmation: await confirmation(s, r) };
}
export async function signLesson(s, a, key, b) {
  const l = await owned(s, a, 'lessons', key);
  version(l, b.version);
  if (l.status !== 'active' || !trainer(await person(s, a, l.person_id, l.month)))
    fail(409, '서명 가능한 수업이 아닙니다.');
  const snap = await snapshot(s, key);
  if (JSON.stringify(snap) !== JSON.stringify(b.snapshot))
    fail(409, '수업 내용이 변경되었습니다. 다시 확인하세요.');
  if (b.confirmed !== true) fail(400, '회원 확인이 필요합니다.');
  if ((await confirmation(s, l)).state === 'signed') fail(409, '이미 서명된 수업입니다.');
  strokesValid(b.strokes);
  const payload = JSON.stringify(b.strokes),
    sig = {
      id: id(),
      lesson_id: key,
      person_id: l.person_id,
      snapshot: snap,
      fingerprint: digest(JSON.stringify(snap)),
      signed_at: now(),
      actor_id: a.id,
      payload_hash: digest(payload),
      confirmation: '회원이 해당 날짜·회차의 수업 진행을 확인했습니다.',
    };
  await s.put('signatures', sig.id, sig, { create: true });
  // JSON string prevents unsupported Firestore nested arrays; max validated 6000 points stays below document limit.
  await s.put('signature_payloads', sig.id, { id: sig.id, strokes: payload }, { create: true });
  await s.put('lessons', l.id, { ...l, latest_signature_id: sig.id });
  await s.audit(a, 'sign', 'lesson', key, '', {
    signatureId: sig.id,
    snapshotHash: sig.fingerprint,
  });
  return { id: sig.id, lesson_id: key, signed_at: sig.signed_at, payload_hash: sig.payload_hash };
}
export async function listMembers(s, a, url) {
  const { after, limit } = page(url),
    filters = [['active', '==', 1]],
    pid = a.role === 'admin' ? url.searchParams.get('personId') : a.person_id;
  if (pid) filters.push(['person_id', '==', pid]);
  const q = (url.searchParams.get('q') || '').slice(0, 80);
  let rows = await s.query('members', filters, {
    order: [['name'], ['id']],
    ...(q ? {} : { limit, after: after || undefined, allowMore: true }),
  });
  rows = rows.filter(
    (r) =>
      (!q || r.name.includes(q)) &&
      (!after || r.name > after[0] || (r.name === after[0] && r.id > after[1])),
  );
  const out = [];
  for (const r of rows.slice(0, limit)) {
    let remaining = 0;
    for (const c of await s.query('contracts', [
      ['member_id', '==', r.id],
      ['active', '==', 1],
    ]))
      remaining += (await progress(s, c)).remaining;
    out.push({ ...r, instructor: (await required(s, 'people', r.person_id)).name, remaining });
  }
  return { items: out, next: rows.length > limit ? cursor(out.at(-1).name, out.at(-1).id) : null };
}
export async function monthRows(s, t, m, pid = null) {
  month(m);
  return s.query(t, [['month', '==', m], ...(pid ? [['person_id', '==', pid]] : [])]);
}
export async function listLessons(s, a, url) {
  const m = month(url.searchParams.get('month')),
    { after, limit } = page(url),
    pid = a.role === 'admin' ? url.searchParams.get('personId') : a.person_id;
  let rows = (await monthRows(s, 'lessons', m, pid)).sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  if (after)
    rows = rows.filter((l) => l.date > after[0] || (l.date === after[0] && l.id > after[1]));
  const out = [];
  for (const l of rows.slice(0, limit)) {
    const c = await required(s, 'contracts', l.contract_id);
    out.push({
      ...l,
      member: (await required(s, 'members', l.member_id)).name,
      instructor: (await required(s, 'people', l.person_id)).name,
      quantity: c.quantity,
      amount: c.amount,
      confirmation: await confirmation(s, l),
    });
  }
  return { items: out, next: rows.length > limit ? cursor(out.at(-1).date, out.at(-1).id) : null };
}
export async function eligible(s, m) {
  const runs = await monthRows(s, 'payroll_runs', m),
    ids = new Set(runs.map((r) => r.person_id));
  return (await s.query('people', [['hire_month', '<=', m]]))
    .filter((p) => !p.end_date || p.end_date >= m + '-01' || ids.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function calculate(s, p, m) {
  const terms = await termsAt(s, p.id, m);
  if (!terms) fail(409, '급여 조건이 없습니다.');
  p = { ...p, profile: terms.profile };
  const rule = (
    await s.query(
      'rules',
      [
        ['profile', '==', p.profile],
        ['effective_month', '<=', m],
      ],
      { order: [['effective_month', 'desc']], limit: 1, allowMore: true },
    )
  )[0] || {
    id: 'default-' + p.profile,
    version: 1,
    body: { tiers: profiles[p.profile].tiers, bonus: profiles[p.profile].bonus },
  };
  const r = rule.body,
    input = (await s.get('monthly_inputs', pair(p.id, m))) || {
      hours100: 0,
      extra: 0,
      deduction: 0,
      version: 0,
      note: '',
    };
  const mine = (await monthRows(s, 'sales', m, p.id)).filter((x) => x.category !== 'membership');
  let newSales = 0,
    renewSales = 0;
  for (const sale of mine.filter((x) => x.kind === 'sale' && x.contract_id)) {
    const c = await required(s, 'contracts', sale.contract_id);
    if (c.sale_type === 'new') newSales += sale.amount;
    else renewSales += sale.amount;
  }
  const revenue = mine.reduce((n, x) => n + x.amount, 0);
  let percent = rate(r.tiers, revenue);
  const age =
    (Number(m.slice(0, 4)) - Number(p.hire_month.slice(0, 4))) * 12 +
    Number(m.slice(5)) -
    Number(p.hire_month.slice(5));
  if (p.profile === 'mixed' && age >= 0 && age < 2) percent = Math.max(45, percent);
  const lines = [];
  const lessons = (await monthRows(s, 'lessons', m, p.id))
    .filter((l) => l.status === 'active')
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
    );
  for (const l of lessons) {
    const c = await required(s, 'contracts', l.contract_id),
      sig = await confirmation(s, l);
    lines.push({
      lessonId: l.id,
      contractId: c.id,
      memberId: l.member_id,
      memberName: (await required(s, 'members', l.member_id)).name,
      supplyAmount: c.amount,
      registered: c.quantity,
      date: l.date,
      time: l.time,
      version: l.version,
      unit: trainer(p) ? Math.round(((c.amount / c.quantity) * percent) / 100) : 0,
      signature: sig.state,
      signatureId: sig.signatureId,
    });
  }
  const commission = lines.reduce((n, l) => n + l.unit, 0),
    bonus =
      r.bonus && revenue >= 10000000
        ? (1 + Math.floor((revenue - 10000000) / 2000000)) * 200000
        : 0;
  const totals = { membership: 0, pt: 0, center: 0 };
  if (['manager', 'lead', 'fc'].includes(p.profile))
    for (const sale of await monthRows(s, 'sales', m)) {
      if (sale.category === 'membership') totals.membership += sale.amount;
      if (sale.category === 'pt') totals.pt += sale.amount;
      if (!sale.legacy_refund) totals.center += sale.amount;
    }
  const membership = Math.max(0, totals.membership),
    pt = Math.max(0, totals.pt),
    center = Math.max(0, totals.center);
  let incentive = 0;
  if (p.profile === 'manager')
    incentive = Math.round(
      Math.min(center, 80000000) * 0.02 + Math.max(0, center - 80000000) * 0.04,
    );
  if (p.profile === 'fc')
    incentive = Math.round(
      (membership *
        rate(
          [
            [0, 0],
            [35000000, 2],
            [40000000, 2.5],
            [45000000, 3],
          ],
          membership,
        )) /
        100,
    );
  if (p.profile === 'lead')
    incentive = Math.round(
      (pt *
        rate(
          [
            [0, 0],
            [30000000, 2],
            [35000000, 2.5],
            [40000000, 3],
          ],
          pt,
        )) /
        100,
    );
  const base = p.profile === 'part' ? Math.round((terms.base * input.hours100) / 100) : terms.base,
    gross = base + commission + bonus + incentive + input.extra,
    tax = Math.floor((gross * terms.tax_bps) / 10000),
    net = gross - tax - input.deduction;
  return {
    personId: p.id,
    name: p.name,
    profile: p.profile,
    month: m,
    revenue,
    newSales,
    renewSales,
    rate: percent,
    lessons: lines.length,
    commission,
    bonus,
    incentive,
    base,
    extra: input.extra,
    deduction: input.deduction,
    taxBps: terms.tax_bps,
    tax,
    gross,
    net,
    unconfirmed: lines.filter((l) => l.signature !== 'signed').length,
    termsId: terms.id,
    termsVersion: terms.version,
    ruleId: rule.id,
    ruleVersion: rule.version,
    inputVersion: input.version,
    calculationVersion: 'firebase-payroll-v1',
    internal: { terms, rule, centerTotals: totals },
    lines,
    sales: mine.map((x) => ({ id: x.id, amount: x.amount, version: x.version })),
  };
}
export async function result(s, a, pid, m) {
  const p = await person(s, a, pid, m);
  month(m);
  const run = (await s.get('payroll_runs', pair(pid, m))) || {
    state: 'draft',
    version: 0,
    note: '',
  };
  if (p.hire_month > m || (p.end_date && p.end_date.slice(0, 7) < m && run.version === 0))
    fail(404, '근무 기간 밖의 정산입니다.');
  const frozen = run.state === 'approved' && run.snapshot_id;
  const calculated = frozen
    ? JSON.parse((await required(s, 'payroll_versions', run.snapshot_id)).body)
    : await calculate(s, p, m);
  let currentUnconfirmed = calculated.unconfirmed;
  if (frozen) {
    currentUnconfirmed = 0;
    for (const l of (await monthRows(s, 'lessons', m, pid)).filter((l) => l.status === 'active'))
      if ((await confirmation(s, l)).state !== 'signed') currentUnconfirmed++;
  }
  const out = {
    ...calculated,
    currentUnconfirmed,
    state: run.state,
    version: run.version,
    note: run.note,
    frozen: !!frozen,
    periodClosed: (await s.get('periods', m))?.state === 'closed',
  };
  delete out.internal;
  return out;
}
