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
let user = null,
  csrf = '',
  setup = false,
  setupRemote = false,
  people = [],
  profiles = {},
  view = 'dashboard',
  month = today().slice(0, 7),
  data = {},
  sequence = 0,
  memberState = null,
  installPrompt = null;
const titles = {
  dashboard: '운영 현황',
  members: '회원 · 결제',
  lessons: '수업 · 회원 서명',
  payroll: '월별 급여 정산',
  source: '다짐 출석 대조',
  people: '구성원 · 계정',
  settings: '정산 기준',
  audit: '변경 이력',
  password: '내 비밀번호',
  sales: '센터 매출 · 환불',
};
const symbols = {
  dashboard: '◫',
  members: '♧',
  lessons: '✎',
  payroll: '▤',
  source: '⇄',
  people: '♙',
  settings: '⚙',
  audit: '◷',
  password: '⚿',
  sales: '↗',
};
const isAdmin = () => user?.role === 'admin',
  isTrainer = () => !!user?.person && !['fc', 'staff', 'part'].includes(user.person.profile),
  allowed = (v) =>
    isAdmin() ||
    ['payroll', 'password'].includes(v) ||
    (isTrainer() && ['dashboard', 'members', 'lessons'].includes(v));
function toast(t) {
  $('#toast').textContent = t;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 4000);
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
  const first = setup;
  $('#app').innerHTML =
    '<div class="auth"><div class="auth-brand">DOUBLE Y<small>언주역점 · PAYROLL WORKSPACE</small></div><section class="auth-card"><span class="eyebrow">YOUR PERSONAL WORKSPACE</span><h1>' +
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
      '비밀번호',
      'password',
      'password',
      '',
      'autocomplete="' +
        (first ? 'new-password' : 'current-password') +
        '" minlength="10" maxlength="128"',
    ) +
    (first
      ? field('비밀번호 확인', 'confirm', 'password', '', 'minlength="10" maxlength="128"')
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
      'autocomplete="new-password" minlength="10" maxlength="128"',
    ) +
    field(
      '새 비밀번호 확인',
      'confirm',
      'password',
      '',
      'autocomplete="new-password" minlength="10" maxlength="128"',
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
  const r = await api('/people');
  people = r.items;
  profiles = r.profiles;
  if (!allowed(view)) view = isTrainer() ? 'dashboard' : 'payroll';
  await load();
}
async function load(extra = '') {
  const seq = ++sequence;
  try {
    let r;
    if (view === 'dashboard' || view === 'payroll') r = await api('/payroll?month=' + month);
    else if (view === 'members') r = await api('/members?limit=20' + extra);
    else if (view === 'lessons') r = await api('/lessons?month=' + month + '&limit=30' + extra);
    else if (view === 'sales') r = await api('/sales?month=' + month + extra);
    else if (view === 'people') r = { accounts: await api('/accounts') };
    else if (view === 'settings') r = await api('/rules');
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
    '<aside class="sidebar"><a class="brand" href="#" data-view="dashboard"><b>W<span>Y</span></b><div>DOUBLE Y<small>PAYROLL WORKSPACE</small></div></a><div class="branch"><b>Y</b><div>더블와이짐 언주역점<small>공용 운영 워크스페이스</small></div></div><div class="nav-label">WORKSPACE</div><nav>' +
    nav
      .map(
        (v) =>
          '<button data-view="' +
          v +
          '" class="' +
          (v === view ? 'active' : '') +
          '"><span>' +
          symbols[v] +
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
    (isAdmin() ? '관리자 · 전체 조회' : '직원 · 본인만 조회') +
    '</small></div></div></div></aside><main><header><span>워크스페이스 <i>/</i> ' +
    titles[view] +
    '</span><div><button class="text-button" data-install hidden>앱 설치</button><button class="text-button" id="refresh">새로고침</button><button class="text-button" id="logout">로그아웃</button><span class="avatar light">' +
    esc(user.name.slice(0, 1)) +
    '</span></div></header><div class="content"><div class="heading"><div><span class="eyebrow">DOUBLE Y GYM · EONJU</span><h1>' +
    titles[view] +
    '<em>.</em></h1><p>' +
    (isAdmin()
      ? '매출과 수업, 확인 기록과 정산을 관리하세요.'
      : '내 회원의 결제·수업과 예상 급여를 확인하세요.') +
    '</p></div><input type="month" id="month" value="' +
    month +
    '" aria-label="정산 월"></div>' +
    content() +
    '<footer><b>DOUBLE Y <small>PAYROLL</small></b><span>서버 저장 · 변경 이력 보관 · 직원별 권한 적용</span></footer></div></main>';
  document.querySelectorAll('[data-view]').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.preventDefault();
        const v = b.dataset.view;
        if (!allowed(v)) return;
        view = v;
        load();
      }),
  );
  $('#month').onchange = (e) => {
    if (e.target.value) {
      month = e.target.value;
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
  if (view === 'dashboard' || view === 'payroll') return payrollContent();
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
  const rows = data.items || [],
    totals = rows.reduce(
      (x, r) => ({
        net: x.net + r.net,
        sales: x.sales + r.revenue,
        lessons: x.lessons + r.lessons,
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
          '%</td><td>' +
          money(r.base) +
          '</td><td>' +
          money(r.commission + r.bonus + r.incentive + r.extra) +
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
    (!rows.length
      ? empty('정산할 구성원이 없습니다', '관리자가 구성원을 추가하고 급여 조건을 설정하세요.')
      : '') +
    '</section>'
  );
}
function membersContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>회원별 등록과 잔여횟수 <span class="tag">이 페이지 ' +
    (data.items || []).length +
    '명</span></h3><p>기존 회원은 선택만 하고, 추가 결제는 별도 회원권으로 연결합니다.</p></div><div class="actions">' +
    (isAdmin() ? '<button class="secondary" id="bulk-import">기존 회원 일괄 등록</button>' : '') +
    '<button class="primary" id="new-registration">＋ 신규 회원 · PT</button></div></div><div class="toolbar"><input id="member-search" placeholder="회원 이름 검색" aria-label="회원 이름 검색"><button class="secondary" id="member-search-button">검색</button></div><div class="member-grid">' +
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
          '">회원권</button><button class="secondary" data-renew="' +
          m.id +
          '">추가 결제</button></div><button class="primary wide" data-complete="' +
          m.id +
          '">수업 완료 · 회원 서명</button></article>',
      )
      .join('') +
    '</div>' +
    (!(data.items || []).length
      ? empty('등록된 회원이 없습니다', '신규 등록 또는 기존 회원 일괄 가져오기로 시작하세요.')
      : '') +
    pager(data.next) +
    '</section>'
  );
}
function lessonsContent() {
  return (
    '<section class="panel"><div class="panel-head"><div><h3>수업 기록 · 서명 확인</h3><p>날짜와 회차는 구분됩니다. 미서명·재서명은 정산 승인 전 확인하세요.</p></div><button class="primary" id="go-members">회원 선택 · 수업 기록</button></div>' +
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
          '</b></td><td>' +
          esc(l.instructor) +
          '</td><td>' +
          (l.status === 'void' ? '취소' : '진행') +
          '</td><td><button class="signature-status ' +
          l.confirmation.state +
          '" data-sign="' +
          l.id +
          '">' +
          { unsigned: '회원 서명받기', signed: '✓ 서명 완료', stale: '재서명 필요' }[
            l.confirmation.state
          ] +
          '</button></td><td><button class="text-button" data-history="' +
          l.id +
          '">이력</button> <button class="text-button" data-edit-lesson="' +
          l.id +
          '">정정</button></td></tr>',
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
          '</td><td><button class="text-button" data-compensation="' +
          p.id +
          '">급여 조건·월 입력</button> <button class="text-button" data-employment="' +
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
          (a.role === 'admin' ? '관리자' : '직원') +
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
    '<div class="padded muted">회당 수업료 = 회원권 공급가액 ÷ 등록횟수 × 수업 월 지급률 (회당 원 단위 반올림).<br>겸용 강사 입사 월과 다음 달 최저 45%. 총괄/FC/PT팀장 성과급은 계약 기준으로 별도 계산합니다. 원천징수는 합산 세율 기준 예상치이며 별도 세금 신고 기능은 아닙니다.<br>자료는 서버의 개별 테이블에 보관합니다. 백업·복원은 운영 안내의 검증된 명령을 사용하세요.</div></section>'
  );
}
const compareLabel = {
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
          ({ signed: '완료', unsigned: '미서명', stale: '재서명' }[r.confirmation] || '—') +
          '</td><td>' +
          (r.reviewed
            ? '<span class="muted">' + esc(r.reviewNote) + '</span>'
            : r.kind === 'matched'
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
function registrationForm(existing = null) {
  const b = existing
    ? '<div class="notice inner"><b>' + esc(existing.name) + ' · 기존 회원 추가 결제</b></div>'
    : field('신규 회원 이름', 'name', 'text', '', 'maxlength="80"') +
      (isAdmin() ? select('담당 선생님', 'personId', personOptions('', true)) : '');
  modal(
    existing ? '기존 회원 추가 결제' : '신규 회원 · PT 등록',
    b +
      field('결제일', 'paidDate', 'date', today()) +
      field('수업 시작일', 'startDate', 'date', today()) +
      field('결제 금액 (원)', 'amount', 'number', '', 'min="0" step="1"') +
      select(
        '금액 기준',
        'vatIncluded',
        option('false', 'VAT 제외 공급가액') + option('true', 'VAT 포함 결제금액 (÷1.1)'),
      ) +
      field('등록 횟수', 'quantity', 'number', 20, 'min="1" max="10000" step="1"') +
      select('수업 종류', 'category', option('pt', 'PT') + option('pilates', '개인 필라테스')) +
      '<p class="form-note">기존 회원 추가 결제는 회원을 다시 만들지 않습니다. 이전 회원권 잔여와 새 계약의 단가·횟수를 각각 유지합니다.</p>',
    async (f, key) => {
      await api('/registrations', {
        method: 'POST',
        key,
        body: {
          name: f.get('name'),
          personId: f.get('personId') || user.personId,
          memberId: existing?.id,
          paidDate: f.get('paidDate'),
          startDate: f.get('startDate'),
          amount: Number(f.get('amount')),
          quantity: Number(f.get('quantity')),
          vatIncluded: f.get('vatIncluded') === 'true',
          category: f.get('category'),
          saleType: existing ? 'renew' : 'new',
        },
      });
      await load();
      toast('회원과 결제를 저장했습니다.');
    },
  );
}
async function memberContracts(key) {
  const r = await api('/members/' + key);
  modal(
    r.member.name + ' · 회원권',
    table(
      ['등록 / 결제', '구분', '공급가액', '등록 / 사용 / 잔여', '상태'],
      r.contracts.map(
        (c) =>
          '<tr><td>' +
          c.start_date +
          '<small>결제 ' +
          c.paid_date +
          '</small></td><td>' +
          { new: '신규', renew: '추가 결제' }[c.sale_type] +
          '</td><td>' +
          money(c.amount) +
          '</td><td>' +
          c.quantity +
          ' / ' +
          c.used +
          ' / ' +
          c.remaining +
          '</td><td>' +
          (c.active ? '활성' : '종료') +
          (isAdmin() && c.active
            ? ' <button type="button" class="text-button" data-close-contract="' +
              c.id +
              '">종료</button>'
            : '') +
          '</td></tr>',
      ),
    ) +
      '<p class="form-note">회원번호 #' +
      r.member.id.slice(0, 6) +
      ' · 같은 이름도 다른 ID로 구분합니다.</p>' +
      (isAdmin()
        ? '<button class="secondary" type="button" id="transfer-member">담당자 인수인계</button>'
        : ''),
    () => {},
    '닫기',
    () => {
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
      if ($('#transfer-member')) $('#transfer-member').onclick = () => transferForm(r.member);
    },
  );
}
async function completeForm(key) {
  const r = await api('/members/' + key),
    available = r.contracts.filter((c) => c.active && c.remaining > 0);
  if (!available.length) return toast('잔여 회원권이 없습니다. 추가 결제를 등록하세요.');
  modal(
    r.member.name + ' · 수업 기록',
    select(
      '사용할 회원권',
      'contractId',
      available
        .map((c) =>
          option(c.id, c.start_date + ' · ' + c.quantity + '회권 · 잔여 ' + c.remaining + '회'),
        )
        .join(''),
    ) +
      field('수업일', 'date', 'date', today(), 'max="' + today() + '"') +
      field('수업 시작 시간', 'time', 'time', '10:00') +
      '<p class="form-note">수업을 저장한 뒤 회원 화면으로 전환합니다. 정확한 날짜·회차를 회원에게 확인받으세요. 미서명 기록도 예상 급여에 포함되지만 승인 전 검수가 필요합니다.</p>',
    async (f, key) => {
      const row = await api('/lessons', {
        method: 'POST',
        key,
        body: { contractId: f.get('contractId'), date: f.get('date'), time: f.get('time') },
      });
      $('#modal').close();
      await showMember(await api('/member-mode', { method: 'POST', body: { lessonId: row.id } }));
    },
    '수업 기록 · 회원 서명',
  );
}
async function showHistory(key) {
  const r = await api('/lessons/' + key + '/signatures');
  modal(
    '회원 서명 이력',
    r.items
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
      empty('서명 이력이 없습니다', '누락 서명은 나중에 해당 수업에서 받을 수 있습니다.'),
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
  c.strokeStyle = '#5f427d';
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
      '</div><p class="form-note">회원 서명 확인 필요 ' +
      r.unconfirmed +
      '건. 승인 시 다짐 대조·미서명 예외가 있으면 관리자가 사유를 남겨야 합니다. 이미 승인된 금액은 저장된 명세를 조회합니다.</p>' +
      table(
        ['수업일', '회당 수업료', '서명'],
        r.lines.map(
          (l) =>
            '<tr><td>' +
            l.date +
            ' ' +
            l.time +
            '</td><td>' +
            money(l.unit) +
            '</td><td>' +
            { signed: '완료', unsigned: '미서명', stale: '재서명' }[l.signature] +
            '</td></tr>',
        ),
      ) +
      (r.nextOffset !== null
        ? '<p class="muted">상세 100건까지 표시했습니다. 총 ' +
          r.lessons +
          '회는 전체 월을 집계한 금액입니다.</p>'
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
      field('초기 기본급 / 알바 시급', 'base', 'number', 500000, 'min="0" step="1"') +
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
      };
    },
  );
}
function newAccountForm() {
  const taken = new Set((data.accounts?.items || []).map((a) => a.personId));
  modal(
    '로그인 계정 발급',
    field(
      '로그인 아이디',
      'username',
      'text',
      '',
      'minlength="3" maxlength="40" pattern="[a-zA-Z0-9._-]+"',
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
      field('미연결 관리자 표시 이름', 'name') +
      field(
        '임시 비밀번호',
        'password',
        'password',
        '',
        'minlength="10" maxlength="128" autocomplete="new-password"',
      ) +
      '<p class="form-note">직원이 처음 접속하면 새 비밀번호를 설정해야 합니다. 임시 비밀번호는 직원에게 개별 전달하세요.</p>',
    async (f, k) => {
      await api('/accounts', { method: 'POST', key: k, body: Object.fromEntries(f) });
      await load();
    },
    '계정 발급',
    () => {
      $('[name=name]').required = false;
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
        'minlength="10" maxlength="128" autocomplete="new-password"',
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
    field(
      '월 근무시간 (알바만)',
      'hours',
      'number',
      r.inputs.hours100 / 100,
      'min="0" max="744" step=".25"',
    ) +
      field('추가 수당', 'extra', 'number', r.inputs.extra, 'min="0" step="1"') +
      field(
        '별도 공제 / 이전 지급분 환수',
        'deduction',
        'number',
        r.inputs.deduction,
        'min="0" step="1"',
      ) +
      field('입력 사유', 'note', 'text', r.inputs.note) +
      '<button type="button" class="text-button" id="edit-base">월 기본급·시급 / 세율 변경 →</button>',
    async (f, k) => {
      await api('/people/' + key + '/inputs', {
        method: 'PUT',
        key: k,
        body: {
          month,
          version: r.inputs.version,
          hours100: Math.round(Number(f.get('hours')) * 100),
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
            field('월 기본급 / 알바 시급', 'base', 'number', r.terms.base, 'min="0" step="1"') +
            field(
              '원천징수율 (%)',
              'tax',
              'number',
              r.terms.tax_bps / 100,
              'min="0" max="100" step=".01"',
            ) +
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
  const { header } = await api('/import/members');
  modal(
    '기존 회원 일괄 등록',
    '<p class="form-note">엑셀에서 아래 열 순서로 복사하거나 UTF-8 CSV를 붙여넣으세요. 회원번호와 등록번호는 중복 방지를 위한 고유값입니다. 공급가액 기준이며 기존 회원권은 실제 과거 결제일을 입력합니다.</p><pre class="template">' +
      esc(header) +
      '</pre><label class="field">표 데이터<textarea name="text" rows="9" required placeholder="' +
      esc(header) +
      '"></textarea></label>',
    async (f) => {
      const original = f.get('text'),
        preview = await api('/import/members/preview', {
          method: 'POST',
          body: { text: original },
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
            ['회원번호 / 이름', '담당', '등록번호', '공급가액', '등록/기진행', '처리'],
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
          const r = await api('/import/members', { method: 'POST', key, body: { text: original } });
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
        personId = f.get('personId') || null,
        r = await api('/source/preview', { method: 'POST', body: { text: original } });
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
  on('#new-registration', async () => registrationForm());
  on('#bulk-import', bulkImport);
  on('#member-search-button', async () =>
    load('&q=' + encodeURIComponent($('#member-search').value)),
  );
  document
    .querySelectorAll('[data-renew]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          act(async () => registrationForm((await api('/members/' + b.dataset.renew)).member))),
    );
  document
    .querySelectorAll('[data-contracts]')
    .forEach((b) => (b.onclick = () => act(() => memberContracts(b.dataset.contracts))));
  document
    .querySelectorAll('[data-complete]')
    .forEach((b) => (b.onclick = () => act(() => completeForm(b.dataset.complete))));
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
  document.querySelectorAll('[data-edit-lesson]').forEach(
    (b) =>
      (b.onclick = () => {
        const l = data.items.find((l) => l.id === b.dataset.editLesson);
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
async function showMember(r) {
  memberState = r;
  $('#modal').close();
  $('#app').hidden = true;
  const host = $('#member-screen');
  host.hidden = false;
  const snap = r.snapshot,
    record = r.signature;
  let strokes = [],
    active = null,
    key = uid();
  host.innerHTML =
    '<div class="member-sheet"><div class="member-brand">DOUBLE Y <small>언주역점 · 수업 확인</small></div><div class="member-intro">' +
    (record ? '✓ 서명 저장 완료' : '회원님, 수업 내용을 확인해주세요') +
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
      ? '<p class="signature-label">' +
        (record ? '저장된 회원 확인 서명' : '아래 칸에 손가락으로 서명해주세요') +
        '</p><canvas id="sign-pad" aria-label="회원 수업 확인 서명"></canvas>' +
        (record
          ? '<p class="muted">저장 시각 ' +
            new Date(record.signed_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) +
            ' (한국 시간)</p><p class="muted">확인 감사합니다. 폰을 선생님께 돌려주세요.</p>'
          : '<div class="clear-line"><span>날짜와 회차를 확인한 뒤 서명합니다.</span><button id="clear-pad">다시 쓰기</button></div><label class="consent"><input type="checkbox" id="confirm-sign"> 위 날짜·회차의 수업을 진행했음을 확인합니다.</label><p class="muted">서명은 수업 내용·저장 시각과 함께 보관됩니다.</p><button class="primary wide" id="save-sign">확인 · 서명 저장</button>')
      : '') +
    '<p class="form-error" id="sign-error"></p><button class="text-button" id="reload-sign">저장 상태 다시 확인</button><div class="member-return"><button id="show-return" class="text-button">선생님 화면으로 돌아가기</button><form id="return-form" hidden>' +
    field('선생님 비밀번호', 'password', 'password', '', 'autocomplete="current-password"') +
    '<div class="form-error"></div><button class="secondary wide" type="submit">비밀번호 확인 · 복귀</button></form></div></div>';
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
    ctx.strokeStyle = '#4c365f';
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
    if (!record) {
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
            body: { version: r.version, snapshot: r.snapshot, confirmed: true, strokes },
          });
          await showMember(await api('/member-mode'));
        } catch (e) {
          $('#sign-error').textContent = e.message;
          button.disabled = false;
        }
      };
    }
  }
  $('#reload-sign').onclick = () => act(async () => showMember(await api('/member-mode')));
  $('#show-return').onclick = () => {
    $('#return-form').hidden = false;
    $('#return-form [name=password]').focus();
  };
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
    '<section class="panel"><div class="panel-head"><div><h3>월별 매출·환불 원장</h3><p>회원권 결제는 회원 등록 시 자동 반영됩니다. 같은 매출을 중복 입력하지 마세요.</p></div><button class="primary" id="new-sale">거래 기록</button></div>' +
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
        option('membership', '회원권 · 그룹 필라테스') +
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
            !['fc', 'staff', 'part'].includes(p.profile) &&
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
