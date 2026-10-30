import { admin, owner } from './security.mjs';
import {
  month,
  day,
  text,
  integer,
  id,
  json,
  version,
  fail,
  bounds,
  digest,
  today,
} from './utils.mjs';
import { profiles, trainer } from './profiles.mjs';
import { audit, financialGuard, person, payroll, result, eligible } from './domain.mjs';
import { reconcile } from './daygym.mjs';
export function setTerms(s, a, key, b) {
  admin(a);
  const p = person(s, a, key),
    m = month(b.month);
  if (m < p.hire_month) fail(400, '입사 월 이후 조건을 입력하세요.');
  if (
    s.one("SELECT 1 FROM periods WHERE state='closed' AND month>=? LIMIT 1", m) ||
    s.one(
      "SELECT 1 FROM payroll_runs WHERE person_id=? AND month>=? AND state!='draft' LIMIT 1",
      key,
      m,
    )
  )
    fail(409, '확정된 월에 영향을 주는 조건은 바꿀 수 없습니다. 적용 월을 이후로 설정하세요.');
  const old = s.one('SELECT * FROM salary_terms WHERE person_id=? AND effective_month=?', key, m);
  if (old) version(old, b.version);
  else if (b.version !== 0) fail(409, '급여 조건을 다시 조회하세요.');
  const profile = b.profile || p.profile;
  if (!profiles[profile]) fail(400, '직책을 확인하세요.');
  const base = integer(b.base, '기본급/시급'),
    tax = integer(b.taxBps, '원천징수율', 0, 10000),
    reason = text(b.reason, '변경 사유', 200);
  if (old)
    s.run(
      'UPDATE salary_terms SET profile=?,base=?,tax_bps=?,version=version+1 WHERE id=?',
      profile,
      base,
      tax,
      old.id,
    );
  else
    s.run(
      'INSERT INTO salary_terms(id,person_id,effective_month,profile,base,tax_bps) VALUES(?,?,?,?,?,?)',
      id(),
      key,
      m,
      profile,
      base,
      tax,
    );
  audit(s, a, 'terms', 'person', key, reason, { effectiveMonth: m, base, tax });
  return { ok: true };
}
export function setInputs(s, a, key, m, b) {
  admin(a);
  person(s, a, key);
  financialGuard(s, m, key);
  const old = s.one('SELECT * FROM monthly_inputs WHERE person_id=? AND month=?', key, m);
  if (old) version(old, b.version);
  else if (b.version !== 0) fail(409, '월별 급여 입력을 다시 조회하세요.');
  const hours = integer(b.hours100, '근무시간', 0, 74400),
    extra = integer(b.extra, '추가수당'),
    deduction = integer(b.deduction, '별도공제'),
    note = text(b.note, '입력 사유', 300);
  s.run(
    'INSERT INTO monthly_inputs(person_id,month,hours100,extra,deduction,note) VALUES(?,?,?,?,?,?) ON CONFLICT(person_id,month) DO UPDATE SET hours100=excluded.hours100,extra=excluded.extra,deduction=excluded.deduction,note=excluded.note,version=monthly_inputs.version+1',
    key,
    m,
    hours,
    extra,
    deduction,
    note,
  );
  audit(s, a, 'monthly-input', 'person', key, note, {
    month: m,
    hours100: hours,
    extra,
    deduction,
  });
  return { ok: true };
}
export function setRule(s, a, b) {
  admin(a);
  if (!profiles[b.profile]) fail(400, '직책을 확인하세요.');
  const m = month(b.month);
  if (
    s.one("SELECT 1 FROM periods WHERE state='closed' AND month>=? LIMIT 1", m) ||
    s.one("SELECT 1 FROM payroll_runs WHERE month>=? AND state!='draft' LIMIT 1", m)
  )
    fail(409, '제출·확정된 월에 영향을 주는 지급률은 변경할 수 없습니다.');
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
      fail(400, '매출 구간·지급률을 확인하세요.');
  const old = s.one('SELECT * FROM rules WHERE profile=? AND effective_month=?', b.profile, m);
  if (old) version(old, b.version);
  else if (b.version !== 0) fail(409, '지급률을 다시 조회하세요.');
  const body = JSON.stringify({
      tiers: [...b.tiers].sort((a, b) => a[0] - b[0]),
      bonus: !!b.bonus,
    }),
    reason = text(b.reason, '변경 사유', 200);
  if (old) s.run('UPDATE rules SET body=?,version=version+1 WHERE id=?', body, old.id);
  else
    s.run(
      'INSERT INTO rules(id,profile,effective_month,body) VALUES(?,?,?,?)',
      id(),
      b.profile,
      m,
      body,
    );
  audit(s, a, 'rule', 'rule', old?.id || b.profile, reason, { month: m });
  return { ok: true };
}
export function addSale(s, a, b) {
  admin(a);
  const date = day(b.date),
    category = b.category;
  if (!['pt', 'pilates', 'membership'].includes(category)) fail(400, '매출 종류를 확인하세요.');
  if (b.personId) {
    const p = person(s, a, b.personId);
    if (category !== 'membership' && !trainer(p))
      fail(400, 'PT·개인 필라테스는 트레이너에게 배정하세요.');
  }
  if (category !== 'membership' && !b.personId) fail(400, '개인 매출 담당을 선택하세요.');
  financialGuard(s, date.slice(0, 7), b.personId || null, true);
  const amount = integer(b.amount, '공급가액', 1),
    note = text(b.note, '거래 사유', 300),
    key = id();
  let original = null,
    signedAmount = amount,
    memberId = null,
    contractId = null,
    personId = b.personId || null;
  if (b.kind === 'refund') {
    original = s.one("SELECT * FROM sales WHERE id=? AND kind='sale'", b.originalId);
    if (!original) fail(400, '원결제 거래를 선택하세요.');
    if (original.category !== category || original.person_id !== personId)
      fail(400, '원결제와 매출 종류·담당이 다릅니다.');
    const refunded = -s.one(
      "SELECT coalesce(sum(amount),0) n FROM sales WHERE original_id=? AND kind='refund'",
      original.id,
    ).n;
    if (amount > original.amount - refunded) fail(400, '원결제의 남은 금액을 초과한 환불입니다.');
    if (date < original.date) fail(400, '환불일은 원결제 이후여야 합니다.');
    signedAmount = -amount;
    memberId = original.member_id;
    contractId = original.contract_id;
  } else if (b.kind !== 'sale') fail(400, '거래 구분을 확인하세요.');
  s.run(
    'INSERT INTO sales(id,person_id,member_id,contract_id,date,category,kind,amount,original_id,legacy_refund,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    key,
    personId,
    memberId,
    contractId,
    date,
    category,
    b.kind,
    signedAmount,
    original?.id || null,
    b.kind === 'refund' && b.legacyRefund ? 1 : 0,
    note,
  );
  if (original?.contract_id) {
    const total = -s.one(
      "SELECT coalesce(sum(amount),0) n FROM sales WHERE original_id=? AND kind='refund'",
      original.id,
    ).n;
    if (total >= original.amount) {
      s.run('UPDATE contracts SET active=0,version=version+1 WHERE id=?', original.contract_id);
      audit(s, a, 'contract-close', 'contract', original.contract_id, '원결제 전액 환불', {
        saleId: key,
      });
    }
  }
  audit(s, a, b.kind, 'sale', key, note, {
    amount: signedAmount,
    originalId: original?.id || null,
  });
  return s.one('SELECT * FROM sales WHERE id=?', key);
}
export function payrollAction(s, a, key, m, b) {
  person(s, a, key);
  month(m);
  if (m > today().slice(0, 7)) fail(400, '미래 월 정산은 제출·승인할 수 없습니다.');
  const p = s.one('SELECT * FROM people WHERE id=?', key),
    run = s.one('SELECT * FROM payroll_runs WHERE person_id=? AND month=?', key, m) || {
      state: 'draft',
      version: 0,
    };
  if (run.version !== b.version) fail(409, '정산 상태가 바뀌었습니다. 다시 조회하세요.');
  if (s.one('SELECT state FROM periods WHERE month=?', m)?.state === 'closed')
    fail(409, '마감 해제 후 처리하세요.');
  const action = b.action;
  let target,
    note = '';
  if (action === 'submit') {
    owner(a, key);
    if (run.state !== 'draft') fail(409, '작성 중인 정산만 제출할 수 있습니다.');
    target = 'submitted';
  } else if (action === 'return') {
    admin(a);
    if (run.state === 'draft') fail(409, '이미 작성 중입니다.');
    target = 'draft';
    note = text(b.note, '반려 사유', 500);
  } else if (action === 'approve') {
    admin(a);
    if (run.state !== 'submitted') fail(409, '직원이 제출한 정산만 승인할 수 있습니다.');
    target = 'approved';
  } else fail(400, '정산 작업을 확인하세요.');
  let snap = null;
  if (target !== 'draft') {
    const calculated = payroll(s, p, m),
      comparison = reconcile(s, m, key),
      hasSource = !!s.one(
        'SELECT 1 FROM source_records WHERE person_id=? AND date>=? AND date<? LIMIT 1',
        key,
        ...bounds(m),
      ),
      outstanding = comparison.filter(
        (r) =>
          r.kind !== 'matched' &&
          !r.reviewed &&
          !['source-reserved', 'source-cancelled', 'source-absent'].includes(r.kind),
      );
    const warning = {
      unconfirmed: calculated.unconfirmed,
      unresolved: outstanding.length,
      sourceMissing:
        trainer({ profile: calculated.profile }) && calculated.lessons > 0 && !hasSource,
    };
    if (
      target === 'approved' &&
      (warning.unconfirmed || warning.unresolved || warning.sourceMissing)
    )
      note = text(b.note, '미서명·미해결 또는 다짐 미가져오기 예외 승인 사유', 500);
    else if (b.note) note = text(b.note, '확인 메모', 500);
    snap = id();
    s.run(
      'INSERT INTO payroll_versions VALUES(?,?,?,?,?,?)',
      snap,
      key,
      m,
      JSON.stringify({ ...calculated, warning, approvalNote: note }),
      a.id,
      new Date().toISOString(),
    );
  }
  s.run(
    'INSERT INTO payroll_runs(person_id,month,state,snapshot_id,note) VALUES(?,?,?,?,?) ON CONFLICT(person_id,month) DO UPDATE SET state=excluded.state,snapshot_id=excluded.snapshot_id,note=excluded.note,version=payroll_runs.version+1',
    key,
    m,
    target,
    snap,
    note,
  );
  audit(s, a, action, 'payroll', key, note, { month: m, snapshotId: snap });
  return result(s, a, key, m);
}
export function periodAction(s, a, m, b) {
  admin(a);
  month(m);
  if (m > today().slice(0, 7)) fail(400, '미래 월은 마감할 수 없습니다.');
  const old = s.one('SELECT * FROM periods WHERE month=?', m) || { state: 'open', version: 0 };
  if (old.version !== b.version) fail(409, '마감 상태가 변경되었습니다.');
  const note = text(b.note, '마감/해제 사유', 500);
  if (b.action === 'close') {
    if (old.state === 'closed') fail(409, '이미 마감되었습니다.');
    const people = eligible(s, m);
    if (!people.length) fail(409, '마감할 직원이 없습니다.');
    for (const p of people)
      if (
        s.one('SELECT state FROM payroll_runs WHERE person_id=? AND month=?', p.id, m)?.state !==
        'approved'
      )
        fail(409, '모든 대상 직원의 승인이 필요합니다.');
    s.run(
      "INSERT INTO periods(month,state) VALUES(?,'closed') ON CONFLICT(month) DO UPDATE SET state='closed',version=periods.version+1",
      m,
    );
  } else if (b.action === 'reopen') {
    if (old.state !== 'closed') fail(409, '마감된 월만 해제할 수 있습니다.');
    s.run("UPDATE periods SET state='open',version=version+1 WHERE month=?", m);
    s.run(
      "UPDATE payroll_runs SET state='draft',snapshot_id=NULL,note=?,version=version+1 WHERE month=?",
      note,
      m,
    );
  } else fail(400, '마감 작업을 확인하세요.');
  audit(s, a, b.action, 'period', m, note);
  return s.one('SELECT * FROM periods WHERE month=?', m);
}
export function endEmployment(s, a, key, b) {
  admin(a);
  const p = person(s, a, key);
  version(p, b.version);
  const end = day(b.endDate);
  if (end.slice(0, 7) < p.hire_month) fail(400, '입사 이전으로 계약을 종료할 수 없습니다.');
  if (
    s.one(
      'SELECT 1 FROM payroll_versions WHERE person_id=? AND month>? LIMIT 1',
      key,
      end.slice(0, 7),
    )
  )
    fail(409, '이미 제출·승인한 이후 월이 있습니다. 먼저 해당 정산을 검토하세요.');
  const reason = text(b.reason, '계약 종료 사유', 300);
  s.run(
    'UPDATE people SET end_date=?,active=?,version=version+1 WHERE id=?',
    end,
    end < today() ? 0 : 1,
    key,
  );
  if (
    end <
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  )
    s.run(
      'DELETE FROM auth_sessions WHERE account_id IN(SELECT id FROM accounts WHERE person_id=?)',
      key,
    );
  audit(s, a, 'employment-end', 'person', key, reason, { endDate: end });
  return { ok: true };
}
export function transferMember(s, a, key, b) {
  admin(a);
  const m = s.one('SELECT * FROM members WHERE id=?', key);
  version(m, b.version);
  const target = person(s, a, b.personId);
  if (!trainer(target) || (target.end_date && target.end_date < day(b.effectiveDate)))
    fail(400, '배정 가능한 트레이너를 선택하세요.');
  if (target.id === m.person_id) fail(400, '현재 담당자와 같습니다.');
  const date = day(b.effectiveDate);
  if (
    date >
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  )
    fail(400, '현재 또는 과거 인수인계일을 선택하세요.');
  const last = s.one(
    'SELECT effective_date FROM member_assignments WHERE member_id=? ORDER BY effective_date DESC LIMIT 1',
    key,
  );
  if (last && last.effective_date > date) fail(409, '이전 인수인계일보다 뒤 날짜로 입력하세요.');
  const reason = text(b.reason, '인수인계 사유', 300);
  s.run('UPDATE members SET person_id=?,version=version+1 WHERE id=?', target.id, key);
  s.run(
    'UPDATE contracts SET person_id=?,version=version+1 WHERE member_id=? AND active=1',
    target.id,
    key,
  );
  s.run(
    'INSERT INTO member_assignments VALUES(?,?,?,?,?)',
    id(),
    key,
    target.id,
    date,
    new Date().toISOString(),
  );
  audit(s, a, 'transfer', 'member', key, reason, {
    from: m.person_id,
    to: target.id,
    effectiveDate: date,
  });
  return { ok: true };
}
export function closeContract(s, a, key, b) {
  admin(a);
  const c = s.one('SELECT * FROM contracts WHERE id=?', key);
  version(c, b.version);
  if (!c.active) fail(409, '이미 종료된 회원권입니다.');
  const reason = text(b.reason, '회원권 종료 사유', 300);
  s.run('UPDATE contracts SET active=0,version=version+1 WHERE id=?', key);
  audit(s, a, 'contract-close', 'contract', key, reason, { memberId: c.member_id });
  return { ok: true };
}
