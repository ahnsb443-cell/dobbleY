const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    ),
  uid = () => crypto.randomUUID();
const money = (n) => new Intl.NumberFormat('ko-KR').format(n || 0),
  today = () =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
  labels = { attended: '출석', absent: '결석', reserved: '예약', cancelled: '취소' };
function preferredMonth() {
  try {
    const saved = sessionStorage.getItem('double-y-month');
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(saved || '')) return saved;
  } catch {}
  return [today().slice(0, 7), '2026-11'].sort().at(-1);
}
let user = null,
  csrf = '',
  setup = false,
  setupRemote = false,
  extendedLessons = false,
  people = [],
  profiles = {},
  view = 'dashboard',
  month = preferredMonth(),
  data = {},
  sequence = 0,
  lessonsIncludeDeleted = false,
  memberState = null,
  memberReturnTimer = null,
  installPrompt = null;
const titles = {
  dashboard: '운영 현황',
  members: '담당 회원 · PT 체크',
  lessons: '수업 · 회원 서명',
  groups: '그룹레슨 · 시간급',
  payroll: '월별 급여 정산',
  source: '다짐 출석 대조',
  people: '구성원 · 계정',
  settings: '정산 기준',
  audit: '변경 이력',
  password: '내 비밀번호',
  sales: '센터 매출 · 환불',
};
const isAdmin = () => user?.role === 'admin',
  isGroupOnly = () => user?.person?.profile === 'group',
  isTrainer = () =>
    !!user?.person &&
    !['fc', 'staff', 'part', 'daily', 'group', 'representative'].includes(user.person.profile),
  allowed = (v) =>
    (v !== 'groups' || extendedLessons) &&
    (isAdmin() ||
      ['payroll', 'password'].includes(v) ||
      (isGroupOnly() && v === 'groups') ||
      (isTrainer() && ['dashboard', 'members', 'lessons', 'groups'].includes(v)));
function toast(t) {
  $('#toast').textContent = t;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 4000);
}
const iconPaths = {
  dashboard: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  members:
    '<circle cx="9" cy="8" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 4a4 4 0 0 1 0 8m2 3a6 6 0 0 1 3 6"/>',
  lessons:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5 3 3 5-5"/>',
  payroll:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18m12 4h6m-6 3h3M6 3h12"/>',
  source: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  people:
    '<rect x="3" y="4" width="18" height="17" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M6 17a3 3 0 0 1 6 0m3-8h3m-3 4h3"/>',
  settings: '<path d="M5 4v16m7-16v16m7-16v16M2 8h6m1 8h6m1-10h6"/>',
  audit:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h5"/>',
  password:
    '<rect x="4" y="10" width="16" height="12" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/>',
  sales: '<path d="M4 3v18h18M8 15l4-5 4 3 5-8"/>',
};
function icon(name) {
  return (
    '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (iconPaths[name] || iconPaths.dashboard) +
    '</svg>'
  );
}
function logo(className = '') {
  return (
    '<img class="brand-logo ' +
    className +
    '" src="/brand/logo.png" alt="더블와이짐" width="1280" height="1280">'
  );
}
function mobileNavigation() {
  const tabs = isAdmin()
    ? [
        ['dashboard', '홈'],
        ['members', '회원'],
        ['lessons', '수업'],
        ['payroll', '정산'],
      ]
    : isGroupOnly() && extendedLessons
      ? [
          ['groups', '그룹레슨'],
          ['payroll', '페이롤'],
          ['password', '비밀번호'],
        ]
      : isTrainer()
        ? [
            ['dashboard', '홈'],
            ['members', '회원'],
            ['lessons', '수업'],
            ['payroll', '페이롤'],
          ]
        : [
            ['payroll', '페이롤'],
            ['password', '비밀번호'],
          ];
  return (
    '<nav class="mobile-nav" aria-label="주요 메뉴">' +
    tabs
      .map(
        ([v, label]) =>
          '<button data-view="' +
          v +
          '" class="' +
          (view === v ? 'active' : '') +
          '" ' +
          (view === v ? 'aria-current="page"' : '') +
          '>' +
          icon(v) +
          '<span>' +
          label +
          '</span></button>',
      )
      .join('') +
    (isAdmin()
      ? '<button id="mobile-more">' + icon('settings') + '<span>전체 메뉴</span></button>'
      : '') +
    '</nav>'
  );
}
function trainerHomeContent() {
  const r = (data.items || []).find((r) => r.personId === user.personId);
  if (!r) return empty('정산할 자료가 없습니다', '선택한 월의 근무 기간을 확인하세요.');
  const recent = (data.recent?.items || []).filter((l) => l.status === 'active');
  const todays = recent.filter((l) => l.date === today());
  const shown = todays.length ? todays : recent;
  const unsigned = r.currentUnconfirmed ?? r.unconfirmed ?? 0;
  const returned = r.state === 'draft' && !!r.note;
  return (
    '<div class="trainer-home"><section class="panel trainer-summary"><h2>' +
    (r.frozen ? '확정 정산금' : '예상 정산금') +
    '</h2><div class="trainer-amount">' +
    money(r.net) +
    '<small>원</small></div><p class="trainer-muted">' +
    (r.frozen ? '관리자가 승인한 확정 금액' : '월말 확정 전 예상 금액') +
    '</p><div class="trainer-counts"><div><span>개인·듀엣</span><b>' +
    r.lessons +
    '<small>회</small></b></div><div><span>그룹수업</span><b>' +
    (r.groupLessons || 0) +
    '<small>회</small></b></div></div>' +
    '<button class="primary wide" id="quick-record">수업 기록 · 서명받기 <span>›</span></button></section>' +
    '<section class="panel trainer-checks"><h2>확인이 필요해요</h2><button data-view="lessons"><span class="check-symbol">' +
    icon('lessons') +
    '</span><span>서명 대기</span><b>' +
    unsigned +
    '건</b><span class="chevron">›</span></button><button data-view="payroll"><span class="check-symbol">ⓘ</span><span>수정 요청</span><b>' +
    (returned ? 1 : 0) +
    '건</b><span class="chevron">›</span></button></section>' +
    '<section class="panel recent-panel trainer-recent"><div class="trainer-section-head"><h2>' +
    (todays.length ? '오늘 수업' : '최근 수업') +
    '</h2><button class="text-button" data-view="lessons">전체보기 ›</button></div>' +
    (shown.length
      ? shown
          .map(
            (l) =>
              '<article class="recent-lesson"><div class="trainer-lesson-time">' +
              esc(l.time) +
              '<small>' +
              l.date.slice(5).replace('-', '.') +
              '</small></div><div class="recent-person"><b>' +
              esc(l.member) +
              '</b><span> · ' +
              (l.session_id ? '듀엣' : l.category === 'pilates' ? '필라테스' : 'PT') +
              '</span></div><button class="signature-status ' +
              (['signed', 'noshow'].includes(l.confirmation.state) ? 'signed' : 'needs-sign') +
              '" ' +
              (['signed', 'noshow'].includes(l.confirmation.state) ? 'data-history' : 'data-sign') +
              '="' +
              l.id +
              '">' +
              { signed: '서명 완료', noshow: '노쇼', unsigned: '서명 대기', stale: '재서명' }[
                l.confirmation.state
              ] +
              '</button></article>',
          )
          .join('')
      : empty('기록된 수업이 없습니다', '수업 기록 버튼으로 첫 수업을 남겨주세요.')) +
    '</section>' +
    (extendedLessons
      ? '<div class="class-shortcuts"><button class="secondary" id="quick-duet">듀엣 수업 기록</button><button class="secondary" data-view="groups">그룹수업 기록</button></div>'
      : '') +
    '</div>'
  );
}
function contractCalculationNotes(r) {
  const notes = [];
  if (r.minimumRate > 0)
    notes.push(
      esc(r.minimumRateUntil) +
        '까지 최저 수업료율 ' +
        r.minimumRate +
        '% 보장 · 매출 구간이 높으면 높은 요율 적용',
    );
  const d = r.incentiveDetails;
  if (d)
    notes.push(
      esc(d.basis) +
        ' (VAT 제외) ' +
        money(d.revenue) +
        '원 · ' +
        (d.threshold
          ? money(d.threshold) + '원까지 ' + d.rate + '%, 초과분 ' + d.excessRate + '%'
          : '달성 구간 ' + d.rate + '%를 매출 전액에 적용') +
        ' · 인센티브 ' +
        money(d.amount) +
        '원',
    );
  return notes.length
    ? '<p class="form-note contract-calculation">' + notes.join('<br>') + '</p>'
    : '';
}
function monthlyMemberReview(r) {
  const groups = new Map();
  for (const l of data.lessonReview || []) {
    if (!groups.has(l.member_id)) groups.set(l.member_id, { name: l.member, items: [] });
    groups.get(l.member_id).items.push(l);
  }
  return (
    '<section class="panel monthly-member-review" id="monthly-member-review"><h2>당월 회원별 서명 확인</h2><p class="trainer-muted">' +
    esc(month) +
    ' · ' +
    groups.size +
    '명 / 회원 확인 ' +
    (data.lessonReview || []).length +
    '건<br>듀엣은 회원별로 표시합니다.' +
    (r.frozen ? ' 서명 상태는 현재 기준이며 확정 정산금은 유지됩니다.' : '') +
    '</p>' +
    ([...groups.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .map((g) => {
        const signed = g.items.filter((l) => l.confirmation.state === 'signed').length,
          noshow = g.items.filter((l) => l.confirmation.state === 'noshow').length;
        return (
          '<details open class="monthly-member"><summary><b>' +
          esc(g.name) +
          '</b><small>서명 ' +
          signed +
          ' · 노쇼 ' +
          noshow +
          ' · 확인 필요 ' +
          (g.items.length - signed - noshow) +
          '</small></summary>' +
          g.items
            .sort(
              (a, b) =>
                a.date.localeCompare(b.date) ||
                a.time.localeCompare(b.time) ||
                a.id.localeCompare(b.id),
            )
            .map(
              (l) =>
                '<article class="monthly-member-lesson"><div><b>' +
                l.date.slice(5).replace('-', '.') +
                ' ' +
                esc(l.time) +
                '</b><small>' +
                (l.ordinal ? l.ordinal + '회차 · ' : '') +
                (l.session_id ? '듀엣' : l.category === 'pilates' ? '필라테스' : 'PT') +
                ' ' +
                l.quantity +
                '회 상품 · 시작 ' +
                esc((l.contract_start_date || '').slice(5)) +
                '</small></div><button class="text-button" data-history="' +
                l.id +
                '">' +
                {
                  signed: '서명 보기',
                  noshow: '노쇼 내역',
                  unsigned: '미서명',
                  stale: '재서명 필요',
                }[l.confirmation.state] +
                '</button></article>',
            )
            .join('') +
          '</details>'
        );
      })
      .join('') || '<p class="trainer-muted">선택한 월에 기록된 개인·듀엣 수업이 없습니다.</p>') +
    '</section>'
  );
}
async function loadMonthlyLessonReview(selectedMonth) {
  const items = new Map();
  let after = null;
  do {
    const page = await api(
      '/lessons?month=' +
        selectedMonth +
        '&limit=100' +
        (after ? '&after=' + encodeURIComponent(after) : ''),
    );
    for (const l of page.items) items.set(l.id, l);
    after = page.next;
  } while (after);
  return [...items.values()];
}
function trainerPayrollContent() {
  const r = (data.items || []).find((r) => r.personId === user.personId);
  if (!r) return empty('정산할 자료가 없습니다', '선택한 월의 근무 기간을 확인하세요.');
  const groupLines = r.groupLines || [];
  const amounts = [
    ['개인·듀엣 수업료', r.commission],
    ['그룹수업료', r.groupCommission || 0],
    ['기본급', r.base],
    ['추가 수당', r.extra],
  ];
  if (r.bonus) amounts.push(['매출 성과금', r.bonus]);
  if (r.incentive) amounts.push(['팀·센터 성과금', r.incentive]);
  if (r.tax) amounts.push(['원천징수', -r.tax]);
  if (r.deduction) amounts.push(['별도 공제', -r.deduction]);
  return (
    '<div class="trainer-payroll"><div class="trainer-state"><span class="status-chip ' +
    r.state +
    '">' +
    (r.periodClosed
      ? '마감 완료'
      : { draft: '작성 중', submitted: '제출 완료', approved: '승인 완료' }[r.state]) +
    '</span></div>' +
    (r.note ? '<p class="notice">' + esc(r.note) + '</p>' : '') +
    '<section class="panel trainer-rate"><h2>적용 수업료율</h2><div class="trainer-amount">' +
    r.rate +
    '<small>%</small></div>' +
    contractCalculationNotes(r) +
    '<p class="trainer-muted">선택한 월의 매출·급여 조건 기준 · 고정 수업료는 별도 적용</p><dl class="trainer-breakdown">' +
    amounts
      .map(([label, amount]) => '<div><dt>' + label + '</dt><dd>' + money(amount) + '원</dd></div>')
      .join('') +
    '</dl><div class="trainer-net"><b>' +
    (r.frozen ? '확정 정산금' : '예상 정산금') +
    '</b><strong>' +
    money(r.net) +
    '<small>원</small></strong></div></section>' +
    '<section class="panel trainer-groups"><div class="trainer-section-head"><h2>그룹수업 진행 내역</h2>' +
    (extendedLessons && allowed('groups')
      ? '<button class="secondary" id="new-group-lesson">＋ 추가</button>'
      : '') +
    '</div>' +
    (groupLines.length
      ? groupLines
          .map(
            (g) =>
              '<article><div><b>' +
              g.date.slice(5).replace('-', '.') +
              '</b><small>' +
              esc(g.time) +
              '</small></div><span>' +
              esc(g.name) +
              '<small>인정 ' +
              g.billable_minutes +
              '분</small></span><strong>' +
              money(g.amount) +
              '원</strong></article>',
          )
          .join('')
      : '<p class="trainer-muted trainer-empty">아직 기록된 그룹수업이 없습니다.</p>') +
    '<div class="trainer-group-total">총 ' +
    (r.groupLessons || 0) +
    '회 · ' +
    money(r.groupCommission || 0) +
    '원</div></section>' +
    (extendedLessons && isTrainer() ? monthlyMemberReview(r) : '') +
    '<button class="secondary wide" data-payroll="' +
    r.personId +
    '">개인·듀엣 상세 · 서명 확인</button>' +
    '<p class="trainer-muted trainer-footnote">서명 확인 필요 ' +
    (r.currentUnconfirmed ?? r.unconfirmed ?? 0) +
    '건 · 정산금은 원천징수·공제를 반영한 금액입니다.</p>' +
    '<div class="trainer-submit"><button class="primary wide" id="trainer-open-submit">' +
    (r.periodClosed || r.state !== 'draft' ? '제출 내역 · 명세서 확인' : '월말 확인 · 제출') +
    '</button></div></div>'
  );
}

function dashboardContent() {
  if (!isAdmin()) return trainerHomeContent();
  const rows = data.items || [],
    own = rows.find((r) => r.personId === user.personId),
    total = rows.reduce(
      (a, r) => ({
        revenue: a.revenue + r.revenue,
        lessons: a.lessons + r.lessons + (r.groupLessons || 0),
        unsigned: a.unsigned + (r.currentUnconfirmed ?? r.unconfirmed),
      }),
      { revenue: 0, lessons: 0, unsigned: 0 },
    ),
    pending = rows.filter((r) => r.state === 'draft').length,
    unresolved = data.reviewSummary?.unresolved || 0,
    closed = data.period?.state === 'closed',
    recent = (data.recent?.items || []).filter((l) => l.status === 'active');
  const kpis = isAdmin()
    ? [
        [
          data.salesSummary ? '센터 총매출' : '담당 PT·필라테스 매출',
          money(data.salesSummary?.centerNet ?? total.revenue) + '원',
          '공급가액 · 환불 반영',
        ],
        ['진행 수업', total.lessons + '회', month + ' 기준'],
        ['서명 확인 필요', total.unsigned + '건', '미서명 · 재확인 포함'],
      ]
    : [
        ['이번 달 수업', (own?.lessons || 0) + (own?.groupLessons || 0) + '회', month + ' 기준'],
        [
          '서명 확인 필요',
          (own?.currentUnconfirmed ?? own?.unconfirmed ?? 0) + '건',
          '누락된 서명도 받을 수 있어요',
        ],
      ];
  let html =
    '<section class="home-welcome"><div><span class="eyebrow">' +
    (isAdmin() ? 'MANAGER OVERVIEW' : 'MY WORKSPACE') +
    '</span><h2>' +
    (isAdmin()
      ? '한눈에 보는 이번 달 운영'
      : esc(user.name) + ' 선생님,<br>수업 기록부터 시작하세요') +
    '</h2><p>' +
    (isAdmin()
      ? '확인이 필요한 기록을 먼저 살펴보세요.'
      : '수업을 기록하고 회원님께 바로 서명받으세요.') +
    '</p></div><button class="primary hero-action" id="' +
    'quick-record' +
    '">' +
    '+ 수업 체크 · 서명받기' +
    '</button></section>' +
    '<div class="stats home-stats ' +
    (isAdmin() ? 'three' : 'two') +
    '">' +
    kpis
      .map(
        ([k, v, n]) =>
          '<article><span>' + k + '</span><h2>' + v + '</h2><small>' + n + '</small></article>',
      )
      .join('') +
    '</div>';
  if (extendedLessons && !isAdmin())
    html +=
      '<div class="class-shortcuts"><button class="secondary" id="quick-duet">듀엣 수업 기록</button><button class="secondary" data-view="groups">그룹레슨 · 시간급</button></div>';
  if (extendedLessons && isAdmin())
    html +=
      '<div class="class-shortcuts"><button class="secondary" id="dashboard-reconcile">다짐 기록 대조</button><button class="primary" id="membership-record">당월 멤버십 총매출</button><button class="secondary" data-view="sales">센터 매출 현황</button></div>';
  if (isAdmin()) {
    html +=
      '<section class="panel priority-panel"><div class="panel-head"><div><h3>먼저 확인할 항목</h3><p>각 항목을 누르면 해당 기록으로 이동합니다.</p></div></div>' +
      [
        ['lessons', '미서명 · 재확인 수업', total.unsigned + '건'],
        ['source', '다짐 대조 불일치', unresolved + '건'],
        ['payroll', '급여 제출 대기', pending + '명'],
      ]
        .map(
          ([v, label, count]) =>
            '<button class="priority-row" data-view="' +
            v +
            '"><span class="priority-icon">' +
            icon(v) +
            '</span><b>' +
            label +
            '</b><span class="priority-count">' +
            count +
            '</span><span aria-hidden="true">›</span></button>',
        )
        .join('') +
      '</section>' +
      '<section class="panel"><div class="panel-head"><div><h3>직원별 정산 현황</h3><p>' +
      (closed ? '마감된 월입니다. 확정 금액이 유지됩니다.' : '직원 제출 → 관리자 확인 → 월 마감') +
      '</p></div><button class="secondary" data-view="payroll">전체 정산 보기</button></div>' +
      table(
        ['직원', '수업', '서명 확인', '예상 / 확정 정산', '상태'],
        rows.map(
          (r) =>
            '<tr><td><b>' +
            esc(r.name) +
            '</b><small>' +
            esc(profiles[r.profile]?.name) +
            '</small></td><td>' +
            r.lessons +
            '회</td><td>' +
            (r.currentUnconfirmed ?? r.unconfirmed) +
            '건</td><td><button class="text-button amount" data-payroll="' +
            r.personId +
            '">' +
            money(r.net) +
            '원 ›</button></td><td><span class="status-chip ' +
            r.state +
            '">' +
            { draft: '작성 중', submitted: '제출 완료', approved: '승인 완료' }[r.state] +
            '</span></td></tr>',
        ),
      ) +
      (!rows.length
        ? empty('등록된 직원이 없습니다', '구성원 · 계정 메뉴에서 첫 직원을 등록하세요.')
        : '') +
      '</section>';
  } else {
    html +=
      '<section class="panel recent-panel"><div class="panel-head"><div><h3>최근 수업</h3><p>선택한 달에 기록한 최근 수업입니다.</p></div><button class="text-button" data-view="lessons">전체 보기 ›</button></div>' +
      (recent.length
        ? recent
            .map(
              (l) =>
                '<article class="recent-lesson"><div class="lesson-avatar">' +
                esc(l.member.slice(0, 1)) +
                '</div><div class="recent-person"><b>' +
                esc(l.member) +
                '</b><small>' +
                l.date.slice(5).replace('-', '.') +
                ' · ' +
                l.time +
                '</small></div>' +
                '<button class="' +
                (['signed', 'noshow'].includes(l.confirmation.state)
                  ? 'signature-status signed'
                  : 'secondary needs-sign') +
                '" ' +
                (['signed', 'noshow'].includes(l.confirmation.state)
                  ? 'data-history'
                  : 'data-sign') +
                '="' +
                l.id +
                '">' +
                (l.confirmation.state === 'noshow'
                  ? '노쇼'
                  : l.confirmation.state === 'signed'
                    ? '서명 완료'
                    : l.confirmation.state === 'stale'
                      ? '재서명 받기'
                      : '서명 받기') +
                '</button></article>',
            )
            .join('')
        : empty(
            '아직 기록한 수업이 없어요',
            '수업 기록 · 서명받기 버튼으로 첫 수업을 남겨보세요.',
          )) +
      '</section>' +
      '<section class="salary-preview"><div>' +
      icon('payroll') +
      '<span>' +
      (closed ? '이번 달 확정 정산' : '이번 달 예상 정산') +
      '</span><h2>' +
      money(own?.net || 0) +
      '<small>원</small></h2><p>' +
      (closed
        ? '관리자가 마감한 확정 금액입니다.'
        : '마감 전 예상 금액이며 월말 확인 후 확정됩니다.') +
      '</p></div><button class="text-button" ' +
      (own ? 'data-payroll="' + own.personId + '"' : 'data-view="payroll"') +
      '>명세서 보기 ›</button></section>';
  }
  return html;
}
async function quickRecordForm() {
  let searchSequence = 0;
  const trainers = people.filter(
    (p) =>
      !['fc', 'staff', 'part', 'daily', 'group', 'representative'].includes(p.profile) &&
      (!p.end_date || p.end_date >= today()),
  );
  const managers = trainers.filter((p) => p.profile === 'manager');
  const defaultTeacher =
    trainers.find((p) => p.id === user.personId)?.id ||
    (managers.length === 1 ? managers[0].id : '');
  modal(
    '수업을 진행한 회원 선택',
    (isAdmin()
      ? '<p class="form-note">수업을 진행한 선생님을 선택한 뒤 회원을 고르세요. 관리자 권한으로 바로 서명을 받을 수 있습니다.</p>' +
        select(
          '담당 선생님',
          'quickPersonId',
          option('', '선생님을 선택하세요') +
            trainers
              .map((p) =>
                option(
                  p.id,
                  p.name + ' · ' + (profiles[p.profile]?.name || p.profile),
                  p.id === defaultTeacher,
                ),
              )
              .join(''),
        )
      : '') +
      '<label class="field">회원 이름<input id="quick-member-search" type="search" placeholder="이름으로 빠르게 찾기" autocomplete="off"></label><div id="quick-member-results" class="quick-member-results" aria-live="polite"></div>',
    () => {},
    '닫기',
    () => {
      const input = $('#quick-member-search'),
        host = $('#quick-member-results');
      let timer;
      async function search() {
        if (!host.isConnected) return;
        const current = ++searchSequence;
        const selectedTeacher = isAdmin() ? $('[name=quickPersonId]').value : null;
        if (isAdmin() && !selectedTeacher) {
          host.innerHTML = '<p class="muted">담당 선생님을 먼저 선택해주세요.</p>';
          return;
        }
        host.innerHTML = '<p class="muted">회원 목록을 불러오는 중입니다.</p>';
        try {
          const r = await api(
            '/members?limit=8&q=' +
              encodeURIComponent(input.value.trim()) +
              (selectedTeacher ? '&personId=' + encodeURIComponent(selectedTeacher) : ''),
          );
          if (current !== searchSequence || !host.isConnected) return;
          host.innerHTML = r.items.length
            ? r.items
                .map(
                  (m) =>
                    '<button type="button" class="member-choice" data-quick-member="' +
                    m.id +
                    '"><span class="lesson-avatar">' +
                    esc(m.name.slice(0, 1)) +
                    '</span><span><b>' +
                    esc(m.name) +
                    '</b><small>잔여 ' +
                    m.remaining +
                    '회 · #' +
                    m.id.slice(0, 6) +
                    '</small></span><span aria-hidden="true">›</span></button>',
                )
                .join('')
            : empty('검색된 회원이 없습니다', '회원 · 결제 메뉴에서 등록 상태를 확인하세요.');
          host
            .querySelectorAll('[data-quick-member]')
            .forEach((b) => (b.onclick = () => act(() => completeForm(b.dataset.quickMember))));
        } catch (e) {
          if (host.isConnected) host.textContent = e.message;
        }
      }
      if ($('[name=quickPersonId]'))
        $('[name=quickPersonId]').onchange = () => {
          clearTimeout(timer);
          search();
        };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(timer);
          search();
        }
      };
      input.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(search, 250);
      };
      search();
      input.focus();
    },
  );
}

