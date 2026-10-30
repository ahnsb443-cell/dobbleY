import {
  id,
  fail,
  day,
  month,
  bounds,
  integer,
  number,
  text,
  version,
  json,
  digest,
  cursor,
  page,
  today,
} from './utils.mjs';
import { profiles, trainer, rate } from './profiles.mjs';
import { admin, owner } from './security.mjs';
export function audit(s, a, action, entity, key, reason = '', details = {}) {
  s.run(
    'INSERT INTO audit(actor_id,action,entity,entity_id,reason,details,created_at) VALUES(?,?,?,?,?,?,?)',
    a?.id || null,
    action,
    entity,
    key,
    reason,
    JSON.stringify(details),
    new Date().toISOString(),
  );
}
export function seed(s) {
  for (const [p, r] of Object.entries(profiles))
    s.run(
      'INSERT OR IGNORE INTO rules(id,profile,effective_month,body) VALUES(?,?,?,?)',
      'default-' + p,
      p,
      '2000-01',
      JSON.stringify({ tiers: r.tiers, bonus: r.bonus }),
    );
}
export function financialGuard(s, m, personId, global = false) {
  month(m);
  if (s.one('SELECT state FROM periods WHERE month=?', m)?.state === 'closed')
    fail(409, '마감된 월입니다. 관리자가 사유와 함께 마감을 해제해야 합니다.');
  const locked = global
    ? s.one("SELECT 1 FROM payroll_runs WHERE month=? AND state!='draft' LIMIT 1", m)
    : s.one(
        "SELECT 1 FROM payroll_runs WHERE month=? AND person_id=? AND state!='draft'",
        m,
        personId,
      );
  if (locked) fail(409, '제출·승인된 정산입니다. 관리자가 먼저 반려해야 수정할 수 있습니다.');
}
function lessonGuard(s, c, date) {
  financialGuard(s, date.slice(0, 7), c.person_id);
  for (const r of s.all(
    "SELECT DISTINCT substr(date,1,7) month FROM lessons WHERE contract_id=? AND status='active' AND date>=?",
    c.id,
    date,
  ))
    financialGuard(s, r.month, c.person_id);
}
export function effectivePerson(s, p, m = today().slice(0, 7)) {
  const row = s.one(
    'SELECT profile FROM salary_terms WHERE person_id=? AND effective_month<=? ORDER BY effective_month DESC LIMIT 1',
    p.id,
    m,
  );
  return { ...p, profile: row?.profile || p.profile };
}
export function person(s, a, key) {
  let p = s.one('SELECT * FROM people WHERE id=?', key);
  if (!p) fail(404, '구성원을 찾을 수 없습니다.');
  owner(a, p.id);
  return effectivePerson(s, p);
}
export function member(s, a, key) {
  const m = s.one('SELECT * FROM members WHERE id=?', key);
  if (!m) fail(404, '회원을 찾을 수 없습니다.');
  owner(a, m.person_id);
  return m;
}
export function contract(s, a, key) {
  const c = s.one(
    'SELECT c.*,m.name member_name,p.name instructor FROM contracts c JOIN members m ON m.id=c.member_id JOIN people p ON p.id=c.person_id WHERE c.id=?',
    key,
  );
  if (!c) fail(404, 'PT 등록을 찾을 수 없습니다.');
  owner(a, c.person_id);
  return c;
}
export function lesson(s, a, key) {
  const row = s.one('SELECT * FROM lessons WHERE id=?', key);
  if (!row) fail(404, '수업을 찾을 수 없습니다.');
  owner(a, row.person_id);
  return row;
}
export function progress(s, c) {
  const used =
    s.one("SELECT count(*) n FROM lessons WHERE contract_id=? AND status='active'", c.id).n +
    c.carry_used;
  return { ...c, used, remaining: c.quantity - used };
}
export function snapshot(s, key) {
  const l = s.one(
    "SELECT l.*,c.quantity,c.carry_used,c.start_date,c.category,m.name member,p.name instructor FROM lessons l JOIN contracts c ON c.id=l.contract_id JOIN members m ON m.id=l.member_id JOIN people p ON p.id=l.person_id WHERE l.id=? AND l.status='active'",
    key,
  );
  if (!l) return null;
  const used =
    s.one(
      "SELECT count(*) n FROM lessons WHERE contract_id=? AND status='active' AND (date<? OR(date=? AND time<?) OR(date=? AND time=? AND id<=?))",
      l.contract_id,
      l.date,
      l.date,
      l.time,
      l.date,
      l.time,
      l.id,
    ).n + l.carry_used;
  return {
    lessonId: l.id,
    contractId: l.contract_id,
    memberId: l.member_id,
    personId: l.person_id,
    member: l.member,
    instructor: l.instructor,
    date: l.date,
    time: l.time,
    ordinal: used,
    registered: l.quantity,
    remaining: l.quantity - used,
    category: l.category,
  };
}
export function signatureState(s, key) {
  const sig = s.one(
      'SELECT id,fingerprint,signed_at FROM signatures WHERE lesson_id=? ORDER BY rowid DESC LIMIT 1',
      key,
    ),
    snap = snapshot(s, key);
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
export function strokesValid(strokes) {
  if (!Array.isArray(strokes) || strokes.length < 1 || strokes.length > 60)
    fail(400, '서명을 작성해주세요.');
  let n = 0,
    d = 0;
  for (const line of strokes) {
    if (!Array.isArray(line) || line.length < 2 || line.length > 2000)
      fail(400, '서명 획을 확인하세요.');
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        p.some((x) => !Number.isFinite(x) || x < 0 || x > 1)
      )
        fail(400, '서명 좌표를 확인하세요.');
      if (i) d += Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]);
      n++;
    }
  }
  if (n < 8 || n > 6000 || d < 0.12) fail(400, '점이 아닌 서명을 작성해주세요.');
}
export function addPerson(s, a, b) {
  admin(a);
  const profile = b.profile;
  if (!profiles[profile]) fail(400, '직책을 확인하세요.');
  const hire = month(b.hireMonth),
    key = id(),
    name = text(b.name, '이름');
  s.run('INSERT INTO people(id,name,profile,hire_month) VALUES(?,?,?,?)', key, name, profile, hire);
  s.run(
    'INSERT INTO salary_terms(id,person_id,effective_month,profile,base,tax_bps) VALUES(?,?,?,?,?,?)',
    id(),
    key,
    hire,
    profile,
    integer(b.base ?? profiles[profile].base, '기본급'),
    integer(b.taxBps ?? profiles[profile].tax, '원천징수율', 0, 10000),
  );
  audit(s, a, 'create', 'person', key, '', { profile, hire });
  return s.one('SELECT * FROM people WHERE id=?', key);
}
export function addMember(s, a, b) {
  const p = person(s, a, b.personId || a.person_id);
  if (!trainer(p) || (p.end_date && p.end_date < today()))
    fail(400, '현재 근무 중인 트레이너에게 회원을 배정하세요.');
  const key = id(),
    name = text(b.name, '회원명');
  const ref = b.externalRef ? text(b.externalRef, '외부 회원 번호', 80) : null;
  s.run(
    'INSERT INTO members(id,person_id,name,external_ref,created_at) VALUES(?,?,?,?,?)',
    key,
    p.id,
    name,
    ref,
    new Date().toISOString(),
  );
  s.run(
    'INSERT INTO member_assignments VALUES(?,?,?,?,?)',
    id(),
    key,
    p.id,
    '0001-01-01',
    new Date().toISOString(),
  );
  audit(s, a, 'create', 'member', key, '', { personId: p.id });
  return s.one('SELECT * FROM members WHERE id=?', key);
}
export function addContract(s, a, b) {
  if (b.vatIncluded !== undefined && typeof b.vatIncluded !== 'boolean')
    fail(400, 'VAT 포함 여부를 확인하세요.');
  const m = member(s, a, b.memberId),
    paid = day(b.paidDate),
    start = day(b.startDate || paid),
    carryDate = day(b.carryDate || start);
  if (carryDate < start) fail(400, '기진행 기준일은 시작일 이후여야 합니다.');
  financialGuard(s, paid.slice(0, 7), m.person_id, true);
  const employee = s.one('SELECT end_date FROM people WHERE id=?', m.person_id);
  if (employee.end_date && paid > employee.end_date)
    fail(400, '계약 종료 이후의 신규 결제는 새 담당자에게 등록하세요.');
  const quantity = integer(b.quantity, '등록횟수', 1, 10000),
    carry = integer(b.carryUsed || 0, '기진행횟수', 0, quantity),
    raw = integer(b.amount, '결제금액'),
    amount = b.vatIncluded ? Math.round(raw / 1.1) : raw;
  if (!['pt', 'pilates'].includes(b.category) || !['new', 'renew'].includes(b.saleType))
    fail(400, '등록 구분을 확인하세요.');
  const key = id();
  s.run(
    'INSERT INTO contracts(id,member_id,person_id,paid_date,start_date,category,sale_type,amount,quantity,carry_used,carry_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    key,
    m.id,
    m.person_id,
    paid,
    start,
    b.category,
    b.saleType,
    amount,
    quantity,
    carry,
    carryDate,
  );
  s.run(
    'INSERT INTO sales(id,person_id,member_id,contract_id,date,category,kind,amount,note) VALUES(?,?,?,?,?,?,?,?,?)',
    id(),
    m.person_id,
    m.id,
    key,
    paid,
    b.category,
    'sale',
    amount,
    b.saleType === 'new' ? '신규 PT 등록' : '기존 회원 추가 결제',
  );
  audit(s, a, 'create', 'contract', key, '', { memberId: m.id, amount, quantity, carry });
  return progress(s, contract(s, a, key));
}
export function addLesson(s, a, b) {
  const c = contract(s, a, b.contractId),
    date = day(b.date),
    time = text(b.time, '수업 시간', 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(400, '수업 시간을 확인하세요.');
  const instructor = s.one('SELECT end_date,hire_month FROM people WHERE id=?', c.person_id);
  if (date.slice(0, 7) < instructor.hire_month) fail(400, '입사 이전 수업은 기록할 수 없습니다.');
  if (instructor.end_date && date > instructor.end_date)
    fail(400, '계약 종료 이후 수업은 새 담당자에게 기록하세요.');
  if (!c.active || date < c.start_date || date < c.carry_date)
    fail(400, '등록·기진행 기준일 이후의 활성 회원권을 선택하세요.');
  if (date > today()) fail(400, '미래 수업 완료는 기록할 수 없습니다.');
  lessonGuard(s, c, date);
  if (progress(s, c).remaining <= 0) fail(409, '잔여 횟수가 없습니다. 다른 회원권을 선택하세요.');
  const key = id();
  s.run(
    'INSERT INTO lessons(id,contract_id,person_id,member_id,date,time,created_at) VALUES(?,?,?,?,?,?,?)',
    key,
    c.id,
    c.person_id,
    c.member_id,
    date,
    time,
    new Date().toISOString(),
  );
  audit(s, a, 'create', 'lesson', key, '', { contractId: c.id, date, time });
  return { ...lesson(s, a, key), confirmation: signatureState(s, key) };
}
export function changeLesson(s, a, key, b) {
  const old = lesson(s, a, key);
  version(old, b.version);
  const c = contract(s, a, old.contract_id),
    reason = text(b.reason, '수정 사유', 200);
  const date = day(b.date || old.date),
    time = b.time || old.time;
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    date > today() ||
    date < c.start_date ||
    date < c.carry_date
  )
    fail(400, '수업 날짜·시간을 확인하세요.');
  lessonGuard(s, c, [old.date, date].sort()[0]);
  if (b.void) {
    if (signatureState(s, key).state !== 'unsigned') admin(a);
    s.run("UPDATE lessons SET status='void',reason=?,version=version+1 WHERE id=?", reason, key);
  } else
    s.run(
      'UPDATE lessons SET date=?,time=?,reason=?,version=version+1 WHERE id=?',
      date,
      time,
      reason,
      key,
    );
  audit(s, a, b.void ? 'void' : 'correct', 'lesson', key, reason, {
    before: { date: old.date, time: old.time },
    after: { date, time },
  });
  return { ...lesson(s, a, key), confirmation: signatureState(s, key) };
}
export function signLesson(s, a, key, b) {
  const l = lesson(s, a, key),
    p = effectivePerson(s, person(s, a, l.person_id), l.date.slice(0, 7));
  if (!trainer(p)) fail(403, '담당 수업만 서명받을 수 있습니다.');
  if (l.status !== 'active') fail(409, '취소된 수업입니다.');
  version(l, b.version);
  const snap = snapshot(s, key);
  if (JSON.stringify(snap) !== JSON.stringify(b.snapshot))
    fail(409, '수업 내용이 변경되었습니다. 다시 확인하고 서명받으세요.');
  if (b.confirmed !== true) fail(400, '회원의 수업 확인이 필요합니다.');
  if (signatureState(s, key).state === 'signed')
    fail(409, '현재 수업 내용에 대한 서명이 이미 있습니다.');
  strokesValid(b.strokes);
  const sig = id(),
    payload = JSON.stringify(b.strokes);
  s.run(
    'INSERT INTO signatures VALUES(?,?,?,?,?,?,?,?,?)',
    sig,
    key,
    l.person_id,
    JSON.stringify(snap),
    digest(JSON.stringify(snap)),
    new Date().toISOString(),
    a.id,
    digest(payload),
    '회원이 해당 날짜·회차의 수업 진행을 확인했습니다.',
  );
  s.run('INSERT INTO signature_payloads VALUES(?,?)', sig, payload);
  audit(s, a, 'sign', 'lesson', key, '', {
    signatureId: sig,
    snapshotHash: digest(JSON.stringify(snap)),
  });
  return s.one('SELECT id,lesson_id,signed_at,payload_hash FROM signatures WHERE id=?', sig);
}
export function listMembers(s, a, url) {
  const { after, limit } = page(url),
    q = String(url.searchParams.get('q') || '').slice(0, 80);
  const clauses = ['m.active=1'],
    args = [];
  if (a.role !== 'admin') {
    clauses.push('m.person_id=?');
    args.push(a.person_id);
  } else if (url.searchParams.get('personId')) {
    clauses.push('m.person_id=?');
    args.push(url.searchParams.get('personId'));
  }
  if (q) {
    clauses.push('m.name LIKE ?');
    args.push('%' + q + '%');
  }
  if (after) {
    clauses.push('(m.name>? OR(m.name=? AND m.id>?))');
    args.push(after[0], after[0], after[1]);
  }
  const rows = s.all(
    "SELECT m.*,p.name instructor,(SELECT coalesce(sum(c.quantity-c.carry_used-(SELECT count(*) FROM lessons l WHERE l.contract_id=c.id AND l.status='active')),0) FROM contracts c WHERE c.member_id=m.id AND c.active=1) remaining FROM members m JOIN people p ON p.id=m.person_id WHERE " +
      clauses.join(' AND ') +
      ' ORDER BY m.name,m.id LIMIT ?',
    ...args,
    limit + 1,
  );
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? cursor(items.at(-1).name, items.at(-1).id) : null };
}
export function listLessons(s, a, url) {
  const [start, end] = bounds(url.searchParams.get('month')),
    { after, limit } = page(url),
    recent = url.searchParams.get('order') === 'recent',
    clauses = ['l.date>=?', 'l.date<?'],
    args = [start, end];
  if (a.role !== 'admin') {
    clauses.push('l.person_id=?');
    args.push(a.person_id);
  } else if (url.searchParams.get('personId')) {
    clauses.push('l.person_id=?');
    args.push(url.searchParams.get('personId'));
  }
  if (after) {
    if (recent) {
      const [date, time] = after[0].split('T');
      if (!time) fail(400, '최근 수업 페이지를 다시 조회하세요.');
      clauses.push('(l.date<? OR(l.date=? AND l.time<?) OR(l.date=? AND l.time=? AND l.id<?))');
      args.push(date, date, time, date, time, after[1]);
    } else {
      clauses.push('(l.date>? OR(l.date=? AND l.id>?))');
      args.push(after[0], after[0], after[1]);
    }
  }
  const rows = s.all(
    'SELECT l.*,m.name member,p.name instructor,c.quantity,c.amount FROM lessons l JOIN members m ON m.id=l.member_id JOIN people p ON p.id=l.person_id JOIN contracts c ON c.id=l.contract_id WHERE ' +
      clauses.join(' AND ') +
      (recent
        ? ' ORDER BY l.date DESC,l.time DESC,l.id DESC LIMIT ?'
        : ' ORDER BY l.date,l.id LIMIT ?'),
    ...args,
    limit + 1,
  );
  const items = rows.slice(0, limit).map((l) => ({ ...l, confirmation: signatureState(s, l.id) }));
  return {
    items,
    next:
      rows.length > limit
        ? cursor(items.at(-1).date + (recent ? 'T' + items.at(-1).time : ''), items.at(-1).id)
        : null,
  };
}
export function eligible(s, m) {
  return s.all(
    'SELECT p.* FROM people p WHERE p.hire_month<=? AND((p.end_date IS NULL OR p.end_date>=?) OR EXISTS(SELECT 1 FROM payroll_runs r WHERE r.person_id=p.id AND r.month=?)) ORDER BY p.name',
    m,
    m + '-01',
    m,
  );
}
export function payroll(s, p, m) {
  const [start, end] = bounds(m),
    terms = s.one(
      'SELECT * FROM salary_terms WHERE person_id=? AND effective_month<=? ORDER BY effective_month DESC LIMIT 1',
      p.id,
      m,
    );
  if (!terms) fail(409, '적용 가능한 급여 조건이 없습니다.');
  p = { ...p, profile: terms.profile };
  const rule = s.one(
      'SELECT * FROM rules WHERE profile=? AND effective_month<=? ORDER BY effective_month DESC LIMIT 1',
      p.profile,
      m,
    ),
    r = json(rule.body);
  const input = s.one('SELECT * FROM monthly_inputs WHERE person_id=? AND month=?', p.id, m) || {
    hours100: 0,
    extra: 0,
    deduction: 0,
    version: 0,
    note: '',
  };
  const mine = s.all(
      "SELECT x.*,c.sale_type FROM sales x LEFT JOIN contracts c ON c.id=x.contract_id WHERE x.date>=? AND x.date<? AND x.person_id=? AND x.category!='membership' ORDER BY x.id",
      start,
      end,
      p.id,
    ),
    revenue = mine.reduce((n, x) => n + x.amount, 0),
    newSales = mine
      .filter((x) => x.kind === 'sale' && x.sale_type === 'new')
      .reduce((n, x) => n + x.amount, 0),
    renewSales = mine
      .filter((x) => x.kind === 'sale' && x.sale_type === 'renew')
      .reduce((n, x) => n + x.amount, 0);
  let percent = rate(r.tiers, revenue);
  const age =
    (Number(m.slice(0, 4)) - Number(p.hire_month.slice(0, 4))) * 12 +
    Number(m.slice(5)) -
    Number(p.hire_month.slice(5));
  if (p.profile === 'mixed' && age >= 0 && age < 2) percent = Math.max(45, percent);
  const lessons = s.all(
    "SELECT l.*,c.amount,c.quantity,m.name member_name FROM lessons l JOIN contracts c ON c.id=l.contract_id JOIN members m ON m.id=l.member_id WHERE l.person_id=? AND l.date>=? AND l.date<? AND l.status='active' ORDER BY l.date,l.time,l.id",
    p.id,
    start,
    end,
  );
  const lines = lessons.map((l) => ({
    lessonId: l.id,
    contractId: l.contract_id,
    memberId: l.member_id,
    memberName: l.member_name,
    supplyAmount: l.amount,
    registered: l.quantity,
    date: l.date,
    time: l.time,
    version: l.version,
    unit: trainer(p) ? Math.round(((l.amount / l.quantity) * percent) / 100) : 0,
    signature: signatureState(s, l.id).state,
    signatureId: signatureState(s, l.id).signatureId,
  }));
  const commission = lines.reduce((n, l) => n + l.unit, 0),
    bonus =
      r.bonus && revenue >= 10000000
        ? (1 + Math.floor((revenue - 10000000) / 2000000)) * 200000
        : 0;
  let incentive = 0;
  const centerTotals = ['manager', 'fc', 'lead'].includes(p.profile)
    ? s.one(
        "SELECT coalesce(sum(CASE WHEN category='membership' THEN amount ELSE 0 END),0) membership,coalesce(sum(CASE WHEN category='pt' THEN amount ELSE 0 END),0) pt,coalesce(sum(CASE WHEN legacy_refund=0 THEN amount ELSE 0 END),0) center FROM sales WHERE date>=? AND date<?",
        start,
        end,
      )
    : { membership: 0, pt: 0, center: 0 };
  const membership = Math.max(0, centerTotals.membership),
    pt = Math.max(0, centerTotals.pt),
    center = Math.max(0, centerTotals.center);
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
    calculationVersion: 'payroll-v1',
    internal: { terms, rule: { ...rule, body: json(rule.body) }, centerTotals },
    lines,
    sales: mine.map((x) => ({ id: x.id, amount: x.amount, version: x.version })),
  };
}
export function result(s, a, personId, m) {
  const p = person(s, a, personId);
  month(m);
  if (p.hire_month > m) fail(404, '입사 이전 정산입니다.');
  if (
    p.end_date &&
    m > p.end_date.slice(0, 7) &&
    !s.one('SELECT 1 FROM payroll_runs WHERE person_id=? AND month=?', p.id, m)
  )
    fail(404, '계약 종료 이후 정산입니다.');
  const run = s.one('SELECT * FROM payroll_runs WHERE person_id=? AND month=?', p.id, m) || {
    state: 'draft',
    version: 0,
    note: '',
  };
  if (run.state === 'approved' && run.snapshot_id) {
    const frozen = s.one('SELECT body FROM payroll_versions WHERE id=?', run.snapshot_id);
    return {
      ...json(frozen.body),
      state: run.state,
      version: run.version,
      note: run.note,
      frozen: true,
      currentUnconfirmed: s
        .all(
          "SELECT id FROM lessons WHERE person_id=? AND date>=? AND date<? AND status='active'",
          p.id,
          ...bounds(m),
        )
        .filter((l) => signatureState(s, l.id).state !== 'signed').length,
      periodClosed: s.one('SELECT state FROM periods WHERE month=?', m)?.state === 'closed',
    };
  }
  const calculated = payroll(s, p, m);
  return {
    ...calculated,
    currentUnconfirmed: calculated.unconfirmed,
    state: run.state,
    version: run.version,
    note: run.note,
    frozen: false,
    periodClosed: s.one('SELECT state FROM periods WHERE month=?', m)?.state === 'closed',
  };
}
