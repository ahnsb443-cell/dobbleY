import { id, fail, text, day, month, integer, today, version, digest } from '../lib/utils.mjs';
import {
  required,
  person,
  owned,
  guard,
  eligible,
  calculate,
  result,
  pair,
  monthRows,
  confirmation,
  now,
  profiles,
  trainer,
  admin,
} from './domain.mjs';
import { reconcile } from './imports.mjs';
export async function settings(s, a, kind, pid, b) {
  admin(a);
  const m = month(b.month),
    p = pid ? await person(s, a, pid, m) : null;
  if (kind !== 'inputs') {
    if (
      (
        await s.query('periods', [
          ['state', '==', 'closed'],
          ['month', '>=', m],
        ])
      ).length ||
      (
        await s.query('payroll_runs', [
          ['month', '>=', m],
          ...(pid ? [['person_id', '==', pid]] : []),
        ])
      ).some((r) => r.state !== 'draft')
    )
      fail(409, '확정된 월에 영향을 주는 조건은 변경할 수 없습니다.');
  }
  if (kind === 'terms') {
    if (m < p.hire_month) fail(400, '입사 이후 조건을 입력하세요.');
    const key = pair(pid, m),
      old = await s.get('salary_terms', key);
    version(old || { version: 0 }, b.version);
    const profile = b.profile || p.profile;
    if (!profiles[profile]) fail(400, '직책을 확인하세요.');
    const r = {
      id: key,
      person_id: pid,
      effective_month: m,
      profile,
      base: integer(b.base, '기본급'),
      tax_bps: integer(b.taxBps, '세율', 0, 10000),
      version: (old?.version || 0) + 1,
    };
    await s.put('salary_terms', key, r);
    await s.audit(a, 'terms', 'person', pid, text(b.reason, '변경 사유', 300), {
      effectiveMonth: m,
    });
    return { ok: true };
  }
  if (kind === 'inputs') {
    await guard(s, m, pid);
    const key = pair(pid, m),
      old = await s.get('monthly_inputs', key);
    version(old || { version: 0 }, b.version);
    const r = {
      id: key,
      person_id: pid,
      month: m,
      hours100: integer(b.hours100, '근무시간 / 일수', 0, p.profile === 'daily' ? 3100 : 74400),
      ...(b.workMinutes === undefined
        ? {}
        : { work_minutes: integer(b.workMinutes, '월 근무 분', 0, 44640) }),

      extra: integer(b.extra, '수당'),
      deduction: integer(b.deduction, '공제'),
      note: text(b.note, '입력 사유', 300),
      version: (old?.version || 0) + 1,
    };
    await s.put('monthly_inputs', key, r);
    await s.audit(a, 'monthly-input', 'person', pid, r.note, { month: m });
    return { ok: true };
  }
  if (!profiles[b.profile]) fail(400, '직책을 확인하세요.');
  if (
    !Array.isArray(b.tiers) ||
    !b.tiers.length ||
    b.tiers.length > 20 ||
    !b.tiers.some((t) => t[0] === 0) ||
    new Set(b.tiers.map((t) => t[0])).size !== b.tiers.length
  )
    fail(400, '0원부터 시작하는 중복 없는 구간이 필요합니다.');
  for (const t of b.tiers)
    if (
      !Array.isArray(t) ||
      t.length !== 2 ||
      !Number.isSafeInteger(t[0]) ||
      t[0] < 0 ||
      !Number.isFinite(t[1]) ||
      t[1] < 0 ||
      t[1] > 100
    )
      fail(400, '구간·지급률을 확인하세요.');
  const key = pair(b.profile, m),
    old = await s.get('rules', key);
  version(old || { version: 0 }, b.version);
  await s.put('rules', key, {
    id: key,
    profile: b.profile,
    effective_month: m,
    body: { tiers: [...b.tiers].sort((a, b) => a[0] - b[0]), bonus: !!b.bonus },
    version: (old?.version || 0) + 1,
  });
  await s.audit(a, 'rule', 'rule', key, text(b.reason, '변경 사유', 300));
  return { ok: true };
}
export async function addSale(s, a, b) {
  admin(a);
  const date = day(b.date),
    category = b.category;
  if (!['pt', 'pilates', 'membership'].includes(category) || !['sale', 'refund'].includes(b.kind))
    fail(400, '거래 구분을 확인하세요.');
  if (category !== 'membership' && !b.personId) fail(400, '담당자를 선택하세요.');
  if (b.personId && category !== 'membership' && !trainer(await person(s, a, b.personId)))
    fail(400, '트레이너를 선택하세요.');
  await guard(s, date.slice(0, 7), b.personId || null, true);
  const amount = integer(b.amount, '공급가액', 1),
    note = text(b.note, '거래 사유', 300);
  let original = null;
  if (b.kind === 'refund') {
    original = await required(s, 'sales', b.originalId);
    if (
      original.kind !== 'sale' ||
      original.category !== category ||
      original.person_id !== (b.personId || null) ||
      date < original.date
    )
      fail(400, '원결제 내역을 확인하세요.');
    const refunded = -(await s.query('sales', [['original_id', '==', original.id]])).reduce(
      (n, x) => n + x.amount,
      0,
    );
    if (amount > original.amount - refunded) fail(400, '원결제 잔여 금액을 초과했습니다.');
    if (original.contract_id && amount + refunded >= original.amount) {
      const c = await required(s, 'contracts', original.contract_id);
      await s.put('contracts', c.id, { ...c, active: 0, version: c.version + 1 });
    }
  }
  const r = {
    id: id(),
    person_id: b.personId || null,
    member_id: original?.member_id || null,
    contract_id: original?.contract_id || null,
    date,
    month: date.slice(0, 7),
    category,
    kind: b.kind,
    amount: b.kind === 'refund' ? -amount : amount,
    original_id: original?.id || null,
    owner_profile:
      original?.owner_profile ||
      (b.personId ? (await person(s, a, b.personId, date.slice(0, 7))).profile : null),
    team_pt_eligible:
      original && typeof original.team_pt_eligible === 'boolean'
        ? original.team_pt_eligible
        : category === 'pt' &&
          !!b.personId &&
          (await person(s, a, b.personId, date.slice(0, 7))).profile !== 'manager',
    legacy_refund: b.kind === 'refund' && b.legacyRefund ? 1 : 0,
    note,
    version: 1,
  };
  await s.put('sales', r.id, r, { create: true });
  await s.audit(a, b.kind, 'sale', r.id, note, { amount: r.amount });
  return r;
}
const unresolved = (rows) =>
  rows.filter(
    (r) =>
      r.kind !== 'matched' &&
      !r.reviewed &&
      !['source-reserved', 'source-cancelled', 'source-absent'].includes(r.kind),
  );