const ownGroupRates = (items) =>
  isAdmin() ? items : items.filter((r) => r.person_id === user.personId);
function groupContent() {
  const items = data.items || [],
    rates = ownGroupRates(data.rates?.items || []);
  return (
    '<section class="panel"><div class="panel-head"><div><h3>그룹레슨 · 시간당 수업료</h3><p>설정 단가 × 정산 인정시간으로 계산하며, 참여인원 0명은 50%를 지급합니다.</p></div><div class="actions">' +
    (isAdmin() ? '<button class="secondary" id="new-group-rate">선생님별 단가 설정</button>' : '') +
    '<button class="primary" id="new-group-lesson">그룹레슨 기록</button></div></div>' +
    table(
      ['수업일 / 시간', '선생님 / 수업', '정산 인정시간', '시간당 단가', '수업료', '관리'],
      items.map(
        (r) =>
          '<tr><td>' +
          r.date +
          '<small>' +
          r.time +
          '</small></td><td>' +
          esc(r.instructor) +
          '<small>' +
          esc(r.name) +
          (r.status === 'void' ? ' · 취소' : '') +
          '</small></td><td>' +
          r.billable_minutes +
          '분</td><td>' +
          money(r.hourly_rate) +
          '원</td><td>' +
          money(r.amount) +
          '원' +
          (r.payment_factor === 0.5 ? '<small>0명 · 하프 페이 50%</small>' : '') +
          '</td><td>' +
          (r.status === 'active'
            ? '<button class="text-button" data-group-edit="' + r.id + '">정정</button>'
            : '취소 기록') +
          '</td></tr>',
      ),
    ) +
    (!items.length
      ? empty(
          '이달 그룹레슨 기록이 없습니다',
          '관리자가 단가를 설정하면 담당 선생님이 수업을 기록할 수 있습니다.',
        )
      : '') +
    pager(data.next) +
    '</section>' +
    '<section class="panel"><div class="panel-head"><h3>설정된 그룹레슨 단가</h3></div>' +
    table(
      ['선생님 / 수업', '적용 시작일', '시간당 단가', '1회 정산 인정시간'],
      rates.map(
        (r) =>
          '<tr><td>' +
          esc(people.find((p) => p.id === r.person_id)?.name || '담당 선생님') +
          '<small>' +
          esc(r.name) +
          '</small></td><td>' +
          r.effective_date +
          '</td><td>' +
          money(r.hourly_rate) +
          '원</td><td>' +
          r.billable_minutes +
          '분</td></tr>',
      ),
    ) +
    '</section>'
  );
}
function groupRateForm() {
  modal(
    '선생님별 그룹레슨 단가',
    select('담당 선생님', 'personId', personOptions('', true)) +
      field('수업명 (예: 그룹 필라테스)', 'name') +
      field('적용 시작일', 'effectiveDate', 'date', [today(), month + '-01'].sort().at(-1)) +
      field('시간당 수업료 (원)', 'hourlyRate', 'number', 35000, 'min="1" max="1000000" step="1"') +
      field(
        '수업 1회 정산 인정시간 (분)',
        'billableMinutes',
        'number',
        60,
        'min="1" max="480" step="1"',
      ) +
      '<p class="form-note">예: 실제 수업이 50분이어도 1시간 지급 약정이면 인정시간을 60분으로 설정합니다. 새 단가는 기존 기록을 자동 변경하지 않습니다.</p>' +
      field('설정 사유', 'reason'),
    async (f, k) => {
      await api('/group-rates', {
        method: 'POST',
        key: k,
        body: {
          personId: f.get('personId'),
          name: f.get('name'),
          effectiveDate: f.get('effectiveDate'),
          hourlyRate: Number(f.get('hourlyRate')),
          billableMinutes: Number(f.get('billableMinutes')),
          reason: f.get('reason'),
        },
      });
      await load();
    },
  );
}
async function groupLessonForm() {
  const rates = ownGroupRates((await api('/group-rates')).items);
  if (!rates.length) return toast('관리자가 선생님별 그룹레슨 단가를 먼저 설정해주세요.');
  modal(
    '그룹레슨 기록',
    field('수업일', 'date', 'date', today(), 'max="' + today() + '"') +
      select(isAdmin() ? '적용 단가 / 수업' : '내 수업 선택', 'rateId', '') +
      field('시작 시간', 'time', 'time', '10:00') +
      field(
        '참여인원 (0명은 하프 페이)',
        'participants',
        'number',
        0,
        'min="0" max="500" step="1"',
      ) +
      '<p class="form-note" id="group-fee-preview"></p>',
    async (f, k) => {
      await api('/group-lessons', {
        method: 'POST',
        key: k,
        body: {
          rateId: f.get('rateId'),
          date: f.get('date'),
          time: f.get('time'),
          participants: Number(f.get('participants')),
        },
      });
      await load();
      toast('그룹레슨 수업료를 반영했습니다.');
    },
    '수업 기록',
    () => {
      function options() {
        const date = $('[name=date]').value,
          latest = new Map();
        for (const r of [...rates].sort(
          (a, b) =>
            a.effective_date.localeCompare(b.effective_date) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        )) {
          if (r.effective_date <= date) latest.set(r.person_id + ':' + r.class_key, r);
        }
        $('[name=rateId]').innerHTML = [...latest.values()]
          .map((r) =>
            option(
              r.id,
              isAdmin()
                ? (people.find((p) => p.id === r.person_id)?.name || '') +
                    ' · ' +
                    r.name +
                    ' · 시간당 ' +
                    money(r.hourly_rate) +
                    '원 / ' +
                    r.billable_minutes +
                    '분'
                : r.name + ' · ' + r.billable_minutes + '분',
            ),
          )
          .join('');
        preview();
      }
      function preview() {
        const r = rates.find((r) => r.id === $('[name=rateId]').value);
        $('#group-fee-preview').textContent = r
          ? '이 수업료 ' +
            money(
              Math.round(
                Math.round((r.hourly_rate * r.billable_minutes) / 60) *
                  (Number($('[name=participants]').value) === 0 ? 0.5 : 1),
              ),
            ) +
            (Number($('[name=participants]').value) === 0
              ? '원 · 0명 하프 페이 (50%)'
              : '원 · 정상 지급 (100%)')
          : '해당 날짜에 적용할 단가가 없습니다.';
      }
      $('[name=date]').onchange = options;
      $('[name=rateId]').onchange = preview;
      $('[name=participants]').oninput = preview;
      options();
    },
  );
}
function editGroupForm(row) {
  modal(
    '그룹레슨 기록 정정',
    field('수업일', 'date', 'date', row.date, 'max="' + today() + '"') +
      field('시작 시간', 'time', 'time', row.time) +
      field(
        '참여인원 (0명은 하프 페이)',
        'participants',
        'number',
        row.participants,
        'min="0" max="500"',
      ) +
      (isAdmin()
        ? field('시간당 수업료', 'hourlyRate', 'number', row.hourly_rate, 'min="1" max="1000000"') +
          field(
            '정산 인정시간 (분)',
            'billableMinutes',
            'number',
            row.billable_minutes,
            'min="1" max="480"',
          )
        : '') +
      select('처리', 'void', option('false', '기록 정정') + option('true', '수업 취소')) +
      field('정정 사유', 'reason'),
    async (f, k) => {
      await api('/group-lessons/' + row.id, {
        method: 'PATCH',
        key: k,
        body: {
          version: row.version,
          date: f.get('date'),
          time: f.get('time'),
          participants: Number(f.get('participants')),
          void: f.get('void') === 'true',
          reason: f.get('reason'),
          ...(isAdmin()
            ? {
                hourlyRate: Number(f.get('hourlyRate')),
                billableMinutes: Number(f.get('billableMinutes')),
              }
            : {}),
        },
      });
      await load();
    },
  );
}
async function duetForm() {
  const members = (await api('/members?limit=100')).items;
  modal(
    '듀엣 수업 기록',
    field('첫 번째 회원 이름 검색', 'firstSearch', 'search', '', 'autocomplete="off"') +
      select('첫 번째 회원', 'firstMember', '') +
      select('첫 번째 회원의 수업 기준', 'firstContract', '') +
      field('두 번째 회원 이름 검색', 'secondSearch', 'search', '', 'autocomplete="off"') +
      select('두 번째 회원', 'secondMember', '') +
      select('두 번째 회원의 수업 기준', 'secondContract', '') +
      field('수업일', 'date', 'date', today(), 'max="' + today() + '"') +
      field('시작 시간', 'time', 'time', '10:00') +
      '<p class="form-note">같은 선생님·같은 종목의 두 회원권을 선택합니다. 각 회원의 횟수는 1회씩 차감하고, 비율제 단가에는 지급률을 곱하고 고정 수업료는 그대로 지급합니다. 서명은 회원마다 받습니다.</p>',
    async (f, k) => {
      const r = await api('/duet-sessions', {
        method: 'POST',
        key: k,
        body: {
          contractIds: [f.get('firstContract'), f.get('secondContract')],
          date: f.get('date'),
          time: f.get('time'),
        },
      });
      await load();
      showDuetDetail(r.id);
    },
    '듀엣 수업 저장',
    () => {
      for (const prefix of ['first', 'second']) {
        const member = $('[name=' + prefix + 'Member]'),
          contracts = $('[name=' + prefix + 'Contract]'),
          search = $('[name=' + prefix + 'Search]');
        search.required = false;
        let sequence = 0,
          timer;
        async function memberOptions(q = '') {
          const current = ++sequence,
            rows = q ? (await api('/members?limit=100&q=' + encodeURIComponent(q))).items : members;
          if (current !== sequence || !member.isConnected) return;
          member.innerHTML =
            option('', '회원 선택') +
            rows.map((m) => option(m.id, m.name + ' · #' + m.id.slice(0, 6))).join('');
          contracts.innerHTML = '';
        }
        search.oninput = () => {
          clearTimeout(timer);
          timer = setTimeout(() => act(() => memberOptions(search.value.trim())), 250);
        };
        search.onkeydown = (e) => {
          if (e.key === 'Enter') e.preventDefault();
        };
        member.onchange = () =>
          act(async () => {
            const current = ++sequence;
            if (!member.value) {
              contracts.innerHTML = '';
              return;
            }
            const r = await api('/members/' + member.value);
            if (current !== sequence || !contracts.isConnected) return;
            contracts.innerHTML = r.contracts
              .filter((c) => c.active && c.remaining > 0)
              .map((c) =>
                option(
                  c.id,
                  { pt: 'PT', pilates: '필라테스' }[c.category] +
                    ' · ' +
                    c.start_date +
                    ' · 잔여 ' +
                    c.remaining +
                    '회 · 회당 ' +
                    money(Math.round(c.amount / c.quantity)) +
                    '원',
                ),
              )
              .join('');
          });
        memberOptions();
      }
    },
  );
}
async function showDuetDetail(key) {
  const r = await api('/duet-sessions/' + key);
  modal(
    '듀엣 수업 · 회원별 서명',
    '<p>' +
      r.date +
      ' ' +
      r.time +
      ' · ' +
      (r.status === 'active' ? '진행' : '취소') +
      '</p>' +
      r.lessons
        .map(
          (l) =>
            '<div class="member-choice"><span><b>' +
            esc(l.member) +
            '</b><small>회원별로 날짜·회차를 확인하고 서명합니다.</small></span>' +
            (l.status === 'active'
              ? '<button type="button" class="secondary" data-duet-sign="' +
                l.id +
                '">서명 확인</button>'
              : '취소') +
            '</div>',
        )
        .join('') +
      (r.status === 'active'
        ? '<button type="button" class="text-button" id="edit-duet">두 회원 기록 함께 정정</button>'
        : ''),
    () => {},
    '닫기',
    () => {
      document.querySelectorAll('[data-duet-sign]').forEach(
        (b) =>
          (b.onclick = () =>
            act(async () =>
              showMember(
                await api('/member-mode', {
                  method: 'POST',
                  body: { lessonId: b.dataset.duetSign },
                }),
              ),
            )),
      );
      if ($('#edit-duet'))
        $('#edit-duet').onclick = () =>
          modal(
            '듀엣 두 회원 함께 정정',
            field('수업일', 'date', 'date', r.date, 'max="' + today() + '"') +
              field('시작 시간', 'time', 'time', r.time) +
              select(
                '처리',
                'void',
                option('false', '날짜·시간 정정') + option('true', '두 회원 수업 취소'),
              ) +
              field('정정 사유', 'reason'),
            async (f, k) => {
              await api('/duet-sessions/' + key, {
                method: 'PATCH',
                key: k,
                body: {
                  version: r.version,
                  date: f.get('date'),
                  time: f.get('time'),
                  void: f.get('void') === 'true',
                  reason: f.get('reason'),
                },
              });
              await load();
            },
          );
    },
  );
}
async function membershipForm() {
  const current = await api('/membership-total?month=' + month);
  modal(
    '당월 멤버십 총매출',
    field('대상 월', 'month', 'month', month, 'readonly') +
      field(
        '다짐의 당월 회원권 총매출 (환불 반영 후, 원)',
        'amount',
        'number',
        current.raw_amount ?? '',
        'step="1"',
      ) +
      select(
        '금액 기준',
        'vatIncluded',
        option('true', 'VAT 포함 금액 (÷1.1)', current.vat_included !== false) +
          option('false', 'VAT 제외 공급가액', current.vat_included === false),
      ) +
      field('집계 메모', 'note', 'text', current.note || '다짐 당월 회원권 매출 집계') +
      '<p class="form-note">다짐 월 합계만 입력하면 됩니다. 이 금액은 FC팀장 멤버십 인센티브와 매니저 센터 총매출에 반영됩니다. 기존 개별 멤버십 장부와 중복 합산하지 않습니다. 수정 시 이 월 합계를 교체합니다.</p>',
    async (f, k) => {
      await api('/membership-total', {
        method: 'PUT',
        key: k,
        body: {
          month: f.get('month'),
          version: current.version,
          amount: Number(f.get('amount')),
          vatIncluded: f.get('vatIncluded') === 'true',
          note: f.get('note'),
        },
      });
      await load();
      toast('당월 멤버십 총매출을 반영했습니다.');
    },
    '월 총매출 저장',
  );
}
async function api(path, { method = 'GET', body, key } = {}) {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Idempotency-Key': key || uid() }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r;
  try {
    r = await response.json();
  } catch {
    throw Error('서버 응답을 확인할 수 없습니다.');
  }
  if (!response.ok) {
    if (r.code === 'MEMBER_MODE') {
      await showMember(await api('/member-mode'));
    }
    if (response.status === 401 && user) {
      user = null;
      memberState = null;
      $('#member-screen').hidden = true;
      $('#app').hidden = false;
      $('#modal').close();
      loginPage();
    }
    const e = new Error(r.error || '요청에 실패했습니다.');
    e.status = response.status;
    throw e;
  }
  return r;
}
async function act(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  }
}
const field = (label, name, type = 'text', value = '', attrs = '') =>
  '<label class="field">' +
  label +
  '<input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  attrs +
  ' required></label>';