export async function payrollAction(s, a, pid, m, b) {
  month(m);
  const p = await person(s, a, pid, m);
  if (m > today().slice(0, 7)) fail(400, '미래 월 정산은 제출할 수 없습니다.');
  const key = pair(pid, m),
    run = (await s.get('payroll_runs', key)) || { state: 'draft', version: 0 };
  version(run, b.version);
  if ((await s.get('periods', m))?.state === 'closed') fail(409, '마감 해제 후 처리하세요.');
  let target,
    note = '';
  if (b.action === 'submit') {
    if (run.state !== 'draft') fail(409, '작성 중인 정산만 제출하세요.');
    target = 'submitted';
  } else if (b.action === 'return') {
    admin(a);
    if (run.state === 'draft') fail(409, '이미 작성 중입니다.');
    target = 'draft';
    note = text(b.note, '반려 사유', 500);
  } else if (b.action === 'approve') {
    admin(a);
    if (run.state !== 'submitted') fail(409, '제출된 정산만 승인하세요.');
    target = 'approved';
  } else fail(400, '정산 작업을 확인하세요.');
  let snapshotId = null;
  if (target !== 'draft') {
    const calc = await calculate(s, p, m),
      comparison = await reconcile(s, m, pid),
      source = await monthRows(s, 'source_records', m, pid);
    const warning = {
      unconfirmed: calc.unconfirmed,
      unresolved: unresolved(comparison).length,
      sourceMissing: trainer({ profile: calc.profile }) && calc.lessons > 0 && !source.length,
    };
    if (
      target === 'approved' &&
      (warning.unconfirmed || warning.unresolved || warning.sourceMissing)
    )
      note = text(b.note, '예외 승인 사유', 500);
    else if (b.note) note = text(b.note, '확인 메모', 500);
    snapshotId = id();
    // JSON string supports tier tuples and avoids Firestore nested-array restrictions.
    await s.put(
      'payroll_versions',
      snapshotId,
      {
        id: snapshotId,
        person_id: pid,
        month: m,
        body: JSON.stringify({ ...calc, warning, approvalNote: note }),
        actor_id: a.id,
        created_at: now(),
      },
      { create: true },
    );
  }
  await s.put('payroll_runs', key, {
    id: key,
    person_id: pid,
    month: m,
    state: target,
    snapshot_id: snapshotId,
    note,
    version: run.version + 1,
  });
  await s.audit(a, b.action, 'payroll', pid, note, { month: m, snapshotId });
  return result(s, a, pid, m);
}
export async function periodAction(s, a, m, b) {
  admin(a);
  month(m);
  if (m > today().slice(0, 7)) fail(400, '미래 월은 마감할 수 없습니다.');
  const old = (await s.get('periods', m)) || { state: 'open', version: 0 };
  version(old, b.version);
  const note = text(b.note, '마감/해제 사유', 500);
  if (b.action === 'close') {
    if (old.state === 'closed') fail(409, '이미 마감되었습니다.');
    const people = await eligible(s, m);
    if (!people.length) fail(409, '마감 대상이 없습니다.');
    for (const p of people)
      if ((await s.get('payroll_runs', pair(p.id, m)))?.state !== 'approved')
        fail(409, '모든 대상 직원의 승인이 필요합니다.');
  } else if (b.action === 'reopen') {
    if (old.state !== 'closed') fail(409, '마감된 월만 해제하세요.');
    for (const r of await monthRows(s, 'payroll_runs', m))
      await s.put('payroll_runs', r.id, {
        ...r,
        state: 'draft',
        snapshot_id: null,
        note,
        version: r.version + 1,
      });
  } else fail(400, '마감 작업을 확인하세요.');
  const r = {
    id: m,
    month: m,
    state: b.action === 'close' ? 'closed' : 'open',
    version: old.version + 1,
  };
  await s.put('periods', m, r);
  await s.audit(a, b.action, 'period', m, note);
  return r;
}
export async function employment(s, a, pid, b) {
  admin(a);
  const p = await required(s, 'people', pid);
  version(p, b.version);
  const end = day(b.endDate);
  if (end.slice(0, 7) < p.hire_month) fail(400, '입사 이후 날짜를 입력하세요.');
  if (
    (
      await s.query('payroll_versions', [
        ['person_id', '==', pid],
        ['month', '>', end.slice(0, 7)],
      ])
    ).length
  )
    fail(409, '종료 이후 제출·승인 내역을 먼저 검토하세요.');
  await s.put('people', pid, {
    ...p,
    end_date: end,
    active: end < today() ? 0 : 1,
    version: p.version + 1,
  });
  await s.audit(a, 'employment-end', 'person', pid, text(b.reason, '종료 사유', 300), {
    endDate: end,
  });
  return { ok: true };
}
export async function transfer(s, a, key, b) {
  admin(a);
  const m = await required(s, 'members', key);
  version(m, b.version);
  const target = await person(s, a, b.personId),
    date = day(b.effectiveDate);
  if (
    !trainer(target) ||
    date > today() ||
    date.slice(0, 7) < target.hire_month ||
    (target.end_date && target.end_date < date) ||
    m.person_id === target.id
  )
    fail(400, '새 담당·인수인계일을 확인하세요.');
  const assignments = await s.query('member_assignments', [['member_id', '==', key]]);
  if (assignments.some((x) => x.effective_date > date))
    fail(409, '이전 인수인계 이후 날짜를 선택하세요.');
  await s.put('members', key, { ...m, person_id: target.id, version: m.version + 1 });
  for (const c of await s.query('contracts', [
    ['member_id', '==', key],
    ['active', '==', 1],
  ]))
    await s.put('contracts', c.id, { ...c, person_id: target.id, version: c.version + 1 });
  const r = {
    id: id(),
    member_id: key,
    person_id: target.id,
    effective_date: date,
    created_at: now(),
  };
  await s.put('member_assignments', r.id, r, { create: true });
  await s.audit(a, 'transfer', 'member', key, text(b.reason, '인수인계 사유', 300), {
    from: m.person_id,
    to: target.id,
    effectiveDate: date,
  });
  return { ok: true };
}
export async function closeContract(s, a, key, b) {
  admin(a);
  const c = await required(s, 'contracts', key);
  version(c, b.version);
  if (!c.active) fail(409, '이미 종료된 회원권입니다.');
  await s.put('contracts', key, { ...c, active: 0, version: c.version + 1 });
  await s.audit(a, 'contract-close', 'contract', key, text(b.reason, '종료 사유', 300));
  return { ok: true };
}

export async function setMembershipTotal(s, a, b) {
  admin(a);
  const m = month(b.month);
  await guard(s, m, null, true);
  const old = await s.get('membership_totals', m);
  version(old || { version: 0 }, b.version);
  if (typeof b.vatIncluded !== 'boolean') fail(400, 'VAT 포함 여부를 확인하세요.');
  const raw = integer(b.amount, '월 멤버십 총매출', -10000000000, 10000000000),
    amount = b.vatIncluded ? Math.round(raw / 1.1) : raw;
  const r = {
    id: m,
    month: m,
    raw_amount: raw,
    amount,
    vat_included: b.vatIncluded,
    note: text(b.note, '집계 메모', 300),
    version: (old?.version || 0) + 1,
    updated_at: now(),
    actor_id: a.id,
  };
  await s.put('membership_totals', m, r);
  await s.audit(a, 'membership-month-total', 'membership-total', m, r.note, {
    before: old?.amount ?? null,
    after: amount,
    raw,
    vatIncluded: b.vatIncluded,
  });
  return r;
}