const select = (label, name, options) =>
  '<label class="field">' + label + '<select name="' + name + '">' + options + '</select></label>';
const option = (value, label, selected = false) =>
  '<option value="' +
  esc(value) +
  '" ' +
  (selected ? 'selected' : '') +
  '>' +
  esc(label) +
  '</option>';
const personOptions = (selected = '', blank = false) =>
  (blank ? option('', '선택하세요') : '') +
  people
    .map((p) =>
      option(p.id, p.name + ' · ' + (profiles[p.profile]?.name || p.profile), p.id === selected),
    )
    .join('');
const empty = (t, d) => '<div class="empty"><span>▤</span><h3>' + t + '</h3><p>' + d + '</p></div>';
function table(headers, rows) {
  return (
    '<div class="table-scroll"><table><thead><tr>' +
    headers.map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.join('') +
    '</tbody></table></div>'
  );
}
function pager(next, action = 'next-page') {
  return next
    ? '<div class="panel-bottom"><button class="secondary" data-action="' +
        action +
        '" data-next="' +
        esc(next) +
        '">다음 페이지 →</button></div>'
    : '';
}
function csv(rows, name) {
  const cell = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return '"' + t.replaceAll('"', '""') + '"';
  };
  const url = URL.createObjectURL(
    new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function modal(title, body, handler, label = '저장', onReady) {
  const d = $('#modal'),
    key = uid();
  if (d.open) d.close();
  d.innerHTML =
    '<div class="modal-head"><div><span class="eyebrow">DOUBLE Y · EONJU</span><h2>' +
    esc(title) +
    '</h2></div><button id="modal-x" aria-label="닫기">×</button></div><form id="modal-form">' +
    body +
    '<p class="form-error" role="alert"></p><div class="modal-actions"><button class="secondary" type="button" id="modal-cancel">취소</button><button class="primary" type="submit">' +
    label +
    '</button></div></form>';
  d.showModal();
  $('#modal-x').onclick = $('#modal-cancel').onclick = () => d.close();
  $('#modal-form').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await handler(new FormData(e.target), key);
      if (d.open && $('#modal-form') === e.target) d.close();
    } catch (error) {
      e.target.querySelector('.form-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  onReady?.();
}
function confirmAction(title, handler) {
  modal(title, field('확인/변경 사유', 'note', 'text', '', 'maxlength="500"'), handler, '확인');
}
function loginPage() {
  document.body.classList.remove('menu-open');
  const first = setup;
  $('#app').innerHTML =
    '<div class="auth"><div class="auth-brand">' +
    logo() +
    '<span>언주역점 · 페이롤</span></div><section class="auth-card"><span class="eyebrow">YOUR PERSONAL WORKSPACE</span><h1>' +
    (first ? '관리자 계정 만들기' : '더블와이팀, 반가워요') +
    '</h1><p>' +
    (first
      ? '최초 한 번 관리자의 계정을 설정하세요.'
      : '개인 계정으로 내 수업과 급여를 확인하세요.') +
    '</p><form id="login-form">' +
    (first ? field('관리자 이름', 'name') : '') +
    field(
      '아이디',
      'username',
      'text',
      '',
      'autocomplete="username" minlength="3" maxlength="40"',
    ) +
    field(
      '비밀번호 (숫자 4자리 또는 6자 이상)',
      'password',
      'password',
      '',
      'autocomplete="' +
        (first ? 'new-password' : 'current-password') +
        '" minlength="4" pattern="([0-9]{4}|.{6,128})" maxlength="128"',
    ) +
    (first
      ? field(
          '비밀번호 확인',
          'confirm',
          'password',
          '',
          'minlength="4" pattern="([0-9]{4}|.{6,128})" maxlength="128"',
        )
      : '') +
    (first && setupRemote ? field('최초 설정 코드', 'setupToken', 'password') : '') +
    '<div class="form-error"></div><button class="primary wide" type="submit">' +
    (first ? '관리자 계정 생성' : '로그인') +
    ' →</button></form><div class="auth-note">직원 계정은 관리자가 구성원에 연결해 발급합니다. 임시 비밀번호는 첫 로그인 때 변경합니다.</div><button class="text-button" data-install hidden>이 기기에 앱 설치</button></section></div>';
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target)),
      button = e.target.querySelector('button');
    button.disabled = true;
    try {
      if (first && b.password !== b.confirm) throw Error('비밀번호 확인이 다릅니다.');
      const r = await api(first ? '/setup' : '/login', { method: 'POST', body: b });
      user = r.user;
      csrf = r.csrf;
      setup = false;
      if (user.mustChange) passwordPage(true);
      else if (user.memberMode) showMember(await api('/member-mode'));
      else await initialize();
    } catch (error) {
      e.target.querySelector('.form-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  bindInstall();
}
function passwordBody() {
  return (
    field(
      '현재/임시 비밀번호',
      'currentPassword',
      'password',
      '',
      'autocomplete="current-password"',
    ) +
    field(
      '새 비밀번호',
      'password',
      'password',
      '',
      'autocomplete="new-password" minlength="4" pattern="([0-9]{4}|.{6,128})" maxlength="128"',
    ) +
    field(
      '새 비밀번호 확인',
      'confirm',
      'password',
      '',
      'autocomplete="new-password" minlength="4" pattern="([0-9]{4}|.{6,128})" maxlength="128"',
    ) +
    '<div class="form-error"></div><button class="primary" type="submit">비밀번호 변경</button>'
  );
}
function passwordPage(forced = false) {
  if (forced)
    $('#app').innerHTML =
      '<div class="auth"><section class="auth-card"><span class="eyebrow">DOUBLE Y · PERSONAL ACCOUNT</span><h1>새 비밀번호를 설정하세요</h1><p>본인만 아는 비밀번호로 변경하면 개인 메뉴가 열립니다.</p><form id="password-form">' +
      passwordBody() +
      '</form></section></div>';
  const form = $('#password-form');
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(form));
      try {
        if (b.password !== b.confirm) throw Error('비밀번호 확인이 다릅니다.');
        const r = await api('/password', { method: 'POST', body: b });
        user = r.user;
        csrf = r.csrf;
        await initialize();
        toast('비밀번호를 변경했습니다. 다른 기기의 기존 로그인은 종료됩니다.');
      } catch (error) {
        form.querySelector('.form-error').textContent = error.message;
      }
    };
}
async function initialize() {
  window.scrollTo(0, 0);
  const r = await api('/people');
  people = r.items;
  profiles = r.profiles;
  if (!allowed(view))
    view = isGroupOnly() && extendedLessons ? 'groups' : isTrainer() ? 'dashboard' : 'payroll';
  await load();
}
async function load(extra = '') {
  const seq = ++sequence;
  try {
    let r;
    if (view === 'dashboard') {
      const [payroll, recent, reviewSummary, salesSummary] = await Promise.all([
        api('/payroll?month=' + month),
        api('/lessons?month=' + month + '&limit=5&order=recent'),
        isAdmin() ? api('/reconcile?month=' + month + '&summary=1') : Promise.resolve(null),
        isAdmin() && extendedLessons ? api('/sales/summary?month=' + month) : Promise.resolve(null),
      ]);
      r = { ...payroll, recent, reviewSummary, salesSummary };
    } else if (view === 'payroll') {
      if (extendedLessons && !isAdmin() && isTrainer()) {
        const [payroll, lessonReview] = await Promise.all([
          api('/payroll?month=' + month),
          loadMonthlyLessonReview(month),
        ]);
        r = { ...payroll, lessonReview };
      } else r = await api('/payroll?month=' + month);
    } else if (view === 'members') r = await api('/members?limit=20' + extra);
    else if (view === 'lessons')
      r = await api(
        '/lessons?month=' +
          month +
          '&limit=30' +
          (isAdmin() && lessonsIncludeDeleted ? '&includeDeleted=1' : '') +
          extra,
      );
    else if (view === 'sales')
      r = {
        ...(await api('/sales?month=' + month + extra)),
        summary: extendedLessons ? await api('/sales/summary?month=' + month) : null,
      };
    else if (view === 'groups')
      r = {
        ...(await api('/group-lessons?month=' + month + '&limit=30' + extra)),
        rates: await api('/group-rates'),
      };
    else if (view === 'people') {
      const latest = await api('/people');
      people = latest.items;
      profiles = latest.profiles;
      r = { accounts: await api('/accounts') };
    } else if (view === 'settings') r = await api('/rules');
    else if (view === 'source')
      r = {
        comparison: await api('/reconcile?month=' + month + extra),
        records: await api('/source?month=' + month + '&limit=50'),
        summary: await api('/source/summary?month=' + month + '&limit=30'),
      };
    else if (view === 'audit')
      r = await api('/audit' + (extra ? '?' + extra.replace(/^&/, '') : ''));
    else r = {};
    if (seq !== sequence) return;
    data = r;
    render();
  } catch (e) {
    toast(e.message);
  }
}
function render() {
  if (!user) return loginPage();
  const nav = Object.keys(titles).filter(allowed);
  $('#app').innerHTML =
    '<button class="nav-backdrop" id="nav-backdrop" aria-label="메뉴 닫기"></button><aside class="sidebar" aria-label="전체 메뉴"><a class="brand" href="#" data-view="dashboard">' +
    logo() +
    '<div>DOUBLE Y<small>더블와이짐 · 언주역점</small></div></a><div class="branch"><b>Y</b><div>더블와이짐 언주역점<small>공용 운영 워크스페이스</small></div></div><div class="nav-label">WORKSPACE</div><nav>' +
    nav
      .map(
        (v) =>
          '<button data-view="' +
          v +
          '" class="' +
          (v === view ? 'active' : '') +
          '"><span>' +
          icon(v) +
          '</span>' +
          titles[v] +
          '</button>',
      )
      .join('') +
    '</nav><div class="sidebar-foot"><div class="help">수업의 기록이<br><b>정확한 정산으로.</b><p>회원·결제·수업·서명을<br>한 곳에서 확인하세요.</p></div><div class="profile"><span class="avatar">' +
    esc(user.name.slice(0, 1)) +
    '</span><div>' +
    esc(user.name) +
    '<small>' +
    (user.representative
      ? '대표 · 관리자'
      : isAdmin()
        ? '관리자 · 전체 조회'
        : '직원 · 본인만 조회') +
    '</small></div></div></div></aside><main class="' +
    (!isAdmin() && (isTrainer() || isGroupOnly()) ? 'trainer-workspace ' : '') +
    'view-' +
    view +
    '"><header><button class="menu-toggle" id="menu-toggle" aria-label="전체 메뉴 열기" aria-expanded="false">' +
    (isAdmin() ? '☰' : logo()) +
    '</button><a class="mobile-brand" href="#" data-view="' +
    (allowed('dashboard') ? 'dashboard' : allowed('groups') ? 'groups' : 'payroll') +
    '">' +
    (!isAdmin() && view === 'payroll' ? '<span class="trainer-back">←</span>' : logo()) +
    '<span>DOUBLE Y GYM<small>더블와이짐 · 언주역점</small></span></a><span class="breadcrumb">워크스페이스 <i>/</i> ' +
    titles[view] +
    '</span><div><button class="text-button" data-install hidden>앱 설치</button><button class="text-button" id="refresh">새로고침</button><button class="text-button" id="logout">로그아웃</button><span class="avatar light">' +
    esc(user.name.slice(0, 1)) +
    '</span></div></header><div class="content"><div class="heading"><div><span class="eyebrow">DOUBLE Y GYM · EONJU</span><h1>' +
    (!isAdmin() && view === 'dashboard'
      ? esc(user.name) + ' 선생님 👋'
      : !isAdmin() && view === 'payroll'
        ? '내 페이롤'
        : titles[view]) +
    '<em>.</em></h1><p>' +
    (isAdmin()
      ? '매출과 수업, 확인 기록과 정산을 관리하세요.'
      : '내 회원의 결제·수업과 예상 급여를 확인하세요.') +
    '</p></div>' +
    (!isAdmin()
      ? '<label class="trainer-month"><span>' +
        Number(month.slice(0, 4)) +
        '년 ' +
        Number(month.slice(5)) +
        '월 <i>⌄</i></span>'
      : '') +
    '<input type="month" id="month" value="' +
    month +
    '" aria-label="정산 월">' +
    (!isAdmin() ? '</label>' : '') +
    '</div>' +
    content() +
    '<footer><b>DOUBLE Y <small>PAYROLL</small></b><span>기록은 안전하게 · 정산은 정확하게</span></footer></div></main>' +
    mobileNavigation();
  document.querySelectorAll('[data-view]').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        const v = b.dataset.view;
        if (!allowed(v)) return;
        document.body.classList.remove('menu-open');
        view = v;
        window.scrollTo(0, 0);
        load();
      }),
  );
  $('.sidebar').inert =
    matchMedia('(max-width:760px)').matches && !document.body.classList.contains('menu-open');
  const toggleMenu = () => {
    const open = document.body.classList.toggle('menu-open');
    $('.sidebar').inert = matchMedia('(max-width:760px)').matches && !open;
    $('#menu-toggle').setAttribute('aria-expanded', String(open));
  };
  $('#menu-toggle').onclick = toggleMenu;
  $('#nav-backdrop').onclick = toggleMenu;
  if ($('#mobile-more')) $('#mobile-more').onclick = toggleMenu;
  $('#month').onchange = (e) => {
    if (e.target.value) {
      month = e.target.value;
      try {
        sessionStorage.setItem('double-y-month', month);
      } catch {}
      load();
    }
  };
  $('#refresh').onclick = () => load();
  $('#logout').onclick = () =>
    act(async () => {
      await api('/logout', { method: 'POST' });
      user = null;
      csrf = '';
      people = [];
      memberState = null;
      loginPage();
    });
  bindPage();
  bindInstall();
  if (view === 'password') passwordPage();
}
function content() {
  if (view === 'dashboard') return dashboardContent();
  if (view === 'payroll') return payrollContent();
  if (view === 'groups') return groupContent();
  if (view === 'members') return membersContent();
  if (view === 'lessons') return lessonsContent();
  if (view === 'sales') return salesContent();
  if (view === 'people') return peopleContent();
  if (view === 'settings') return settingsContent();
  if (view === 'source') return sourceContent();
  if (view === 'audit') return auditContent();
  return (
    '<section class="panel padded narrow"><h3>내 비밀번호 변경</h3><form id="password-form">' +
    passwordBody() +
    '</form></section>'
  );
}
function payrollContent() {
  if (!isAdmin() && (isTrainer() || isGroupOnly())) return trainerPayrollContent();
  const rows = data.items || [],
    totals = rows.reduce(
      (x, r) => ({
        net: x.net + r.net,
        sales: x.sales + r.revenue,
        lessons: x.lessons + r.lessons + (r.groupLessons || 0),
        unconfirmed: x.unconfirmed + (r.currentUnconfirmed ?? r.unconfirmed),
      }),
      { net: 0, sales: 0, lessons: 0, unconfirmed: 0 },
    );
  const period = data.period || { state: 'open', version: 0 };
  return (
    '<div class="notice"><span>ⓘ</span><div><b>' +
    (period.state === 'closed' ? '마감된 정산 · 확정 금액 유지' : '월중 급여는 예상 금액입니다') +
    '</b><p>' +
    (period.state === 'closed'
      ? '수정하려면 관리자가 사유와 함께 마감을 해제해야 합니다.'
      : '서명과 다짐 대조를 확인한 뒤 제출·승인·마감하세요.') +
    '</p></div>' +
    (isAdmin()
      ? '<button class="text-button" id="period-action">' +
        (period.state === 'closed' ? '마감 해제' : '전체 월 마감') +
        ' →</button>'
      : '') +
    '</div><div class="stats">' +
    [
      ['실지급 예상 / 확정', money(totals.net) + '원'],
      ['등록·조정 매출', money(totals.sales) + '원'],
      ['진행 수업', totals.lessons + '회'],
      ['서명 확인 필요', totals.unconfirmed + '건'],
    ]
      .map(
        ([k, v]) =>
          '<article><span>' +
          k +
          '</span><h2>' +
          v +
          '</h2><small>' +
          month +
          ' 기준</small></article>',
      )
      .join('') +
    '</div><section class="panel"><div class="panel-head"><div><h3>' +
    (isAdmin() ? '구성원별 정산 현황' : '내 급여 현황') +
    '</h3><p>마감 시 계산 결과와 근거를 별도 버전으로 보관합니다.</p></div><button class="secondary" id="payroll-export">↓ CSV</button></div>' +
    '<div class="payroll-table">' +
    table(
      [
        '구성원',
        '월 매출',
        '수업 / 요율',
        '기본급',
        '수업료·성과급',
        '징수·공제',
        '실지급액',
        '상태',
        '확인',
      ],
      rows.map(
        (r) =>
          '<tr><td><div class="person"><span class="avatar">' +
          esc(r.name.slice(0, 1)) +
          '</span><div><b>' +
          esc(r.name) +
          '</b><small>' +
          esc(profiles[r.profile]?.name) +
          '</small></div></div></td><td>' +
          money(r.revenue) +
          '</td><td>' +
          r.lessons +
          '회 / ' +
          r.rate +
          '%' +
          (r.groupLessons ? '<small>그룹 ' + r.groupLessons + '회 별도</small>' : '') +
          '</td><td>' +
          money(r.base) +
          '</td><td>' +
          money(r.commission + (r.groupCommission || 0) + r.bonus + r.incentive + r.extra) +
          '</td><td>' +
          money(r.tax + r.deduction) +
          '</td><td class="amount">' +
          money(r.net) +
          '원</td><td><span class="tag">' +
          { draft: '작성 중', submitted: '제출', approved: '승인' }[r.state] +
          (r.frozen ? ' · 고정' : '') +
          (r.currentUnresolved ? ' · 새 검수 ' + r.currentUnresolved + '건' : '') +
          '</span></td><td><button class="text-button" data-payroll="' +
          r.personId +
          '">명세서 ↗</button></td></tr>',
      ),
    ) +
    '</div><div class="payroll-mobile">' +
    rows
      .map(
        (r) =>
          '<article class="payroll-card"><div><b>' +
          esc(r.name) +
          '</b><span class="status-chip ' +
          r.state +
          '">' +
          { draft: '작성 중', submitted: '제출 완료', approved: '승인 완료' }[r.state] +
          '</span></div><dl><div><dt>진행 수업 / 지급률</dt><dd>' +
          r.lessons +
          '회 / ' +
          r.rate +
          '%</dd></div><div><dt>개인 등록·조정 매출</dt><dd>' +
          money(r.revenue) +
          '원</dd></div><div><dt>서명 확인 필요</dt><dd>' +
          (r.currentUnconfirmed ?? r.unconfirmed) +
          '건</dd></div></dl><div class="payroll-card-total"><span>실지급 ' +
          (r.frozen ? '확정' : '예상') +
          '</span><b>' +
          money(r.net) +
          '원</b></div><button class="secondary wide" data-payroll="' +
          r.personId +
          '">명세서 확인 · 제출</button></article>',
      )
      .join('') +
    '</div>' +
    (!rows.length
      ? empty('정산할 구성원이 없습니다', '관리자가 구성원을 추가하고 급여 조건을 설정하세요.')
      : '') +
    '</section>'
  );
}
function membersContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>담당 회원과 PT 잔여횟수 <span class="tag">이 페이지 ' +
    (data.items || []).length +
    '명</span></h3><p>담당 회원의 상품별 잔여를 확인하고 신규 등록·추가 상품·수업 서명을 기록합니다.</p></div><div class="actions">' +
    '<button class="primary" id="new-registration">＋ 신규 회원 등록</button>' +
    (isAdmin() ? '<button class="secondary" id="bulk-import">다짐 자료 반영</button>' : '') +
    '</div></div><div class="toolbar"><input id="member-search" placeholder="회원 이름 검색" aria-label="회원 이름 검색"><button class="secondary" id="member-search-button">검색</button></div><div class="member-grid">' +
    (data.items || [])
      .map(
        (m) =>
          '<article class="member-card"><span class="tag">#' +
          m.id.slice(0, 6) +
          '</span><h3>' +
          esc(m.name) +
          '</h3><p>' +
          esc(m.instructor) +
          ' 선생님</p><div class="remaining"><span>전체 잔여</span><b>' +
          m.remaining +
          '<small>회</small></b></div><div class="actions"><button class="secondary" data-contracts="' +
          m.id +
          '">잔여 · 정산 기준</button><button class="secondary" data-renew="' +
          m.id +
          '">＋ 추가 상품</button></div><button class="primary wide" data-complete="' +
          m.id +
          '">PT 수업 체크 · 서명</button></article>',
      )
      .join('') +
    '</div>' +
    (!(data.items || []).length
      ? empty(
          '담당 회원이 없습니다',
          '신규 회원을 등록하거나 관리자에게 다짐 PT 자료 반영을 요청하세요.',
        )
      : '') +
    pager(data.next) +
    '</section>'
  );
}
function lessonsContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>수업 기록 · 서명 확인</h3><p>날짜와 회차는 구분됩니다. 미서명·재서명은 정산 승인 전 확인하세요.</p></div><div class="actions">' +
    (extendedLessons && isAdmin()
      ? '<button class="secondary" id="toggle-deleted-lessons">' +
        (lessonsIncludeDeleted ? '현재 수업만 보기' : '삭제 이력 보기') +
        '</button>'
      : '') +
    (extendedLessons
      ? '<button class="secondary" id="new-duet">듀엣 기록</button><button class="secondary" data-view="groups">그룹레슨</button>'
      : '') +
    '<button class="primary" id="go-members">회원 선택 · 수업 기록</button></div></div>' +
    table(
      ['일자 / 시간', '회원', '담당', '상태', '회원 확인', '관리'],
      (data.items || []).map(
        (l) =>
          '<tr><td>' +
          l.date +
          '<small>' +
          l.time +
          '</small></td><td><b>' +
          esc(l.member) +
          '</b>' +
          (l.session_id
            ? '<small><button class="text-button" data-duet="' +
              l.session_id +
              '">듀엣 · 함께 보기</button></small>'
            : '') +
          '</td><td>' +
          esc(l.instructor) +
          '</td><td>' +
          (l.status === 'void' ? '삭제 · 정산 제외' : '진행') +
          '</td><td>' +
          (l.status === 'void'
            ? '정산 제외'
            : '<button class="signature-status ' +
              l.confirmation.state +
              '" data-sign="' +
              l.id +
              '">' +
              {
                unsigned: '회원 서명받기',
                signed: '✓ 서명 완료',
                noshow: '노쇼',
                stale: '재서명 필요',
              }[l.confirmation.state] +
              '</button>') +
          '</td><td><button class="text-button" data-history="' +
          l.id +
          '">이력</button>' +
          (l.status === 'active'
            ? ' <button class="text-button" data-edit-lesson="' + l.id + '">정정</button>'
            : '') +
          (extendedLessons && isAdmin() && l.status === 'active'
            ? ' <button class="text-button danger-text" data-delete-lesson="' +
              l.id +
              '">삭제</button>'
            : '') +
          '</td></tr>',
      ),
    ) +
    (!(data.items || []).length
      ? empty('이달 수업이 없습니다', '회원 목록에서 진행한 수업을 기록하세요.')
      : '') +
    pager(data.next) +
    '</section>'
  );
}
function peopleContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>구성원 · 로그인 계정</h3><p>직원은 연결된 구성원의 자료만 볼 수 있습니다.</p></div><div class="actions"><button class="secondary" id="new-person">구성원 추가</button><button class="primary" id="new-account">계정 발급</button></div></div>' +
    table(
      ['이름', '직책', '입사 월', '관리'],
      people.map(
        (p) =>
          '<tr><td><b>' +
          esc(p.name) +
          '</b></td><td>' +
          esc(profiles[p.profile]?.name) +
          '</td><td>' +
          p.hire_month +
          (p.end_date ? '<small>종료 ' + p.end_date + '</small>' : '') +
          '</td><td>' +
          (p.profile === 'representative'
            ? '<span class="tag">급여 없음 · 관리자 권한</span> '
            : '<button class="text-button" data-compensation="' +
              p.id +
              '">급여 조건·월 입력</button> ') +
          '<button class="text-button" data-employment="' +
          p.id +
          '">계약 종료</button></td></tr>',
      ),
    ) +
    '<div class="panel-head"><h3>계정 목록</h3></div>' +
    table(
      ['아이디', '표시 이름', '권한', '상태', '관리'],
      (data.accounts?.items || []).map(
        (a) =>
          '<tr><td>' +
          esc(a.username) +
          '</td><td>' +
          esc(a.name) +
          '</td><td>' +
          (people.find((p) => p.id === a.personId)?.profile === 'representative'
            ? '대표 · 관리자'
            : a.role === 'admin'
              ? '관리자'
              : '직원') +
          '</td><td>' +
          (a.active ? '활성' : '중지') +
          (a.mustChange ? ' · 첫 비밀번호 변경 필요' : '') +
          '</td><td>' +
          (a.id === user.id
            ? '현재 계정'
            : '<button class="text-button" data-account="' + a.id + '">초기화·중지</button>') +
          '</td></tr>',
      ),
    ) +
    '</section>'
  );
}
function settingsContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>적용 월별 지급률</h3><p>마감된 월의 조건을 바꾸지 않습니다. 새 적용 월을 지정하세요.</p></div><button class="primary" id="edit-rule">구간표 설정</button></div>' +
    table(
      ['직책', '적용 월', '매출 구간 / 지급률', '추가 성과금'],
      (data.items || []).map(
        (r) =>
          '<tr><td>' +
          esc(profiles[r.profile]?.name) +
          '</td><td>' +
          r.effective_month +
          '</td><td class="wrap">' +
          r.body.tiers.map(([v, p]) => money(v) + '원 이상 ' + p + '%').join(' · ') +
          '</td><td>' +
          (r.body.bonus ? '1,000만원부터 20만원, 이후 200만원마다 +20만원' : '없음') +
          '</td></tr>',
      ),
    ) +
    '<div class="padded muted">고정 수업료 회원권은 지정 금액을 회당 지급합니다. 그 외 회당 수업료 = 회원권 공급가액 ÷ 등록횟수 × 수업 월 지급률 (회당 원 단위 반올림).<br>겸용 강사 입사 월과 다음 달 최저 45%. 총괄/FC/PT팀장 성과급은 계약 기준으로 별도 계산합니다. 원천징수는 합산 세율 기준 예상치이며 별도 세금 신고 기능은 아닙니다.<br>자료는 연결된 저장소에 개별 기록으로 보관합니다. 백업·복원은 운영 안내의 검증된 명령을 사용하세요.</div></section>'
  );
}
const compareLabel = {
  noshow: '노쇼 · 다짐 출석 대조 제외',
  matched: '일치 · 다짐 출석',
  'payroll-only': '페이롤만 기록',
  'payroll-absent': '수업 완료 / 다짐 결석',
  'payroll-reserved': '수업 완료 / 예약 상태',
  'payroll-cancelled': '수업 완료 / 다짐 취소',
  'source-attended': '다짐 출석만 기록',
  'source-reserved': '예약 · 수업 기록 없음',
  'source-absent': '결석 · 수업 기록 없음',
  'source-cancelled': '취소 · 수업 기록 없음',
  unlinked: '강사·회원 연결 필요',
  ambiguous: '여러 예약·회원권 확인',
};
function sourceContent() {
  const rows = data.comparison?.items || [];
  return (
    '<section class="panel"><div class="panel-head"><div><h3>다짐 목록 가져오기 · 관리자 대조</h3><p>200건씩 복사할 수 있습니다. 가져온 기록은 급여나 수업을 자동 생성하지 않습니다.</p></div><div class="actions"><button class="secondary" id="source-export">현재 집계 CSV</button><button class="primary" id="source-import">＋ 텍스트 가져오기</button></div></div><div class="notice inner"><span>ⓘ</span><div><b>출입 출석과 실제 PT 완료를 구분해주세요.</b><p>예약완료 아래 예약취소 버튼은 취소 상태로 집계하지 않습니다. 연락처와 원본 텍스트는 저장하지 않습니다.</p></div></div>' +
    table(
      ['회원', '강사', '출석', '결석', '예약', '출석일'],
      (data.summary?.items || []).map(
        (g) =>
          '<tr><td>' +
          esc(g.name) +
          '</td><td>' +
          esc(g.instructor) +
          '</td><td>' +
          g.attended +
          '</td><td>' +
          g.absent +
          '</td><td>' +
          g.reserved +
          '</td><td class="wrap">' +
          g.dates.map(esc).join(' · ') +
          '</td></tr>',
      ),
    ) +
    (data.summary?.next
      ? '<div class="panel-bottom"><button class="secondary" id="next-summary" data-after="' +
        data.summary.next +
        '">다음 회원 집계 →</button></div>'
      : '') +
    '<div class="panel-head"><h3>수업 기록 대조</h3></div>' +
    table(
      ['일자 / 시간', '회원', '다짐 대조', '서명', '검수'],
      rows.map(
        (r) =>
          '<tr><td>' +
          r.date +
          '<small>' +
          r.time +
          '</small></td><td>' +
          esc(r.member) +
          '</td><td><span class="tag ' +
          (r.kind === 'matched' ? 'green' : '') +
          '">' +
          esc(compareLabel[r.kind] || r.kind) +
          '</span></td><td>' +
          ({ signed: '완료', noshow: '노쇼', unsigned: '미서명', stale: '재서명' }[
            r.confirmation
          ] || '—') +
          '</td><td>' +
          (r.reviewed
            ? '<span class="muted">' + esc(r.reviewNote) + '</span>'
            : ['matched', 'noshow'].includes(r.kind)
              ? '확인'
              : '<button class="text-button" data-review="' +
                esc(r.key) +
                '">확인 사유 기록</button>') +
          '</td></tr>',
      ),
    ) +
    (data.comparison?.nextOffset !== null
      ? '<div class="panel-bottom"><button class="secondary" id="next-compare" data-offset="' +
        data.comparison?.nextOffset +
        '">다음 대조 항목 →</button></div>'
      : '') +
    '<div class="panel-head"><h3>저장된 원장 · 수동 연결</h3></div>' +
    table(
      ['일자 / 시간', '다짐 강사 / 회원', '상태 / 회원권', '연결'],
      (data.records?.items || []).map(
        (r) =>
          '<tr><td>' +
          r.date +
          '<small>' +
          r.time +
          '</small></td><td>' +
          esc(r.instructor) +
          '<small>' +
          esc(r.member_name) +
          '</small></td><td>' +
          labels[r.state] +
          '<small>' +
          esc(r.ticket) +
          '</small></td><td><button class="text-button" data-source-link="' +
          r.id +
          '">' +
          (r.contract_id ? '회원권 지정됨' : r.member_id ? '회원 연결됨' : '연결 필요') +
          ' ↗</button></td></tr>',
      ),
    ) +
    (data.records?.next
      ? '<div class="panel-bottom"><button class="secondary" id="next-source-records" data-after="' +
        data.records.next +
        '">다음 원장 →</button></div>'
      : '') +
    '</section>'
  );
}
function auditContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>변경 이력 · 추가 기록 방식</h3><p>급여·원본 서명·감사 이력은 일반 수정/삭제로 덮어쓸 수 없습니다.</p></div></div>' +
    table(
      ['서버 시각', '작업자', '작업', '대상', '사유'],
      (data.items || []).map(
        (r) =>
          '<tr><td>' +
          esc(r.created_at.replace('T', ' ').slice(0, 19)) +
          '</td><td>' +
          esc(r.actor || '시스템') +
          '</td><td>' +
          esc(r.action) +
          '</td><td>' +
          esc(r.entity) +
          '<small>' +
          esc(r.entity_id.slice(0, 12)) +
          '</small></td><td class="wrap">' +
          esc(r.reason) +
          '</td></tr>',
      ),
    ) +
    pager(data.next) +
    '</section>'
  );
}
async function registrationForm(memberId = null) {
  const existing = memberId ? await api('/members/' + memberId) : null;
  const trainers = people.filter(
    (p) =>
      !['fc', 'staff', 'part', 'daily', 'group', 'representative'].includes(p.profile) &&
      (!p.end_date || p.end_date >= today()),
  );
  modal(
    existing ? existing.member.name + ' · 추가 상품 등록' : '신규 PT 회원 등록',
    (existing
      ? '<p class="form-note">기존 상품과 잔여 수업은 유지하고 새 상품을 별도로 추가합니다.</p>'
      : field('회원 이름', 'name') +
        (isAdmin()
          ? select('담당 선생님', 'personId', trainers.map((p) => option(p.id, p.name)).join(''))
          : '<p class="form-note">본인 담당 회원으로 등록됩니다.</p>')) +
      select('개인 수업 구분', 'category', option('pt', 'PT') + option('pilates', '필라테스')) +
      field('결제일', 'paidDate', 'date', today()) +
      field('수업 시작일', 'startDate', 'date', today()) +
      field('등록 횟수', 'quantity', 'number', 10, 'min="1" max="10000" step="1"') +
      field('총 결제금액 (부가세 포함)', 'amount', 'number', '', 'min="1" step="1"') +
      '<p class="form-note" id="registration-preview">결제금액과 횟수를 입력하면 회당 공급단가를 표시합니다.</p>' +
      (isAdmin() && extendedLessons
        ? '<label class="field">회당 고정 수업료 (해당하는 경우만)<input name="fixedFee" type="number" min="1" max="1000000" step="1"></label>'
        : '<p class="form-note">회당 고정 수업료는 관리자가 설정합니다.</p>') +
      '<label class="consent"><input type="checkbox" name="paymentConfirmed" required> 해당 상품의 결제가 완료되었음을 확인합니다.</label><p class="form-note">개인 PT·필라테스 수업과 급여 계산용 등록입니다. ' +
      (existing ? '추가 등록 매출' : '신규 등록 매출') +
      '로 반영되며, 회원 서명이나 수업 차감은 생성하지 않습니다.</p>',
    async (f, k) => {
      await api('/registrations', {
        method: 'POST',
        key: k,
        body: {
          ...(existing
            ? { memberId }
            : { name: f.get('name'), personId: isAdmin() ? f.get('personId') : user.personId }),
          category: f.get('category'),
          paidDate: f.get('paidDate'),
          startDate: f.get('startDate'),
          quantity: Number(f.get('quantity')),
          amount: Number(f.get('amount')),
          vatIncluded: true,
          paymentConfirmed: f.get('paymentConfirmed') === 'on',
          saleType: existing ? 'renew' : 'new',
          ...(isAdmin() && f.get('fixedFee') ? { fixedFee: Number(f.get('fixedFee')) } : {}),
        },
      });
      view = 'members';
      await load();
      toast(
        existing
          ? '추가 상품을 등록했습니다. 기존 잔여 수업은 유지됩니다.'
          : '신규 회원을 등록했습니다.',
      );
    },
    '등록 저장',
    () => {
      const form = $('#modal-form');
      const update = () => {
        const amount = Number(form.elements.amount.value),
          quantity = Number(form.elements.quantity.value),
          net = Math.round(amount / 1.1);
        $('#registration-preview').textContent =
          amount > 0 && quantity > 0
            ? '공급가액 ' +
              money(net) +
              '원 · 회당 공급단가 ' +
              money(Math.round(net / quantity)) +
              '원 (VAT 제외)'
            : '결제금액과 횟수를 입력하면 회당 공급단가를 표시합니다.';
      };
      form.elements.amount.oninput = update;
      form.elements.quantity.oninput = update;
      update();
    },
  );
}
async function memberContracts(key) {
  const r = await api('/members/' + key);
  modal(
    r.member.name + ' · 잔여 · 정산 기준',
    table(
      ['수업 구분', '전체 / 진행 / 잔여', '회당 공급단가', '지급 기준', '상품별 서명지'],
      r.contracts.map(
        (c) =>
          '<tr><td>' +
          esc(c.source_product || (c.category === 'pilates' ? '필라테스' : 'PT')) +
          '<small>기준 ' +
          (c.carry_date || c.start_date) +
          '</small></td><td>' +
          c.quantity +
          ' / ' +
          c.used +
          ' / ' +
          c.remaining +
          '</td><td>' +
          (c.amount_unknown ? '원금 미제공' : money(c.amount / c.quantity) + '원') +
          '</td><td>' +
          (c.fixed_fee != null
            ? '고정 회당 ' + money(c.fixed_fee) + '원'
            : '월 매출별 지급률 적용') +
          (extendedLessons && isAdmin()
            ? '<br><button type="button" class="text-button" data-contract-fee="' +
              c.id +
              '">수업료 설정</button>'
            : '') +
          (!c.active ? '<small>수업 대상 종료</small>' : '') +
          '</td><td>' +
          (extendedLessons
            ? '<button class="secondary" type="button" data-product-records="' +
              c.id +
              '">서명 목록</button>' +
              (c.active && c.remaining > 0
                ? '<button class="text-button" type="button" data-product-check="' +
                  c.id +
                  '">수업 체크·서명</button>'
                : '')
            : '') +
          '</td></tr>',
      ),
    ) +
      '<button class="secondary" type="button" id="add-member-product">＋ 추가 상품 등록</button><p class="form-note">회원번호 #' +
      r.member.id.slice(0, 6) +
      ' · 상품별로 수업을 차감하고 급여를 계산합니다. 추가 등록은 기존 상품·잔여를 유지한 새 상품으로 저장합니다.</p>' +
      (isAdmin()
        ? '<button class="secondary" type="button" id="transfer-member">담당자 인수인계</button>'
        : ''),
    () => {},
    '닫기',
    () => {
      $('#add-member-product').onclick = () => act(() => registrationForm(key));
      document
        .querySelectorAll('[data-product-records]')
        .forEach(
          (b) => (b.onclick = () => act(() => productSignatures(key, b.dataset.productRecords))),
        );
      document
        .querySelectorAll('[data-product-check]')
        .forEach((b) => (b.onclick = () => act(() => completeForm(key, b.dataset.productCheck))));
      document.querySelectorAll('[data-close-contract]').forEach(
        (b) =>
          (b.onclick = () => {
            const c = r.contracts.find((c) => c.id === b.dataset.closeContract);
            confirmAction('회원권 종료', async (f, k) => {
              await api('/contracts/' + c.id + '/close', {
                method: 'POST',
                key: k,
                body: { version: c.version, reason: f.get('note') },
              });
              await load();
            });
          }),
      );
      document.querySelectorAll('[data-contract-fee]').forEach((button) => {
        button.onclick = () => {
          const c = r.contracts.find((c) => c.id === button.dataset.contractFee);
          modal(
            'PT 정산 수업료 설정',
            '<p class="form-note">선택한 수업 기준에 연결된 전체 수업에 적용됩니다. 제출·승인·마감된 수업이 있으면 변경할 수 없습니다.</p><label class="field">회당 고정 수업료 (비우면 지급률 적용)<input name="fixedFee" type="number" min="1" max="1000000" step="1" value="' +
              (c.fixed_fee ?? '') +
              '"></label>' +
              field('변경 사유', 'reason'),
            async (f, key) => {
              await api('/contracts/' + c.id + '/fee', {
                method: 'PATCH',
                key,
                body: {
                  version: c.version,
                  fixedFee: f.get('fixedFee') ? Number(f.get('fixedFee')) : null,
                  reason: f.get('reason'),
                },
              });
              await load();
              toast('PT 정산 수업료를 저장했습니다.');
            },
          );
        };
      });
      if ($('#transfer-member')) $('#transfer-member').onclick = () => transferForm(r.member);
    },
  );
}
async function productSignatures(memberId, contractId, offset = 0) {
  const r = await api('/contracts/' + contractId + '/lessons?offset=' + offset),
    c = r.contract;
  modal(
    r.member.name + ' · ' + c.quantity + '회 상품 서명지',
    '<p class="form-note">상품 시작 ' +
      esc(c.start_date) +
      ' · 전체 ' +
      c.quantity +
      '회 / 진행 ' +
      c.used +
      '회 / 잔여 ' +
      c.remaining +
      '회</p>' +
      (c.active && c.remaining > 0
        ? '<button class="primary" type="button" id="product-check-now">이 상품 수업 체크·서명</button>'
        : '') +
      (r.items.length
        ? table(
            ['회차', '수업일·시간', '회원 확인'],
            r.items.map(
              (l) =>
                '<tr><td>' +
                l.ordinal +
                '회차</td><td>' +
                l.date +
                '<small>' +
                l.time +
                '</small></td><td><button class="text-button" type="button" data-ledger-history="' +
                l.id +
                '">' +
                {
                  signed: '서명 완료',
                  noshow: '노쇼',
                  unsigned: '서명 대기',
                  stale: '재서명 필요',
                }[l.confirmation.state] +
                '</button></td></tr>',
            ),
          )
        : empty(
            '새 상품 서명지입니다',
            '이 상품의 수업을 체크하고 서명을 저장하면 회차별로 기록됩니다.',
          )) +
      (r.nextOffset !== null
        ? '<button class="secondary" type="button" id="product-next">다음 수업 기록 →</button>'
        : ''),
    () => {},
    '닫기',
    () => {
      if ($('#product-check-now'))
        $('#product-check-now').onclick = () => act(() => completeForm(memberId, contractId));
      if ($('#product-next'))
        $('#product-next').onclick = () =>
          act(() => productSignatures(memberId, contractId, r.nextOffset));
      document
        .querySelectorAll('[data-ledger-history]')
        .forEach((b) => (b.onclick = () => act(() => showHistory(b.dataset.ledgerHistory))));
    },
  );
}
async function completeForm(key, preferredContractId = null) {
  const r = await api('/members/' + key),
    available = r.contracts.filter((c) => c.active && c.remaining > 0);
  if (!available.length)
    return toast(
      '잔여 수업이 없습니다. 추가 상품을 등록하거나 관리자에게 잔여 자료 확인을 요청하세요.',
    );
  modal(
    r.member.name + ' · 수업 기록',
    select(
      '수업 차감 기준',
      'contractId',
      available
        .map((c) =>
          option(
            c.id,
            c.start_date + ' · ' + c.quantity + '회 등록 · 잔여 ' + c.remaining + '회',
            c.id === preferredContractId,
          ),
        )
        .join(''),
    ) +
      field('수업일', 'date', 'date', today(), 'max="' + today() + '"') +
      field(
        '수업 시작 시간',
        'time',
        'time',
        new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Seoul',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      ) +
      '<p class="form-note">' +
      (extendedLessons
        ? '서명을 저장해야 수업·잔여횟수·급여에 반영됩니다. 저장하지 않고 돌아가면 아무 변경도 남지 않습니다.'
        : '수업을 저장한 뒤 회원 화면으로 전환합니다.') +
      ' 정확한 날짜·회차를 회원에게 확인받으세요.</p>',
    async (f, key) => {
      const input = { contractId: f.get('contractId'), date: f.get('date'), time: f.get('time') };
      if (extendedLessons) {
        await showMember(await api('/member-mode', { method: 'POST', key, body: input }));
      } else {
        const row = await api('/lessons', { method: 'POST', key, body: input });
        await showMember(await api('/member-mode', { method: 'POST', body: { lessonId: row.id } }));
      }
    },
    '수업 기록 · 회원 서명',
  );
}
async function showHistory(key) {
  const r = await api('/lessons/' + key + '/signatures');
  modal(
    '회원 서명 이력',
    (r.noShow
      ? '<div class="notice inner"><div><b>노쇼로 처리된 수업입니다.</b><p>회원 서명 없이 강사가 노쇼로 기록했습니다. 다짐 출석 대조에서 별도로 구분합니다.</p><small>' +
        esc(new Date(r.noShow.recorded_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })) +
        '</small></div></div>'
      : '') +
      (r.items
        .map(
          (sig) =>
            '<article class="evidence"><b>' +
            esc(sig.snapshot.member) +
            ' · ' +
            sig.snapshot.date +
            ' ' +
            sig.snapshot.time +
            '</b><p>' +
            sig.snapshot.ordinal +
            ' / ' +
            sig.snapshot.registered +
            '회차 · 잔여 ' +
            sig.snapshot.remaining +
            '회<br>실제 서명 저장 ' +
            new Date(sig.signed_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) +
            '</p><button type="button" class="secondary" data-payload="' +
            sig.id +
            '">이 서명 원본 보기</button><div id="payload-' +
            sig.id +
            '"></div></article>',
        )
        .join('') ||
        (r.noShow
          ? ''
          : empty('서명 이력이 없습니다', '누락 서명은 나중에 해당 수업에서 받을 수 있습니다.'))),
    () => {},
    '닫기',
    () => {
      document.querySelectorAll('[data-payload]').forEach(
        (b) =>
          (b.onclick = () =>
            act(async () => {
              const sig = await api('/signatures/' + b.dataset.payload);
              const target = $('#payload-' + sig.id);
              target.innerHTML =
                '<canvas class="evidence-canvas" width="700" height="280"></canvas><small>원본 SHA-256 ' +
                esc(sig.payloadHash.slice(0, 16)) +
                '…</small>';
              drawEvidence(target.querySelector('canvas'), sig.strokes);
            })),
      );
    },
  );
}
function drawEvidence(canvas, strokes) {
  const c = canvas.getContext('2d');
  c.lineWidth = 3;
  c.lineCap = 'round';
  c.strokeStyle = '#20242a';
  for (const line of strokes) {
    c.beginPath();
    line.forEach(([x, y], i) =>
      i
        ? c.lineTo(x * canvas.width, y * canvas.height)
        : c.moveTo(x * canvas.width, y * canvas.height),
    );
    c.stroke();
  }
}
async function payrollDetail(key) {
  const r = await api('/payroll/' + key + '?month=' + month);
  const values = [
    ['기본급 / 시급합계', r.base],
    ['수업료 (' + r.lessons + '회 · ' + r.rate + '%)', r.commission],
    ['매출 성과금', r.bonus],
    ['팀·센터 성과금', r.incentive],
    [
      '그룹레슨 (' +
        (r.groupLessons || 0) +
        '회 · ' +
        ((r.groupMinutes || 0) / 60).toFixed(2) +
        '시간)',
      r.groupCommission || 0,
    ],
    ['추가 수당', r.extra],
    ['지급총액', r.gross],
    ['원천징수', -r.tax],
    ['별도 공제·환수', -r.deduction],
    ['실지급액', r.net],
  ];
  let buttons = '';
  if (!r.periodClosed) {
    if (r.state === 'draft')
      buttons =
        '<button type="button" class="primary" id="submit-payroll">확인 완료 · 제출</button>';
    if (isAdmin() && r.state === 'submitted')
      buttons += '<button type="button" class="primary" id="approve-payroll">검수 · 승인</button>';
    if (isAdmin() && r.state !== 'draft')
      buttons +=
        '<button type="button" class="secondary" id="return-payroll">반려 · 다시 작성</button>';
  }
  modal(
    r.name + ' · ' + month + ' 명세서',
    '<span class="tag">' +
      { draft: '작성 중', submitted: '직원 제출', approved: '관리자 승인 · 금액 고정' }[r.state] +
      '</span><div class="statement">' +
      values
        .map(([k, v]) => '<div><span>' + k + '</span><b>' + money(v) + '원</b></div>')
        .join('') +
      '</div>' +
      contractCalculationNotes(r) +
      '<p class="form-note">회원 서명 확인 필요 ' +
      r.unconfirmed +
      '건. 승인 시 다짐 대조·미서명 예외가 있으면 관리자가 사유를 남겨야 합니다. 이미 승인된 금액은 저장된 명세를 조회합니다.</p>' +
      table(
        ['수업일 / 회원', '회당 수업료', '서명'],
        r.lines.map(
          (l) =>
            '<tr><td>' +
            l.date +
            ' ' +
            l.time +
            '<small>' +
            esc(l.memberName || '') +
            (l.sessionId ? ' · 듀엣' : '') +
            '</small>' +
            '</td><td>' +
            money(l.unit) +
            (l.fixedFee != null ? '<small>고정 수업료 · 지급률 미적용</small>' : '') +
            '</td><td>' +
            { signed: '완료', noshow: '노쇼', unsigned: '미서명', stale: '재서명' }[l.signature] +
            '</td></tr>',
        ),
      ) +
      (r.nextOffset !== null
        ? '<p class="muted">상세 100건까지 표시했습니다. 총 ' +
          r.lessons +
          '회는 전체 월을 집계한 금액입니다.</p>'
        : '') +
      ((r.groupLines || []).length
        ? '<h3>그룹레슨 강사료</h3>' +
          table(
            ['수업일 / 수업', '시간당 단가', '정산 인정시간', '수업료'],
            r.groupLines.map(
              (g) =>
                '<tr><td>' +
                g.date +
                ' ' +
                g.time +
                '<small>' +
                esc(g.name) +
                '</small></td><td>' +
                money(g.hourly_rate) +
                '</td><td>' +
                g.billable_minutes +
                '분</td><td>' +
                money(g.amount) +
                '원</td></tr>',
            ),
          )
        : '') +
      '<div class="actions">' +
      buttons +
      '</div>',
    () => {},
    '닫기',
    () => {
      const doAction = (action) => {
        const noteBody = field(
          action === 'approve' ? '검수 / 예외 승인 사유' : '확인 / 반려 사유',
          'note',
        );
        modal(
          r.name + ' · ' + { submit: '제출', approve: '승인', return: '반려' }[action],
          noteBody,
          async (f, k) => {
            await api('/payroll/' + key, {
              method: 'POST',
              key: k,
              body: { month, action, version: r.version, note: f.get('note') },
            });
            await load();
            toast('정산 상태를 저장했습니다.');
          },
        );
      };
      if ($('#submit-payroll')) $('#submit-payroll').onclick = () => doAction('submit');
      if ($('#approve-payroll')) $('#approve-payroll').onclick = () => doAction('approve');
      if ($('#return-payroll')) $('#return-payroll').onclick = () => doAction('return');
    },
  );
}
function newPersonForm() {
  modal(
    '구성원 추가',
    field('이름', 'name') +
      select(
        '직책',
        'profile',
        Object.entries(profiles)
          .map(([k, r]) => option(k, r.name))
          .join(''),
      ) +
      field('입사 월', 'hireMonth', 'month', month) +
      field('초기 기본급 / 알바 시급·일급', 'base', 'number', 500000, 'min="0" step="1"') +
      field('원천징수율 (%)', 'tax', 'number', 3.3, 'min="0" max="100" step=".01"'),
    async (f, k) => {
      await api('/people', {
        method: 'POST',
        key: k,
        body: {
          name: f.get('name'),
          profile: f.get('profile'),
          hireMonth: f.get('hireMonth'),
          base: Number(f.get('base')),
          taxBps: Math.round(Number(f.get('tax')) * 100),
        },
      });
      await initialize();
    },
    '구성원 저장',
    () => {
      $('[name=profile]').onchange = (e) => {
        const p = profiles[e.target.value];
        $('[name=base]').value = p.base;
        $('[name=tax]').value = p.tax / 100;
        $('[name=base]').closest('label').hidden = e.target.value === 'representative';
        $('[name=tax]').closest('label').hidden = e.target.value === 'representative';
      };
    },
  );
}
async function newAccountForm() {
  const [latest, accounts] = await Promise.all([api('/people'), api('/accounts')]);
  people = latest.items;
  profiles = latest.profiles;
  data.accounts = accounts;
  const taken = new Set((data.accounts?.items || []).map((a) => a.personId));
  modal(
    '로그인 계정 발급',
    field(
      '로그인 아이디 (이메일 아님)',
      'username',
      'text',
      '',
      'minlength="3" maxlength="40" pattern="[A-Za-z0-9]+" autocomplete="username" autocapitalize="none" spellcheck="false" title="영문·숫자 3~40자, 예: trainer01"',
    ) +
      select(
        '권한',
        'role',
        option('employee', '직원 · 개인 자료만') + option('admin', '관리자 · 전체 자료'),
      ) +
      select(
        '연결할 구성원',
        'personId',
        option('', '선택하세요 (관리자는 미연결 가능)') +
          people
            .filter((p) => !taken.has(p.id))
            .map((p) => option(p.id, p.name))
            .join(''),
      ) +
      '<div id="unlinked-admin-name">' +
      field('관리자 표시 이름', 'name') +
      '</div>' +
      field(
        '임시 비밀번호',
        'password',
        'password',
        '',
        'minlength="4" pattern="([0-9]{4}|.{6,128})" maxlength="128" autocomplete="new-password"',
      ) +
      '<p class="form-note">아이디는 이메일 없이 trainer01 같은 영문·숫자 3~40자로 입력하세요. 직원은 등록된 구성원을 선택해야 합니다. 비밀번호는 숫자 4자리 또는 6자 이상입니다. 직원이 처음 접속하면 새 비밀번호를 설정해야 합니다. 임시 비밀번호는 직원에게 개별 전달하세요.</p>',
    async (f, k) => {
      await api('/accounts', { method: 'POST', key: k, body: Object.fromEntries(f) });
      await load();
    },
    '계정 발급',
    () => {
      const update = () => {
        const representative =
          people.find((p) => p.id === $('[name=personId]').value)?.profile === 'representative';
        if (representative) $('[name=role]').value = 'admin';
        $('[name=role] option[value=employee]').disabled = representative;
        $('[name=role] option[value=admin]').textContent = representative
          ? '대표 · 관리자'
          : '관리자 · 전체 자료';
        const needed = $('[name=role]').value === 'admin' && !$('[name=personId]').value;
        $('#unlinked-admin-name').hidden = !needed;
        $('[name=name]').required = needed;
        $('[name=personId]').required = $('[name=role]').value === 'employee';
      };
      $('[name=role]').onchange = update;
      $('[name=personId]').onchange = update;
      update();
    },
  );
}
function editAccount(key) {
  const a = data.accounts.items.find((a) => a.id === key);
  modal(
    a.username + ' · 계정 관리',
    select(
      '계정 상태',
      'active',
      option('true', '활성', a.active) + option('false', '사용 중지', !a.active),
    ) +
      field(
        '새 임시 비밀번호 (초기화할 때만)',
        'password',
        'password',
        '',
        'minlength="4" pattern="([0-9]{4}|.{6,128})" maxlength="128" autocomplete="new-password"',
      ) +
      field('변경 사유', 'reason') +
      '<p class="form-note">중지·초기화하면 현재 로그인도 종료합니다. 기존 비밀번호 원문은 조회하지 않습니다.</p>',
    async (f, k) => {
      const body = {
        version: a.version,
        active: f.get('active') === 'true',
        reason: f.get('reason'),
      };
      if (f.get('password')) body.password = f.get('password');
      await api('/accounts/' + key, { method: 'PATCH', key: k, body });
      await load();
    },
    '저장',
    () => {
      $('[name=password]').required = false;
    },
  );
}
async function compensationForm(key) {
  const p = people.find((p) => p.id === key),
    r = await api('/people/' + key + '/compensation?month=' + month);
  modal(
    p.name + ' · ' + month + ' 월 입력',
    (r.terms.profile === 'daily'
      ? field(
          '월 근무일수 (일급)',
          'hours',
          'number',
          r.inputs.hours100 / 100,
          'min="0" max="31" step=".5"',
        )
      : r.terms.profile === 'part' && extendedLessons
        ? field(
            '월 근무시간 · 시간',
            'workHours',
            'number',
            Math.floor((r.inputs.work_minutes ?? Math.round((r.inputs.hours100 / 100) * 60)) / 60),
            'min="0" max="744" step="1"',
          ) +
          field(
            '추가 근무시간 · 분',
            'workMinutes',
            'number',
            (r.inputs.work_minutes ?? Math.round((r.inputs.hours100 / 100) * 60)) % 60,
            'min="0" max="59" step="1"',
          )
        : field(
            '월 근무시간 (시급 알바)',
            'hours',
            'number',
            r.inputs.hours100 / 100,
            'min="0" max="744" step=".25"',
          )) +
      '<p class="form-note">' +
      (r.terms.profile === 'daily'
        ? '일급 × 근무일수로 정산합니다.'
        : '시급 알바는 시간과 분을 나누어 입력합니다. 예: 2시간 30분 → 시급 × 2.5시간.') +
      '</p>' +
      field('추가 수당', 'extra', 'number', r.inputs.extra, 'min="0" step="1"') +
      field(
        '별도 공제 / 이전 지급분 환수',
        'deduction',
        'number',
        r.inputs.deduction,
        'min="0" step="1"',
      ) +
      field('입력 사유', 'note', 'text', r.inputs.note) +
      '<button type="button" class="text-button" id="edit-base">월 기본급·시급·일급 / 세율 변경 →</button>',
    async (f, k) => {
      await api('/people/' + key + '/inputs', {
        method: 'PUT',
        key: k,
        body: {
          month,
          version: r.inputs.version,
          hours100:
            r.terms.profile === 'part' && extendedLessons
              ? Math.round(
                  ((Number(f.get('workHours')) * 60 + Number(f.get('workMinutes'))) / 60) * 100,
                )
              : Math.round(Number(f.get('hours')) * 100),
          ...(r.terms.profile === 'part' && extendedLessons
            ? { workMinutes: Number(f.get('workHours')) * 60 + Number(f.get('workMinutes')) }
            : {}),
          extra: Number(f.get('extra')),
          deduction: Number(f.get('deduction')),
          note: f.get('note'),
        },
      });
      await load();
    },
    '월 입력 저장',
    () => {
      $('#edit-base').onclick = () =>
        modal(
          p.name + ' · 급여 조건 변경',
          field('적용 시작 월', 'effectiveMonth', 'month', month) +
            select(
              '적용 직책',
              'profile',
              Object.entries(profiles)
                .map(([key, rule]) => option(key, rule.name, r.terms.profile === key))
                .join(''),
            ) +
            field(
              '월 기본급 / 알바 시급·일급',
              'base',
              'number',
              r.terms.base,
              'min="0" step="1"',
            ) +
            field(
              '원천징수율 (%)',
              'tax',
              'number',
              r.terms.tax_bps / 100,
              'min="0" max="100" step=".01"',
            ) +
            (extendedLessons
              ? '<label class="field">최저 보장 수업료율 (%)<input name="minimumRate" type="number" min="0" max="100" step="1" value="' +
                (r.terms.minimum_rate_until >= month ? r.terms.minimum_rate || 0 : 0) +
                '"></label><label class="field">보장 종료 월 (해당 월까지)<input name="minimumRateUntil" type="month" value="' +
                esc(r.terms.minimum_rate_until >= month ? r.terms.minimum_rate_until : '') +
                '"></label><p class="form-note">0%는 별도 보장 없음. 고정 수업료 계약은 지정 금액을 유지합니다.</p>'
              : '') +
            field('변경 사유', 'reason') +
            '<p class="form-note">기본급·세율은 적용 월부터 이후 월에 사용합니다. 근무시간·공제는 월별 입력입니다. 마감된 월에 소급 변경할 수 없습니다.</p>',
          async (f, k) => {
            const m = f.get('effectiveMonth'),
              current = m === month ? r : await api('/people/' + key + '/compensation?month=' + m);
            await api('/people/' + key + '/terms', {
              method: 'PUT',
              key: k,
              body: {
                month: m,
                version: current.exactTerms?.version || 0,
                ...(extendedLessons
                  ? {
                      minimumRate: Number(f.get('minimumRate')),
                      minimumRateUntil: f.get('minimumRateUntil'),
                    }
                  : {}),
                profile: f.get('profile'),
                base: Number(f.get('base')),
                taxBps: Math.round(Number(f.get('tax')) * 100),
                reason: f.get('reason'),
              },
            });
            await load();
          },
        );
    },
  );
}
function ruleForm() {
  modal(
    '적용 월별 지급률 설정',
    select(
      '직책',
      'profile',
      Object.entries(profiles)
        .map(([k, r]) => option(k, r.name))
        .join(''),
    ) +
      field('적용 시작 월', 'effectiveMonth', 'month', month) +
      field('매출 하한:지급률 (쉼표 구분)', 'tiers', 'text', '0:35,4000000:40,5000000:50') +
      select(
        '일반 매출 성과금',
        'bonus',
        option('false', '추가 성과금 없음') +
          option('true', '1,000만원부터 20만원, 이후 200만원마다 +20만원'),
      ) +
      field('변경 사유', 'reason'),
    async (f, k) => {
      const tiers = f
          .get('tiers')
          .split(',')
          .map((pair) => pair.split(':').map(Number)),
        profile = f.get('profile'),
        m = f.get('effectiveMonth'),
        existing = data.items.find((r) => r.profile === profile && r.effective_month === m);
      await api('/rules', {
        method: 'PUT',
        key: k,
        body: {
          profile,
          month: m,
          version: existing?.version || 0,
          tiers,
          bonus: f.get('bonus') === 'true',
          reason: f.get('reason'),
        },
      });
      await load();
    },
    '조건 저장',
    () => {
      $('[name=profile]').onchange = (e) => {
        const r = profiles[e.target.value];
        $('[name=tiers]').value = r.tiers.map((t) => t.join(':')).join(',');
        $('[name=bonus]').value = String(r.bonus);
      };
    },
  );
}
async function bulkImport() {
  const { header, fixedFeeHeader } = await api('/import/members');
  modal(
    '기존 회원 일괄 등록',
    (extendedLessons
      ? select(
          '가져올 회원권 종류',
          'category',
          option('pt', 'PT') + option('pilates', '개인·듀엣 필라테스'),
        )
      : '') +
      '<p class="form-note">엑셀에서 아래 열 순서로 복사하거나 UTF-8 CSV를 붙여넣으세요. 회원번호와 등록번호는 중복 방지를 위한 고유값입니다. 공급가액 기준이며 기존 회원권은 실제 과거 결제일을 입력합니다. 11월 1일 이관 시 등록횟수는 원래 총횟수, 기진행횟수는 10월까지 사용한 횟수, 기준일은 2026-11-01로 입력합니다.</p><pre class="template">' +
      esc(fixedFeeHeader || header) +
      '</pre><p class="form-note">고정수업료 열은 선택입니다. 20000 입력 시 지급률과 무관하게 회당 20,000원을 지급하며, 빈칸은 기존 비율제입니다. 기존 10열 형식도 사용할 수 있습니다.</p><label class="field">표 데이터<textarea name="text" rows="9" required placeholder="' +
      esc(header) +
      '"></textarea></label>',
    async (f) => {
      const original = f.get('text'),
        category = f.get('category') || 'pt',
        preview = await api('/import/members/preview', {
          method: 'POST',
          body: { text: original, category },
        });
      modal(
        '일괄 등록 미리보기',
        '<p>정상 ' +
          preview.rows.length +
          '건 · 중복 ' +
          preview.rows.filter((r) => r.duplicate).length +
          '건</p>' +
          (preview.errors.length
            ? '<p class="form-error">' + preview.errors.map(esc).join('<br>') + '</p>'
            : '') +
          table(
            ['회원번호 / 이름', '담당', '등록번호', '공급가액 / 수업료', '등록/기진행', '처리'],
            preview.rows.map(
              (r) =>
                '<tr><td>' +
                esc(r.ref) +
                '<small>' +
                esc(r.name) +
                '</small></td><td>' +
                esc(r.personName) +
                '</td><td>' +
                esc(r.code) +
                '</td><td>' +
                money(r.amount) +
                '<small>' +
                (r.fixedFee != null ? '고정 회당 ' + money(r.fixedFee) + '원' : '월 지급률 적용') +
                '</small>' +
                '</td><td>' +
                r.quantity +
                ' / ' +
                r.carryUsed +
                '</td><td>' +
                (r.duplicate ? '중복 제외' : '추가') +
                '</td></tr>',
            ),
          ),
        async (_, key) => {
          if (preview.errors.length) throw Error('오류를 수정하고 다시 분석하세요.');
          const r = await api('/import/members', {
            method: 'POST',
            key,
            body: { text: original, category },
          });
          await load();
          toast('회원 ' + r.members + '명 · 회원권 ' + r.contracts + '건을 저장했습니다.');
        },
        '확인 후 가져오기',
      );
    },
    '분석 · 미리보기',
  );
}
function sourceImport() {
  modal(
    '다짐 예약 목록 붙여넣기',
    select('강사 연결 (동일 강사 파일에만 지정)', 'personId', personOptions('', true)) +
      '<label class="field">예약 목록<textarea name="text" rows="10" required></textarea></label><p class="form-note">기록 200건씩 여러 번 추가할 수 있습니다. 같은 예약은 중복 제외하며 기존 상태가 달라지면 다음 화면에서 직접 선택해야 합니다.</p>',
    async (f) => {
      const original = f.get('text'),
        category = f.get('category') || 'pt',
        personId = f.get('personId') || null,
        r = await api('/source/preview', { method: 'POST', body: { text: original, category } });
      modal(
        '다짐 분석 결과',
        '<p>날짜 블록 ' +
          r.blocks +
          ' · 유효 ' +
          r.rows.length +
          ' · 출석 ' +
          r.rows.filter((x) => x.state === 'attended').length +
          ' · 결석 ' +
          r.rows.filter((x) => x.state === 'absent').length +
          ' · 예약 ' +
          r.rows.filter((x) => x.state === 'reserved').length +
          '</p>' +
          (r.errors.length
            ? '<p class="form-error">' + r.errors.map(esc).join('<br>') + '</p>'
            : '') +
          table(
            ['날짜 / 시간', '회원', '상태', '처리'],
            r.rows.map(
              (x) =>
                '<tr><td>' +
                x.date +
                ' ' +
                x.time +
                '</td><td>' +
                esc(x.member) +
                '</td><td>' +
                labels[x.state] +
                '</td><td>' +
                (x.kind === 'changed'
                  ? '<label><input type="checkbox" name="updates" value="' +
                    x.slot +
                    '"> 상태 변경 적용</label>'
                  : x.kind === 'duplicate'
                    ? '중복 제외'
                    : '새 기록') +
                '</td></tr>',
            ),
          ),
        async (form, key) => {
          if (r.errors.length) throw Error('해석 오류를 수정한 뒤 가져오세요.');
          const saved = await api('/source/import', {
            method: 'POST',
            key,
            body: { text: original, personId, updates: form.getAll('updates') },
          });
          await load();
          toast(saved.count + '건 저장 · 급여는 변경하지 않았습니다.');
        },
        '선택한 변경 · 새 기록 저장',
      );
    },
    '분석',
  );
}

async function linkSource(key) {
  const r = data.records.items.find((r) => r.id === key);
  modal(
    '다짐 강사·회원·회원권 연결',
    select('앱 강사', 'personId', personOptions(r.person_id, true)) +
      field('회원 이름 검색', 'memberQuery', 'text', r.member_name) +
      '<button type="button" class="secondary" id="link-search">회원 찾기</button>' +
      select('정확한 앱 회원', 'memberId', option('', '선택하세요')) +
      '<button type="button" class="text-button" id="link-more" hidden>회원 더 보기</button>' +
      select('특정 회원권 (여러 등록이 있으면 지정)', 'contractId', option('', '회원 기준 대조')) +
      field('연결 사유', 'reason') +
      '<p class="form-note">동명이인은 이름 뒤의 고유 번호와 담당을 확인하세요. 여러 회원권·예약이 있으면 정확한 등록을 지정합니다.</p>',
    async (f, k) => {
      await api('/source/' + key, {
        method: 'PATCH',
        key: k,
        body: {
          version: r.version,
          personId: f.get('personId'),
          memberId: f.get('memberId') || null,
          contractId: f.get('contractId') || null,
          reason: f.get('reason'),
        },
      });
      await load();
    },
    '연결 저장',
    () => {
      const form = $('#modal-form'),
        memberSelect = form.querySelector('[name=memberId]'),
        contractSelect = form.querySelector('[name=contractId]');
      form.querySelector('[name=memberQuery]').required = false;
      let next = null;
      const contracts = async (selected) => {
        contractSelect.innerHTML = option('', '회원 기준 대조');
        if (!memberSelect.value) return;
        const found = await api('/members/' + memberSelect.value);
        if (!form.isConnected) return;
        contractSelect.innerHTML =
          option('', '회원 기준 대조') +
          found.contracts
            .filter((c) => c.start_date <= r.date)
            .map((c) =>
              option(
                c.id,
                c.start_date + ' · ' + c.quantity + '회 · 잔여 ' + c.remaining + '회',
                c.id === selected,
              ),
            )
            .join('');
      };
      const members = async (more = false, selected = null) => {
        const pid = form.querySelector('[name=personId]').value;
        if (!pid) {
          memberSelect.innerHTML = option('', '강사를 먼저 선택하세요');
          return;
        }
        const query = form.querySelector('[name=memberQuery]').value;
        const found = await api(
          '/members?personId=' +
            pid +
            '&q=' +
            encodeURIComponent(query) +
            (more && next ? '&after=' + encodeURIComponent(next) : ''),
        );
        if (!form.isConnected) return;
        if (!more) memberSelect.innerHTML = option('', '선택하세요');
        memberSelect.insertAdjacentHTML(
          'beforeend',
          found.items
            .map((m) => option(m.id, m.name + ' · #' + m.id.slice(0, 6), m.id === selected))
            .join(''),
        );
        if (selected && !found.items.some((m) => m.id === selected)) {
          const detail = await api('/members/' + selected);
          memberSelect.insertAdjacentHTML(
            'beforeend',
            option(selected, detail.member.name + ' · #' + selected.slice(0, 6), true),
          );
        }
        next = found.next;
        form.querySelector('#link-more').hidden = !next;
        await contracts(r.contract_id);
      };
      form.querySelector('[name=personId]').onchange = () => act(() => members());
      memberSelect.onchange = () => act(() => contracts());
      form.querySelector('#link-search').onclick = () => act(() => members());
      form.querySelector('#link-more').onclick = () => act(() => members(true));
      act(() => members(false, r.member_id));
    },
  );
}

function bindPage() {
  const on = (s, fn) => {
    if ($(s)) $(s).onclick = () => act(fn);
  };
  document
    .querySelectorAll('[data-payroll]')
    .forEach((b) => (b.onclick = () => act(() => payrollDetail(b.dataset.payroll))));
  on('#new-registration', () => registrationForm());
  document
    .querySelectorAll('[data-renew]')
    .forEach((b) => (b.onclick = () => act(() => registrationForm(b.dataset.renew))));
  on('#payroll-export', async () =>
    csv(
      [
        [
          '월',
          '직원',
          '매출',
          '지급률',
          '진행수업',
          '기본급',
          '수업료',
          '매출성과금',
          '팀/센터성과금',
          '그룹수업수',
          '그룹인정분',
          '그룹강사료',
          '추가수당',
          '지급총액',
          '원천징수',
          '별도공제',
          '실지급액',
          '상태',
        ],
        ...data.items.map((r) => [
          month,
          r.name,
          r.revenue,
          r.rate,
          r.lessons,
          r.base,
          r.commission,
          r.bonus,
          r.incentive,
          r.groupLessons || 0,
          r.groupMinutes || 0,
          r.groupCommission || 0,
          r.extra,
          r.gross,
          r.tax,
          r.deduction,
          r.net,
          r.state,
        ]),
      ],
      '더블와이-정산-' + month + '.csv',
    ),
  );
  on('#period-action', async () => {
    const p = data.period;
    confirmAction(
      month + ' · ' + (p.state === 'closed' ? '마감 해제' : '전체 마감'),
      async (f, k) => {
        await api('/periods/' + month, {
          method: 'POST',
          key: k,
          body: {
            version: p.version,
            action: p.state === 'closed' ? 'reopen' : 'close',
            note: f.get('note'),
          },
        });
        await load();
      },
    );
  });
  on('#trainer-open-submit', () => {
    const r = (data.items || []).find((r) => r.personId === user.personId);
    if (!r || r.state !== 'draft' || r.periodClosed) return payrollDetail(user.personId);
    confirmAction('월말 확인 · 제출', async (f, key) => {
      await api('/payroll/' + user.personId, {
        method: 'POST',
        key,
        body: { month, action: 'submit', version: r.version, note: f.get('note') },
      });
      await load();
      toast('월말 정산을 제출했습니다.');
    });
  });
  on('#quick-record', quickRecordForm);
  on('#quick-duet', duetForm);
  on('#new-duet', duetForm);
  on('#new-group-rate', groupRateForm);
  on('#new-group-lesson', groupLessonForm);
  on('#membership-record', membershipForm);
  document
    .querySelectorAll('[data-group-edit]')
    .forEach(
      (b) =>
        (b.onclick = () => editGroupForm(data.items.find((r) => r.id === b.dataset.groupEdit))),
    );
  document
    .querySelectorAll('[data-duet]')
    .forEach((b) => (b.onclick = () => act(() => showDuetDetail(b.dataset.duet))));

  on('#dashboard-reconcile', async () => {
    view = 'source';
    await load();
  });
  on('#bulk-import', bulkImport);
  on('#member-search-button', async () =>
    load('&q=' + encodeURIComponent($('#member-search').value)),
  );
  document
    .querySelectorAll('[data-contracts]')
    .forEach((b) => (b.onclick = () => act(() => memberContracts(b.dataset.contracts))));
  document
    .querySelectorAll('[data-complete]')
    .forEach((b) => (b.onclick = () => act(() => completeForm(b.dataset.complete))));
  on('#toggle-deleted-lessons', async () => {
    lessonsIncludeDeleted = !lessonsIncludeDeleted;
    await load();
  });
  on('#go-members', async () => {
    view = 'members';
    await load();
  });
  document
    .querySelectorAll('[data-sign]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          act(async () =>
            showMember(
              await api('/member-mode', { method: 'POST', body: { lessonId: b.dataset.sign } }),
            ),
          )),
    );
  document
    .querySelectorAll('[data-history]')
    .forEach((b) => (b.onclick = () => act(() => showHistory(b.dataset.history))));
  document.querySelectorAll('[data-delete-lesson]').forEach((button) => {
    button.onclick = () => {
      const l = data.items.find((l) => l.id === button.dataset.deleteLesson);
      modal(
        '수업 삭제 · 잔여 복구',
        '<p><b>' +
          esc(l.member) +
          '</b> · ' +
          l.date +
          ' ' +
          esc(l.time) +
          '</p>' +
          '<p class="form-note">' +
          (l.session_id
            ? '듀엣은 두 회원의 수업을 함께 삭제하고 각 회원의 잔여 1회를 복구합니다.'
            : '이 수업을 정산에서 제외하고 잔여 1회를 복구합니다.') +
          ' 서명 원본·삭제 이력은 보존됩니다. 뒤 회차 서명은 재확인이 필요할 수 있습니다. 제출·승인된 정산은 먼저 반려하고, 마감된 월은 마감을 해제해야 합니다.</p>' +
          field('삭제 사유', 'reason', 'text', '', 'maxlength="200"'),
        async (f, key) => {
          await api('/lessons/' + l.id, {
            method: 'DELETE',
            key,
            body: { version: l.version, reason: f.get('reason') },
          });
          await load();
          toast('수업을 정산에서 제외하고 잔여횟수를 복구했습니다.');
        },
        '삭제 · 잔여 복구',
      );
    };
  });
  document.querySelectorAll('[data-edit-lesson]').forEach(
    (b) =>
      (b.onclick = () => {
        const l = data.items.find((l) => l.id === b.dataset.editLesson);
        if (l.session_id) return act(() => showDuetDetail(l.session_id));
        modal(
          '수업 정정 · 사유 보관',
          field('수업일', 'date', 'date', l.date, 'max="' + today() + '"') +
            field('시작 시간', 'time', 'time', l.time) +
            select(
              '처리',
              'void',
              option('false', '날짜/시간 정정') +
                (isAdmin() || l.confirmation.state === 'unsigned'
                  ? option('true', '기록 취소 (원본·이력 보관)')
                  : ''),
            ) +
            field('정정 사유', 'reason'),
          async (f, k) => {
            await api('/lessons/' + l.id, {
              method: 'PATCH',
              key: k,
              body: {
                version: l.version,
                date: f.get('date'),
                time: f.get('time'),
                void: f.get('void') === 'true',
                reason: f.get('reason'),
              },
            });
            await load();
          },
        );
      }),
  );
  on('#new-sale', async () => saleForm());
  on('#new-person', async () => newPersonForm());
  on('#new-account', async () => newAccountForm());
  document
    .querySelectorAll('[data-account]')
    .forEach((b) => (b.onclick = () => editAccount(b.dataset.account)));
  document
    .querySelectorAll('[data-employment]')
    .forEach(
      (b) => (b.onclick = () => employmentForm(people.find((p) => p.id === b.dataset.employment))),
    );
  document
    .querySelectorAll('[data-compensation]')
    .forEach((b) => (b.onclick = () => act(() => compensationForm(b.dataset.compensation))));
  on('#source-export', async () =>
    csv(
      [
        ['회원', '강사', '출석', '결석', '예약', '취소', '출석일'],
        ...(data.summary?.items || []).map((g) => [
          g.name,
          g.instructor,
          g.attended,
          g.absent,
          g.reserved,
          g.cancelled,
          g.dates.join(' / '),
        ]),
      ],
      '다짐-현재집계-' + month + '.csv',
    ),
  );
  on('#edit-rule', async () => ruleForm());
  on('#source-import', async () => sourceImport());
  document.querySelectorAll('[data-review]').forEach(
    (b) =>
      (b.onclick = () => {
        const r = data.comparison.items.find((r) => r.key === b.dataset.review);
        confirmAction('대조 항목 검수', async (f, k) => {
          await api('/reconcile', {
            method: 'POST',
            key: k,
            body: { month, key: r.key, fingerprint: r.fingerprint, note: f.get('note') },
          });
          await load();
        });
      }),
  );
  document
    .querySelectorAll('[data-source-link]')
    .forEach((b) => (b.onclick = () => act(() => linkSource(b.dataset.sourceLink))));
  on('#next-summary', async () => {
    data.summary = await api(
      '/source/summary?month=' +
        month +
        '&limit=30&after=' +
        encodeURIComponent($('#next-summary').dataset.after),
    );
    render();
  });
  on('#next-compare', async () => load('&offset=' + $('#next-compare').dataset.offset));
  on('#next-source-records', async () => {
    data.records = await api(
      '/source?month=' +
        month +
        '&after=' +
        encodeURIComponent($('#next-source-records').dataset.after),
    );
    render();
  });
  document
    .querySelectorAll('[data-action=next-page]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          act(() =>
            view === 'audit'
              ? load('&before=' + b.dataset.next)
              : load('&after=' + encodeURIComponent(b.dataset.next)),
          )),
    );
}
async function leaveMemberMode() {
  clearTimeout(memberReturnTimer);
  memberReturnTimer = null;
  await api('/member-mode/exit', { method: 'POST', body: {} });
  memberState = null;
  $('#member-screen').hidden = true;
  $('#member-screen').innerHTML = '';
  $('#app').hidden = false;
  view = allowed('dashboard') ? 'dashboard' : isGroupOnly() ? 'groups' : 'payroll';
  if (history.state?.memberSigning) history.back();
  await initialize();
}
window.addEventListener('popstate', () => {
  if (extendedLessons && memberState) act(leaveMemberMode);
});
async function showMember(r) {
  clearTimeout(memberReturnTimer);
  memberReturnTimer = null;
  if (extendedLessons && !memberState && !history.state?.memberSigning)
    history.pushState({ memberSigning: true }, '', location.href);
  document.body.classList.remove('menu-open');
  memberState = r;
  $('#modal').close();
  $('#app').hidden = true;
  const host = $('#member-screen');
  host.hidden = false;
  const snap = r.snapshot,
    record = r.signature,
    noShow = r.confirmation.state === 'noshow' && r.noShow,
    completed = !!record || !!noShow;
  let strokes = [],
    active = null,
    key = uid();
  host.innerHTML =
    '<div class="member-sheet"><div class="member-brand">' +
    logo() +
    '<div>DOUBLE Y GYM<small>언주역점 · 수업 확인</small></div></div><div class="member-intro">' +
    (noShow ? '노쇼 저장 완료' : record ? '✓ 서명 저장 완료' : '회원님, 수업 내용을 확인해주세요') +
    '</div><h1>' +
    esc(snap?.member || '수업 확인') +
    '<small>회원님</small></h1>' +
    (snap
      ? '<div class="member-facts"><div><span>수업 날짜 / 시간</span><b>' +
        snap.date +
        ' ' +
        snap.time +
        '</b></div><div><span>담당 선생님</span><b>' +
        esc(snap.instructor) +
        '</b></div><div><span>이번 수업</span><b class="ordinal">' +
        snap.ordinal +
        '회차 <small>/ 총 ' +
        snap.registered +
        '회</small></b></div><div><span>이 수업 후 잔여</span><b>' +
        snap.remaining +
        '회</b></div></div>'
      : '<p>수업이 정정 또는 취소되었습니다. 선생님이 확인해주세요.</p>') +
    (r.confirmation.state === 'stale'
      ? '<p class="signature-warning">내용 또는 회차가 변경됐습니다. 이전 원본은 보관하고 현재 내용으로 다시 서명받습니다.</p>'
      : '') +
    (snap
      ? (extendedLessons && !completed
          ? '<label class="consent"><input type="checkbox" id="no-show"> 노쇼 (회원 불참)</label><p class="muted">노쇼로 저장하면 회원 서명 없이 잔여 1회 차감·수업료 정상 반영됩니다.</p>'
          : '') +
        '<p class="signature-label">' +
        (noShow
          ? '노쇼로 기록되어 회원 서명이 없습니다.'
          : record
            ? '저장된 회원 확인 서명'
            : '아래 칸에 손가락으로 서명해주세요') +
        '</p>' +
        (noShow ? '' : '<canvas id="sign-pad" aria-label="회원 수업 확인 서명"></canvas>') +
        (completed
          ? '<p class="muted">저장 시각 ' +
            new Date(noShow?.recorded_at || record.signed_at).toLocaleString('ko-KR', {
              timeZone: 'Asia/Seoul',
            }) +
            ' (한국 시간)</p><p class="muted">' +
            (noShow
              ? '노쇼는 다짐 출석 대조에서 별도로 구분합니다.'
              : '확인 감사합니다. 폰을 선생님께 돌려주세요.') +
            '</p>'
          : '<div class="clear-line" id="sign-tools"><span>날짜와 회차를 확인한 뒤 서명합니다.</span><button id="clear-pad">다시 쓰기</button></div><label class="consent"><input type="checkbox" id="confirm-sign"> <span id="confirm-label">위 날짜·회차의 수업을 진행했음을 확인합니다.</span></label><p class="muted">서명은 수업 내용·저장 시각과 함께 보관됩니다.</p><button class="primary wide" id="save-sign">확인 · 서명 저장</button>')
      : '') +
    '<p class="form-error" id="sign-error"></p><button class="text-button" id="reload-sign">저장 상태 다시 확인</button><div class="member-return"><button id="show-return" class="text-button">홈으로 돌아가기</button>' +
    (extendedLessons
      ? ''
      : '<form id="return-form" hidden>' +
        field('선생님 비밀번호', 'password', 'password', '', 'autocomplete="current-password"') +
        '<div class="form-error"></div><button class="secondary wide" type="submit">비밀번호 확인 · 복귀</button></form>') +
    '</div></div>';
  const canvas = $('#sign-pad');
  let rect, ctx;
  function draw() {
    if (!canvas) return;
    rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (devicePixelRatio || 1);
    canvas.height = rect.height * (devicePixelRatio || 1);
    ctx = canvas.getContext('2d');
    ctx.scale(devicePixelRatio || 1, devicePixelRatio || 1);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#20242a';
    for (const line of record?.strokes || strokes) {
      ctx.beginPath();
      line.forEach(([x, y], i) =>
        i
          ? ctx.lineTo(x * rect.width, y * rect.height)
          : ctx.moveTo(x * rect.width, y * rect.height),
      );
      ctx.stroke();
    }
  }
  if (canvas) {
    draw();
    if (!completed) {
      canvas.onpointerdown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        $('#sign-error').textContent = '';
        canvas.setPointerCapture(e.pointerId);
        rect = canvas.getBoundingClientRect();
        active = [];
        strokes.push(active);
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
          y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        active.push([x, y]);
      };
      canvas.onpointermove = (e) => {
        if (!active) return;
        e.preventDefault();
        active.push([
          Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
          Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
        ]);
        draw();
      };
      const end = () => {
        if (active?.length < 2) strokes = strokes.filter((l) => l !== active);
        active = null;
        draw();
      };
      canvas.onpointerup = canvas.onpointercancel = end;
      $('#clear-pad').onclick = () => {
        strokes = [];
        draw();
      };
      $('#save-sign').onclick = async () => {
        const button = $('#save-sign');
        button.disabled = true;
        try {
          if (!$('#confirm-sign').checked) throw Error('수업 내용 확인란을 체크해주세요.');
          await api('/member-mode/sign', {
            method: 'POST',
            key,
            body: {
              version: r.version,
              snapshot: r.snapshot,
              confirmed: true,
              strokes: $('#no-show')?.checked ? [] : strokes,
              ...($('#no-show')?.checked ? { noShow: true } : {}),
            },
          });
          await showMember(await api('/member-mode'));
          if (extendedLessons) {
            const savedLesson = memberState.lessonId;
            memberReturnTimer = setTimeout(() => {
              if (memberState?.lessonId === savedLesson) act(leaveMemberMode);
            }, 1500);
          }
        } catch (e) {
          $('#sign-error').textContent = e.message;
          button.disabled = false;
        }
      };
    }
  }
  if ($('#no-show'))
    $('#no-show').onchange = (e) => {
      const checked = e.target.checked;
      canvas.hidden = checked;
      $('#sign-tools').hidden = checked;
      host.querySelector('.signature-label').textContent = checked
        ? '회원 불참으로 서명을 생략합니다.'
        : '아래 칸에 손가락으로 서명해주세요';
      $('#confirm-sign').checked = false;
      $('#confirm-label').textContent = checked
        ? '노쇼 1회 차감·수업료 정상 반영을 확인합니다.'
        : '위 날짜·회차의 수업을 진행했음을 확인합니다.';
      $('#save-sign').textContent = checked ? '확인 · 노쇼 저장' : '확인 · 서명 저장';
      if (!checked) draw();
    };
  $('#reload-sign').onclick = () => act(async () => showMember(await api('/member-mode')));
  $('#show-return').onclick = () => {
    if (extendedLessons) return act(leaveMemberMode);
    $('#return-form').hidden = false;
    $('#return-form [name=password]').focus();
  };
  if ($('#return-form'))
    $('#return-form').onsubmit = async (e) => {
      e.preventDefault();
      const button = e.target.querySelector('button');
      button.disabled = true;
      try {
        await api('/member-mode/exit', {
          method: 'POST',
          body: { password: new FormData(e.target).get('password') },
        });
        memberState = null;
        $('#member-screen').hidden = true;
        $('#member-screen').innerHTML = '';
        $('#app').hidden = false;
        await initialize();
      } catch (error) {
        e.target.querySelector('.form-error').textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
}
function bindInstall() {
  document.querySelectorAll('[data-install]').forEach((b) => {
    b.hidden = !installPrompt;
    b.onclick = async () => {
      const p = installPrompt;
      if (!p) return;
      installPrompt = null;
      await p.prompt();
      await p.userChoice;
      bindInstall();
    };
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  bindInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  bindInstall();
});
matchMedia('(max-width:760px)').addEventListener('change', () => {
  document.body.classList.remove('menu-open');
  const sidebar = $('.sidebar');
  if (sidebar) sidebar.inert = matchMedia('(max-width:760px)').matches;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
    document.body.classList.remove('menu-open');
    const sidebar = $('.sidebar');
    if (sidebar) sidebar.inert = matchMedia('(max-width:760px)').matches;
    $('#menu-toggle')?.setAttribute('aria-expanded', 'false');
    $('#menu-toggle')?.focus();
  }
});
window.addEventListener('offline', () => toast('오프라인입니다. 입력은 서버에 저장되지 않습니다.'));
if ('serviceWorker' in navigator && isSecureContext)
  navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(() => {
  if (
    user &&
    !user.mustChange &&
    !memberState &&
    document.visibilityState === 'visible' &&
    !$('#modal').open &&
    ['dashboard', 'payroll', 'lessons'].includes(view)
  )
    load();
}, 60000);
async function boot() {
  try {
    const status = await api('/status');
    setup = status.setupRequired;
    setupRemote = status.remoteSetupTokenRequired;
    extendedLessons = status.storage === 'firestore';
    if (setup) return loginPage();
    try {
      const r = await api('/me');
      user = r.user;
      csrf = r.csrf;
    } catch (e) {
      if (e.status === 401) return loginPage();
      throw e;
    }
    if (user.mustChange) return passwordPage(true);
    if (user.memberMode) return showMember(await api('/member-mode'));
    await initialize();
  } catch (e) {
    $('#app').innerHTML =
      '<div class="auth"><section class="auth-card"><h1>서버 연결을 확인해주세요</h1><p>' +
      esc(e.message) +
      '</p><button class="primary" id="retry">다시 연결</button></section></div>';
    $('#retry').onclick = boot;
  }
}

function salesContent() {
  return (
    (data.summary
      ? '<div class="stats home-stats three">' +
        [
          ['멤버십 순매출', data.summary.membership],
          ['센터 총 순매출', data.summary.centerNet],
          ['PT팀 인센티브 기준 매출', data.summary.pt],
        ]
          .map(
            ([label, value]) =>
              '<article><span>' +
              label +
              '</span><h2>' +
              money(value) +
              '원</h2><small>공급가액 · 환불 반영</small></article>',
          )
          .join('') +
        '</div>'
      : '') +
    '<section class="panel"><div class="panel-head"><div><h3>월별 매출·환불 원장</h3><p>회원권 결제는 회원 등록 시 자동 반영됩니다. 같은 매출을 중복 입력하지 마세요.</p></div>' +
    (extendedLessons
      ? '<button class="primary" id="membership-record">당월 멤버십 총매출</button>'
      : '') +
    '<button class="primary" id="new-sale">거래 기록</button></div>' +
    table(
      ['날짜', '종류', '담당 / 회원', '공급가액', '내용', '거래번호'],
      (data.items || []).map(
        (r) =>
          '<tr><td>' +
          r.date +
          '</td><td>' +
          { pt: 'PT', pilates: '개인 필라테스', membership: '회원권' }[r.category] +
          '<small>' +
          (r.kind === 'refund' ? '환불' : '매출') +
          '</small></td><td>' +
          esc(r.person_name || '센터') +
          '<small>' +
          esc(r.member_name || '') +
          '</small></td><td>' +
          money(r.amount) +
          '</td><td class="wrap">' +
          esc(r.note) +
          '</td><td><input class="reference" readonly aria-label="원결제 거래번호" value="' +
          r.id +
          '"></td></tr>',
      ),
    ) +
    pager(data.next) +
    '</section>'
  );
}
function saleForm() {
  modal(
    '센터 매출 · 환불',
    field('거래일', 'date', 'date', today()) +
      select('거래 구분', 'kind', option('sale', '추가 매출') + option('refund', '환불')) +
      select(
        '매출 종류',
        'category',
        (extendedLessons ? '' : option('membership', '회원권 · 그룹 필라테스')) +
          option('pt', 'PT 매출 조정') +
          option('pilates', '개인 필라테스 조정'),
      ) +
      select('담당 (회원권은 미지정)', 'personId', personOptions('', true)) +
      field('공급가액 (양수 입력)', 'amount', 'number', '', 'min="1" step="1"') +
      field('환불 원결제 거래번호', 'originalId') +
      select(
        '이전 판매분 환불 제외',
        'legacyRefund',
        option('false', '일반 거래') + option('true', '총괄매니저 체제 이전 판매 환불'),
      ) +
      field('거래 사유', 'note') +
      '<p class="form-note">환불은 환불한 달 매출에서 차감합니다. 이미 지급한 수업료·성과급의 환수는 월별 별도 공제에 입력합니다. 환불이 원결제 남은 금액을 넘을 수 없습니다.</p>',
    async (f, k) => {
      await api('/sales', {
        method: 'POST',
        key: k,
        body: {
          date: f.get('date'),
          kind: f.get('kind'),
          category: f.get('category'),
          personId: f.get('personId') || null,
          amount: Number(f.get('amount')),
          originalId: f.get('originalId') || null,
          legacyRefund: f.get('legacyRefund') === 'true',
          note: f.get('note'),
        },
      });
      await load();
    },
    '거래 저장',
    () => {
      $('[name=originalId]').required = false;
    },
  );
}

function employmentForm(p) {
  modal(
    p.name + ' · 계약 종료',
    field('마지막 근무일 (포함)', 'endDate', 'date', p.end_date || today()) +
      field('종료 사유', 'reason') +
      '<p class="form-note">마지막 근무 월까지 정산 대상에 포함합니다. 기본급의 일할 계산은 자동이 아니며 해당 월 별도 공제로 조정하세요. 종료일 다음 날부터 직원 로그인이 차단됩니다. 담당 회원은 인수인계 메뉴로 이전하세요.</p>',
    async (f, k) => {
      await api('/people/' + p.id + '/employment', {
        method: 'PATCH',
        key: k,
        body: { version: p.version, endDate: f.get('endDate'), reason: f.get('reason') },
      });
      await initialize();
    },
  );
}
function transferForm(m) {
  modal(
    m.name + ' · 담당자 인수인계',
    select(
      '새 담당 선생님',
      'personId',
      people
        .filter(
          (p) =>
            p.id !== m.person_id &&
            !['fc', 'staff', 'part', 'daily', 'group', 'representative'].includes(p.profile) &&
            (!p.end_date || p.end_date >= today()),
        )
        .map((p) => option(p.id, p.name))
        .join(''),
    ) +
      field('인수인계일', 'effectiveDate', 'date', today(), 'max="' + today() + '"') +
      field('인수인계 사유', 'reason') +
      '<p class="form-note">회원·활성 회원권의 담당만 변경합니다. 기존 결제와 이미 진행한 수업·서명·정산은 이전 선생님 기록으로 보관합니다. 미래 수업은 새 담당자로 기록합니다.</p>',
    async (f, k) => {
      await api('/members/' + m.id, {
        method: 'PATCH',
        key: k,
        body: {
          version: m.version,
          personId: f.get('personId'),
          effectiveDate: f.get('effectiveDate'),
          reason: f.get('reason'),
        },
      });
      await load();
    },
  );
}
boot();
