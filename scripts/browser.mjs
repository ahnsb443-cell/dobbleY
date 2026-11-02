import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { createFirebaseApp } from '../firebase/local.mjs';
const firebaseMode = process.argv.includes('--firebase');
const reportMode = process.argv.includes('--report'),
  out = path.resolve(process.env.REPORT_DIR || 'reports/long-term-simulation'),
  dir = await mkdtemp(path.join(tmpdir(), 'dy-browser-')),
  app = process.argv.includes('--firebase')
    ? await createFirebaseApp({
        projectId: 'demo-double-y',
        setupToken: 'browser-test-setup',
      })
    : await createApp({ dataDir: dir });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + app.server.address().port;
let browser;
const pw = () => randomBytes(20).toString('hex'),
  adminPw = process.argv.includes('--pin') ? '0518' : pw(),
  temp = process.argv.includes('--pin') ? '0427' : pw(),
  teacherPw = process.argv.includes('--pin') ? '0836' : pw(),
  steps = [],
  errors = [];
if (reportMode) await mkdir(out, { recursive: true });
async function snap(page, title, text) {
  if (!reportMode) return;
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.querySelector('#toast')?.classList.remove('show');
  });
  const file = String(steps.length + 1).padStart(2, '0') + '.png';
  await page.screenshot({ path: path.join(out, file), fullPage: false });
  steps.push({ title, text, file });
}
async function navigate(page, target) {
  const mobile = page.viewportSize().width <= 760;
  if (mobile && (await page.locator('.trainer-workspace.view-payroll').count())) {
    await page.locator('.mobile-brand').click();
    await page.locator('.trainer-home, .trainer-workspace:not(.view-payroll)').first().waitFor();
    if (target === 'dashboard') return;
  }
  if (mobile && (await page.locator('.mobile-nav [data-view="' + target + '"]').count()) === 0) {
    await page.locator('#menu-toggle').click();
    await page.locator('.sidebar nav [data-view="' + target + '"]').click();
    return;
  }
  await page
    .locator((mobile ? '.mobile-nav' : '.sidebar nav') + ' [data-view="' + target + '"]')
    .click();
}
async function clickSubmit(page) {
  const invalid = await page
    .locator('#modal-form :invalid')
    .evaluateAll((fields) => fields.map((f) => f.name + ': ' + f.validationMessage));
  assert.deepEqual(invalid, [], 'Form validation');
  await page.locator('#modal-form button[type=submit]').click();
}
async function closed(page) {
  await page.waitForFunction(() => !document.querySelector('#modal').open);
}
async function draw(page, context) {
  const b = await page.locator('#sign-pad').boundingBox(),
    cdp = await context.newCDPSession(page);
  for (const line of [
    [
      [0.1, 0.7],
      [0.2, 0.25],
      [0.3, 0.65],
      [0.4, 0.3],
      [0.45, 0.65],
    ],
    [
      [0.55, 0.3],
      [0.55, 0.65],
      [0.72, 0.65],
    ],
    [
      [0.75, 0.6],
      [0.82, 0.3],
      [0.9, 0.6],
    ],
  ]) {
    const p = line.map(([x, y]) => ({ x: b.x + x * b.width, y: b.y + y * b.height }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p[0]] });
    for (let i = 1; i < p.length; i++)
      for (let j = 1; j <= 4; j++)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            {
              x: p[i - 1].x + ((p[i].x - p[i - 1].x) * j) / 4,
              y: p[i - 1].y + ((p[i].y - p[i - 1].y) * j) / 4,
            },
          ],
        });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await cdp.detach();
}
async function returnTeacher(page) {
  await page.locator('#show-return').click();
  if (!firebaseMode) {
    await page.locator('#return-form [name=password]').fill(teacherPw);
    await page.locator('#return-form button').click();
  } else assert.equal(await page.locator('#return-form').count(), 0);
  await page.waitForFunction(() => document.querySelector('#member-screen').hidden);
}
async function record(page, context, name, date, capture = false) {
  if (capture) {
    await navigate(page, 'dashboard');
    await page.waitForSelector('#quick-record');
    if (reportMode) {
      await page.evaluate(() => document.querySelector('#toast')?.classList.remove('show'));
      await page.screenshot({ path: path.join(out, 'trainer-home.png'), fullPage: false });
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
      'mobile home must fit viewport',
    );
    await page.locator('#quick-record').click();
    await page.locator('#quick-member-search').fill(name);
    await page.locator('[data-quick-member]').filter({ hasText: name }).click();
  } else {
    await navigate(page, 'members');
    await page.waitForSelector('.member-card');
    const card = page
      .locator('.member-card')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    await card.locator('[data-complete]').click();
  }
  await page.locator('[name=date]').fill(date);
  await page.locator('[name=time]').fill('10:00');
  await clickSubmit(page);
  await page.waitForSelector('#sign-pad');
  if (capture) {
    assert.match(await page.locator('.ordinal').textContent(), /5회차/);
    await snap(
      page,
      '5. 회원 화면: 날짜와 회차를 구분',
      '기존 30회권에서 이전 4회를 진행한 회원입니다. 10월 7일 수업은 5회차이며 잔여 25회로 표시됩니다. 회원에게는 급여나 다른 회원 정보가 보이지 않습니다.',
    );
    const tab = await context.newPage();
    await tab.goto(url);
    await tab.waitForSelector('#member-screen:not([hidden])');
    assert.equal(await tab.locator('#app').isHidden(), true);
    await tab.close();
  }
  await page.locator('#confirm-sign').check();
  await draw(page, context);
  if (capture)
    await snap(
      page,
      '6. 폰 터치로 서명하고 저장',
      '가상 터치 획을 작성했습니다. 날짜·회차를 확인한 서명은 해당 수업과 서버 시각에 연결됩니다. 다른 탭으로 접속해도 회원 확인 모드가 유지됩니다.',
    );
  await page.locator('#save-sign').click();
  await page.waitForFunction(() =>
    document.querySelector('.member-intro')?.textContent.includes('저장 완료'),
  );
  if (capture)
    await snap(
      page,
      '7. 서명 원본 저장 완료',
      '회원·날짜·시간·회차·잔여횟수와 서명 원본 해시를 개별 저장합니다. 홈으로 바로 복귀하며, 서명 원본은 일반 API에서 변경·삭제하지 못합니다.',
    );
  await returnTeacher(page);
}
async function request(page, route, method = 'GET', body) {
  return page.evaluate(
    async ({ route, method, body }) => {
      const me = await fetch('/api/me').then((r) => r.json());
      const r = await fetch('/api' + route, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(method === 'GET'
            ? {}
            : { 'X-CSRF-Token': me.csrf, 'Idempotency-Key': crypto.randomUUID() }),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    },
    { route, method, body },
  );
}
async function representativeScenario(admin, browser) {
  await navigate(admin, 'people');
  await admin.locator('#new-person').click();
  await admin.locator('[name=name]').fill('대표 등록 검증');
  await admin.locator('[name=profile]').selectOption('representative');
  assert.equal(await admin.locator('[name=base]').isVisible(), false);
  await admin.locator('[name=hireMonth]').fill('2026-11');
  await clickSubmit(admin);
  await closed(admin);
  const person = (await request(admin, '/people')).body.items.find(
    (p) => p.name === '대표 등록 검증',
  );
  assert.equal(person.profile, 'representative');
  assert.equal(await admin.locator('[data-compensation="' + person.id + '"]').count(), 0);
  const issued = await request(admin, '/accounts', 'POST', {
    username: 'representative01',
    password: '0261',
    role: 'admin',
    personId: person.id,
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.role, 'employee');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('[name=username]').fill('representative01');
  await page.locator('[name=password]').fill('0261');
  await page.locator('#login-form button').click();
  await page.waitForSelector('#password-form');
  await page.locator('[name=currentPassword]').fill('0261');
  await page.locator('[name=password]').fill('0372');
  await page.locator('[name=confirm]').fill('0372');
  await page.locator('#password-form button').click();
  await page.locator('.view-dashboard').waitFor();
  assert.ok((await page.locator('.notice').innerText()).includes('현황 열람 전용'));
  assert.equal(
    await page
      .locator('[data-view=payroll], #quick-record, #new-person, #membership-record')
      .count(),
    0,
  );
  assert.equal((await request(page, '/membership-total', 'PUT', {})).status, 403);
  assert.equal((await request(page, '/overview?month=2026-11')).status, 200);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    'representative mobile fits viewport',
  );
  await page.close();
  console.log('PASS: representative has overview only, no payroll or write controls.');
}
async function deleteLessonScenario(admin) {
  const p = (
    await request(admin, '/people', 'POST', {
      name: '삭제 버튼 검증',
      profile: 'standard',
      hireMonth: '2026-01',
    })
  ).body;
  const seeded = await request(admin, '/registrations', 'POST', {
    name: '삭제 검증 회원',
    personId: p.id,
    paidDate: '2026-11-01',
    amount: 0,
    quantity: 10,
    category: 'pt',
    saleType: 'new',
    carryUsed: 3,
    fixedFee: 20000,
  });
  assert.equal(seeded.status, 200);
  const member = seeded.body.member,
    contract = seeded.body.contract;
  const recorded = await request(admin, '/lessons', 'POST', {
    contractId: contract.id,
    date: '2026-11-01',
    time: '10:00',
  });
  assert.equal(recorded.status, 200);
  assert.equal((await request(admin, '/members/' + member.id)).body.contracts[0].remaining, 6);
  assert.equal(
    (await request(admin, '/payroll/' + p.id + '?month=2026-11')).body.commission,
    20000,
  );
  await admin.locator('#month').fill('2026-11');
  await admin.locator('#month').dispatchEvent('change');
  await navigate(admin, 'lessons');
  await admin.locator('[data-delete-lesson="' + recorded.body.id + '"]').click();
  await admin.locator('[name=reason]').fill('중복 기록 삭제 검증');
  await clickSubmit(admin);
  await closed(admin);
  assert.equal(await admin.locator('[data-delete-lesson="' + recorded.body.id + '"]').count(), 0);
  assert.equal(await admin.locator('[data-history="' + recorded.body.id + '"]').count(), 0);
  await admin.locator('#toggle-deleted-lessons').click();
  await admin.locator('[data-history="' + recorded.body.id + '"]').waitFor();
  assert.ok(
    (
      await admin
        .locator('tr')
        .filter({ has: admin.locator('[data-history="' + recorded.body.id + '"]') })
        .innerText()
    ).includes('삭제 · 정산 제외'),
  );
  assert.equal((await request(admin, '/members/' + member.id)).body.contracts[0].remaining, 7);
  assert.equal((await request(admin, '/payroll/' + p.id + '?month=2026-11')).body.commission, 0);
  console.log(
    'PASS: admin delete button restores remaining and removes payroll, keeping history visible.',
  );
}
async function fixedFeeScenario(admin) {
  const month = '2026-09';
  const person = (
    await request(admin, '/people', 'POST', {
      name: '고정 수업료 선생님',
      profile: 'standard',
      hireMonth: '2026-01',
    })
  ).body;
  await admin.reload();
  await admin.waitForSelector('#month');
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.locator('#month').fill(month);
  await admin.locator('#month').dispatchEvent('change');
  await navigate(admin, 'members');
  const seeded = await request(admin, '/registrations', 'POST', {
    name: '고정 이만원 회원',
    personId: person.id,
    paidDate: month + '-01',
    startDate: month + '-01',
    amount: 0,
    quantity: 36,
    category: 'pt',
    saleType: 'new',
    fixedFee: 20000,
  });
  assert.equal(seeded.status, 200);
  await navigate(admin, 'members');
  assert.equal(await admin.locator('#new-registration, [data-renew]').count(), 0);
  const member = (await request(admin, '/members?q=' + encodeURIComponent('고정 이만원 회원'))).body
    .items[0];
  const contract = (await request(admin, '/members/' + member.id)).body.contracts[0];
  assert.equal(contract.fixed_fee, 20000);
  const recorded = await request(admin, '/lessons', 'POST', {
    contractId: contract.id,
    date: month + '-10',
    time: '10:00',
  });
  assert.equal(recorded.status, 200);
  let pay = (await request(admin, '/payroll/' + person.id + '?month=' + month)).body;
  assert.equal(pay.commission, 20000);
  await admin.locator('[data-contracts="' + member.id + '"]').click();
  await admin.locator('[data-contract-fee="' + contract.id + '"]').waitFor();
  assert.ok((await admin.locator('#modal').innerText()).includes('고정 회당 20,000원'));
  await admin.locator('[data-contract-fee="' + contract.id + '"]').click();
  await admin.locator('[name=fixedFee]').fill('25000');
  await admin.locator('[name=reason]').fill('계약 조건 확인');
  await clickSubmit(admin);
  await closed(admin);
  pay = (await request(admin, '/payroll/' + person.id + '?month=' + month)).body;
  assert.equal(pay.commission, 25000);
  assert.equal((await request(admin, '/members/' + member.id)).body.contracts[0].remaining, 35);
  await navigate(admin, 'payroll');
  await admin.locator('[data-payroll="' + person.id + '"]:visible').click();
  await admin.locator('#modal[open]').waitFor();
  assert.ok((await admin.locator('#modal').innerText()).includes('고정 수업료 · 지급률 미적용'));
  assert.equal(
    await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  // Close through the shared dialog control before the next scenario.
  await admin.evaluate(() => document.querySelector('#modal').close());
  await admin.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    'PASS: mobile fixed-fee registration, admin amendment, remaining count and payroll labels.',
  );
}
async function extendedScenario(admin, browser) {
  async function checked(page, route, method = 'GET', body) {
    const r = await request(page, route, method, body);
    assert.equal(r.status, 200, route + ' ' + JSON.stringify(r.body));
    return r.body;
  }
  const month = '2026-09';
  const mixed = await checked(admin, '/people', 'POST', {
    name: '겸용 선생님',
    profile: 'mixed',
    hireMonth: '2026-01',
  });
  await navigate(admin, 'people');
  await admin.locator('#new-account').click();
  await admin.locator('[name=username]').fill('pilates02');
  assert.equal(await admin.locator('[name=username]').evaluate((el) => el.checkValidity()), true);
  await admin.locator('[name=personId]').selectOption(mixed.id);
  assert.equal(await admin.locator('#unlinked-admin-name').isHidden(), true);
  await admin.locator('[name=password]').fill('0471');
  await clickSubmit(admin);
  await closed(admin);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('[name=username]').fill('pilates02');
  await page.locator('[name=password]').fill('0471');
  await page.locator('#login-form button[type=submit]').click();
  await page.waitForSelector('#password-form');
  await page.locator('[name=currentPassword]').fill('0471');
  await page.locator('[name=password]').fill('0839');
  await page.locator('[name=confirm]').fill('0839');
  await page.locator('#password-form button[type=submit]').click();
  await page.waitForSelector('#month');
  for (const p of [admin, page]) {
    await p.locator('#month').fill(month);
    await p.locator('#month').dispatchEvent('change');
  }
  const contracts = [];
  for (const [name, amount] of [
    ['듀엣 하나', '1100000'],
    ['듀엣 둘', '2200000'],
  ]) {
    await navigate(page, 'members');
    await checked(admin, '/registrations', 'POST', {
      name,
      personId: mixed.id,
      paidDate: month + '-01',
      startDate: month + '-01',
      amount: Number(amount),
      quantity: 10,
      category: 'pilates',
      saleType: 'new',
      vatIncluded: true,
    });
    await navigate(page, 'members');
    assert.equal(await page.locator('#new-registration, [data-renew]').count(), 0);
    const member = (await checked(page, '/members?q=' + encodeURIComponent(name))).items[0];
    const contract = (await checked(page, '/members/' + member.id)).contracts[0];
    assert.equal(contract.amount, Math.round(Number(amount) / 1.1));
    contracts.push({ member, contract });
  }
  await navigate(admin, 'groups');
  await admin.locator('#new-group-rate').click();
  await admin.locator('[name=personId]').selectOption(mixed.id);
  await admin.locator('[name=name]').fill('그룹 필라테스');
  await admin.locator('[name=effectiveDate]').fill(month + '-01');
  await admin.locator('[name=hourlyRate]').fill('35000');
  await admin.locator('[name=billableMinutes]').fill('60');
  await admin.locator('[name=reason]').fill('시간당 계약');
  await clickSubmit(admin);
  await closed(admin);
  await navigate(page, 'groups');
  await page.locator('#new-group-lesson').click();
  await page.locator('[name=date]').fill(month + '-20');
  await page.locator('[name=date]').dispatchEvent('change');
  await page.locator('[name=time]').fill('18:00');
  assert.match(await page.locator('#group-fee-preview').innerText(), /17,500.*50%/);
  await page.locator('[name=participants]').fill('1');
  assert.match(await page.locator('#group-fee-preview').innerText(), /35,000.*100%/);
  await page.locator('[name=participants]').fill('5');
  await clickSubmit(page);
  await closed(page);
  assert.match(await page.locator('#app').textContent(), /35,000/);
  await page.locator('[data-group-edit]').click();
  await page.locator('[name=participants]').fill('15');
  await page.locator('[name=reason]').fill('출석 인원 확인');
  await clickSubmit(page);
  await closed(page);
  await navigate(page, 'lessons');
  await page.locator('#new-duet').click();
  for (const [prefix, entry] of [
    ['first', contracts[0]],
    ['second', contracts[1]],
  ]) {
    await page.locator('[name=' + prefix + 'Member]').selectOption(entry.member.id);
    await page.locator('[name=' + prefix + 'Contract]').selectOption(entry.contract.id);
  }
  await page.locator('[name=date]').fill(month + '-21');
  await page.locator('[name=time]').fill('13:00');
  await clickSubmit(page);
  await page.waitForSelector('[data-duet-sign]');
  for (let index = 0; index < 2; index++) {
    if (index) {
      await navigate(page, 'lessons');
      await page.locator('[data-duet]').first().click();
      await page.waitForSelector('[data-duet-sign]');
    }
    await page.locator('[data-duet-sign]').nth(index).click();
    await page.waitForSelector('#sign-pad');
    await page.locator('#confirm-sign').check();
    await draw(page, ctx);
    await page.locator('#save-sign').click();
    await page.waitForFunction(() =>
      document.querySelector('.member-intro')?.textContent.includes('저장 완료'),
    );
    await page.locator('#show-return').click();
    assert.equal(await page.locator('#return-form').count(), 0);
    await page.waitForFunction(() => document.querySelector('#member-screen').hidden);
  }
  const pay = await checked(page, '/payroll/' + mixed.id + '?month=' + month);
  assert.equal(pay.revenue, 3000000);
  assert.equal(pay.lessons, 1);
  assert.equal(pay.duetLessons, 1);
  assert.equal(pay.memberSessions, 2);
  assert.equal(pay.commission, 90000);
  assert.equal(pay.groupCommission, 35000);
  assert.equal(pay.gross, 1125000);
  assert.equal(pay.unconfirmed, 0);
  await navigate(admin, 'dashboard');
  await admin.locator('#membership-record').click();
  await admin.locator('[name=amount]').fill('22000000');
  await clickSubmit(admin);
  await closed(admin);
  let totals = await checked(admin, '/sales/summary?month=' + month);
  assert.equal(totals.membership, 20000000);
  assert.equal(totals.centerNet, 53000000);
  await admin.locator('#membership-record').click();
  await admin.locator('[name=amount]').fill('33000000');
  await clickSubmit(admin);
  await closed(admin);
  totals = await checked(admin, '/sales/summary?month=' + month);
  assert.equal(totals.membership, 30000000);
  assert.equal(totals.centerNet, 63000000);
  for (const [name, profile, base] of [
    ['미화 시간급', 'part', 13000],
    ['미화 일급', 'daily', 40000],
  ]) {
    const p = await checked(admin, '/people', 'POST', {
      name,
      profile,
      base,
      taxBps: 0,
      hireMonth: '2026-01',
    });
    await navigate(admin, 'people');
    await admin.locator('[data-compensation="' + p.id + '"]').click();
    if (profile === 'part') {
      await admin.locator('[name=workHours]').fill('2');
      await admin.locator('[name=workMinutes]').fill('30');
    } else await admin.locator('[name=hours]').fill('3');
    await admin.locator('[name=note]').fill('근무 확인');
    await clickSubmit(admin);
    await closed(admin);
    assert.equal(
      (await checked(admin, '/payroll/' + p.id + '?month=' + month)).base,
      profile === 'part' ? 32500 : 120000,
    );
  }
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await navigate(page, 'payroll');
  await page.locator('.trainer-rate').waitFor();
  const actualPayroll = await checked(page, '/payroll/' + mixed.id + '?month=' + month);
  assert.ok(
    (await page.locator('.trainer-group-total').innerText()).includes(
      new Intl.NumberFormat('ko-KR').format(actualPayroll.groupCommission),
    ),
  );
  assert.equal(await page.locator('.mobile-nav').isVisible(), false);
  if (reportMode)
    await page.screenshot({ path: path.join(out, 'trainer-group-payroll.png'), fullPage: false });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    '320px personal payroll',
  );
  const submitBox = await page.locator('#trainer-open-submit').boundingBox();
  assert.ok(submitBox.y + submitBox.height <= 740, 'submit stays inside mobile viewport');
  await ctx.close();
  console.log(
    'PASS: alphanumeric employee issuance, VAT supply, duet pair/signatures, fixed group wage, monthly membership replacement, 2h30 hourly and daily wage UI.',
  );
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : existsSync('/usr/bin/chromium')
        ? { executablePath: '/usr/bin/chromium' }
        : {}),
    args: ['--no-sandbox'],
  });
  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
  admin.on('pageerror', (e) => errors.push(e.message));
  await admin.goto(url);
  if (process.argv.includes('--firebase'))
    await admin.locator('[name=setupToken]').fill('browser-test-setup');
  await admin.locator('[name=name]').fill('가상 관리자');
  await admin.locator('[name=username]').fill('admin01');
  await admin.locator('[name=password]').fill(adminPw);
  await admin.locator('[name=confirm]').fill(adminPw);
  await admin.locator('#login-form button').click();
  await admin.waitForSelector('[data-view=people]');
  await admin.locator('#month').fill('2026-10');
  await admin.locator('#month').dispatchEvent('change');
  await navigate(admin, 'people');
  await admin.locator('#new-person').click();
  await admin.locator('[name=name]').fill('가상 민준쌤');
  await admin.locator('[name=profile]').selectOption('morning');
  await admin.locator('[name=hireMonth]').fill('2026-09');
  await clickSubmit(admin);
  await closed(admin);
  await navigate(admin, 'members');
  await admin.locator('#bulk-import').click();
  const header =
      '회원번호\t회원명\t담당\t등록번호\t등록일\t결제일\t공급가액\t등록횟수\t기진행횟수\t기준일',
    rows = Array.from({ length: 10 }, (_, i) =>
      [
        'M' + (i + 1),
        '가상 회원' + String(i + 1).padStart(2, '0'),
        '가상 민준쌤',
        'C' + (i + 1),
        '2026-09-01',
        '2026-09-01',
        '3000000',
        '30',
        '4',
        '2026-10-01',
      ].join('\t'),
    );
  await admin.locator('[name=text]').fill(header + '\n' + rows.join('\n'));
  await clickSubmit(admin);
  await admin.waitForSelector('#modal-form table');
  await snap(
    admin,
    '1. 기존 회원 10명 일괄 등록',
    '회원번호·등록번호가 있는 엑셀 셀을 붙여넣고 오류·중복을 미리 확인합니다. 같은 이름을 자동 병합하지 않고, 재입력한 등록번호는 중복에서 제외합니다.',
  );
  await clickSubmit(admin);
  await closed(admin);
  assert.equal(await admin.locator('.member-card').count(), 10);
  await snap(
    admin,
    '2. 한 선생님에게 기존 회원 10명 배정',
    '관리자가 한 번 옮기면 선생님은 기존 회원을 다시 입력할 필요가 없습니다. 회원별 잔여횟수와 별도 회원권을 유지합니다.',
  );
  await navigate(admin, 'people');
  await admin.locator('#new-account').click();
  await admin.locator('[name=username]').fill('trainer01');
  const pid = await admin.locator('[name=personId] option').nth(1).getAttribute('value');
  await admin.locator('[name=personId]').selectOption(pid);
  await admin.locator('[name=password]').fill(temp);
  await clickSubmit(admin);
  await closed(admin);
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'ko-KR',
    }),
    teacher = await context.newPage();
  teacher.on('pageerror', (e) => errors.push(e.message));
  await teacher.goto(url);
  await teacher.locator('[name=username]').fill('trainer01');
  await teacher.locator('[name=password]').fill(temp);
  await teacher.locator('#login-form button').click();
  await teacher.waitForSelector('#password-form');
  await teacher.locator('[name=currentPassword]').fill(temp);
  await teacher.locator('[name=password]').fill(teacherPw);
  await teacher.locator('[name=confirm]').fill(teacherPw);
  await teacher.locator('#password-form button').click();
  await teacher.waitForSelector('#month');
  await teacher.locator('#month').fill('2026-10');
  await teacher.locator('#month').dispatchEvent('change');
  await navigate(teacher, 'members');
  await teacher.waitForSelector('.member-card');
  assert.equal(await teacher.locator('[data-view=people]').count(), 0);
  assert.equal(await teacher.locator('.member-card').count(), 10);
  assert.equal(await teacher.locator('[data-delete-lesson]').count(), 0);
  assert.equal(await teacher.locator('#new-registration, [data-renew]').count(), 0);
  const seeded = await request(admin, '/registrations', 'POST', {
    name: '가상 신규회원',
    personId: pid,
    paidDate: '2026-10-02',
    startDate: '2026-10-02',
    amount: 3000000,
    quantity: 30,
    category: 'pt',
    saleType: 'new',
    vatIncluded: false,
  });
  assert.equal(seeded.status, 200);
  await navigate(teacher, 'members');
  await teacher.waitForSelector('.member-card:nth-child(11)');
  await snap(
    teacher,
    '3. 반영된 PT 회원 선택',
    '검증용 추가 회원 자료를 관리자 API로 준비했습니다. 선생님은 회원권·결제를 다시 입력하지 않고 담당 회원을 선택합니다.',
  );
  const firstMember = (await request(admin, '/members?q=' + encodeURIComponent('가상 회원01'))).body
    .items[0];
  const updated = await request(admin, '/registrations', 'POST', {
    memberId: firstMember.id,
    paidDate: '2026-10-03',
    startDate: '2026-10-03',
    amount: 2000000,
    quantity: 20,
    category: 'pt',
    saleType: 'renew',
    vatIncluded: false,
  });
  assert.equal(updated.status, 200);
  await navigate(teacher, 'members');
  assert.equal(await teacher.locator('.member-card').count(), 11);
  await snap(
    teacher,
    '4. 잔여·정산 기준 유지',
    '다짐에서 제공된 추가 수업 기준도 같은 회원에 연결합니다. 선생님 화면에는 추가 결제 입력 동선이 없습니다.',
  );
  if (firebaseMode) {
    const beforeMember = (await request(teacher, '/members?q=' + encodeURIComponent('가상 회원01')))
      .body.items[0];
    const beforePay = (await request(teacher, '/payroll/' + pid + '?month=2026-10')).body;
    for (const back of ['button', 'browser']) {
      await navigate(teacher, 'members');
      const card = teacher
        .locator('.member-card')
        .filter({ has: teacher.getByRole('heading', { name: '가상 회원01', exact: true }) });
      await card.locator('[data-complete]').click();
      await teacher.locator('[name=date]').fill('2026-10-07');
      await teacher.locator('[name=time]').fill('10:00');
      await clickSubmit(teacher);
      await teacher.waitForSelector('#sign-pad');
      assert.equal(await teacher.locator('#return-form').count(), 0);
      const blocked = await request(teacher, '/lessons?month=2026-10');
      assert.equal(blocked.status, 403);
      if (back === 'button') await teacher.locator('#show-return').click();
      else await teacher.goBack();
      await teacher.waitForFunction(() => document.querySelector('#member-screen').hidden);
      await teacher.locator('.view-dashboard').waitFor();
      const afterMember = (
        await request(teacher, '/members?q=' + encodeURIComponent('가상 회원01'))
      ).body.items[0];
      const afterPay = (await request(teacher, '/payroll/' + pid + '?month=2026-10')).body;
      assert.equal(afterMember.remaining, beforeMember.remaining);
      assert.equal(afterPay.commission, beforePay.commission);
      assert.equal(afterPay.lessons, beforePay.lessons);
    }
    console.log(
      'PASS: unsigned preview exit and browser Back leave lessons, balances and payroll unchanged, without password.',
    );
  }
  await record(teacher, context, '가상 회원01', '2026-10-07', true);
  await record(teacher, context, '가상 신규회원', '2026-10-08');
  await navigate(teacher, 'payroll');
  assert.match(await teacher.locator('.trainer-net').textContent(), /580,200/);
  assert.equal(await teacher.locator('#trainer-open-submit').isVisible(), true);
  if (reportMode)
    await teacher.screenshot({
      path: path.join(out, 'trainer-payroll-final.png'),
      fullPage: false,
    });
  const source = (member, date, status) =>
    '2026.10.' +
    date +
    '(목) 10:00 ~ 10:50 P.T수업 PT 가상 민준쌤 개인 avatar ' +
    member +
    ' ' +
    status +
    ' 변경 010-0000-0000 1:1 PT 30회';
  await navigate(admin, 'source');
  await admin.locator('#source-import').click();
  await admin
    .locator('[name=text]')
    .fill(
      source('가상 회원01', '07', '출석') +
        '\n' +
        source('가상 신규회원', '08', '결석') +
        '\n' +
        source('가상 회원02', '09', '출석'),
    );
  await clickSubmit(admin);
  await admin.waitForSelector('#modal-form table');
  await clickSubmit(admin);
  await closed(admin);
  await snap(
    admin,
    '8. 월말 다짐 복사·붙여넣기 대조',
    '회원01은 날짜·시간이 일치합니다. 신규회원은 앱에 서명 수업이 있지만 다짐은 결석, 회원02는 다짐에만 출석이 있어 확인할 항목으로 표시됩니다. 원본 전화번호는 저장하지 않습니다.',
  );
  await record(teacher, context, '가상 회원02', '2026-10-09');
  await snap(
    teacher,
    '9. 누락 수업을 과거 날짜로 추가·서명',
    '실제 진행을 확인한 뒤 회원02의 10월 9일 수업을 나중에 기록했습니다. 수업일은 9일, 서명 시각은 실제 저장일입니다. 기존 수업이 있으면 중복으로 추가하지 않습니다.',
  );
  await navigate(teacher, 'payroll');
  await teacher.locator('[data-payroll]:visible').click();
  await teacher.waitForSelector('#modal .statement');
  assert.match(await teacher.locator('#modal').textContent(), /628,550/);
  await snap(
    teacher,
    '10. 직원이 월말 내역 확인 후 제출',
    '총 3회 × 회당 5만원 = 수업료 15만원. 기본급 50만원을 더한 지급총액 65만원에서 3.3%를 뺀 실지급 예상은 628,550원입니다. 직원이 확인 완료·제출합니다.',
  );
  await teacher.locator('#modal-x').click();
  await teacher.locator('#trainer-open-submit').click();
  await teacher.locator('[name=note]').fill('가상 수업·서명 내역 확인');
  await clickSubmit(teacher);
  await closed(teacher);
  await admin.locator('#refresh').click();
  await admin.waitForSelector('[data-review]');
  const mismatch = admin.locator('[data-review]').first();
  await mismatch.click();
  await admin
    .locator('[name=note]')
    .fill('가상 회원 서명과 실제 수업 확인, 다짐 출입 출석 누락 확인');
  await clickSubmit(admin);
  await closed(admin);
  await navigate(admin, 'payroll');
  await admin.locator('[data-payroll]:visible').click();
  await admin.locator('#approve-payroll').click();
  await admin.locator('[name=note]').fill('수업·서명 3건과 다짐 대조 확인');
  await clickSubmit(admin);
  await closed(admin);
  await admin.locator('#period-action').click();
  await admin.locator('[name=note]').fill('가상 월말 정산 마감');
  await clickSubmit(admin);
  await closed(admin);
  assert.match(await admin.locator('.notice').textContent(), /마감된/);
  await snap(
    admin,
    '11. 관리자 승인 → 월 마감',
    '관리자가 불일치 사유를 기록하고 제출된 정산을 승인한 뒤 월을 마감합니다. 금액·기준·수업·거래 근거를 고정하며, 이후 조건을 바꿔도 과거 확정 금액은 그대로입니다.',
  );
  const before = await request(admin, '/payroll?month=2026-10');
  assert.equal(before.body.items[0].net, 628550);
  const currentMembers = await request(admin, '/members?q=' + encodeURIComponent('가상 회원01')),
    detail = await request(admin, '/members/' + currentMembers.body.items[0].id);
  const correction = await request(admin, '/lessons', 'POST', {
    contractId: detail.body.contracts[0].id,
    date: '2026-10-09',
    time: '11:00',
  });
  assert.equal(correction.status, 409);
  const base = await request(admin, '/people/' + pid + '/terms', 'PUT', {
    month: '2026-11',
    version: 0,
    base: 600000,
    taxBps: 330,
    reason: '다음 달 기본급 변경',
  });
  assert.equal(base.status, 200);
  const fixed = await request(admin, '/payroll?month=2026-10');
  assert.equal(fixed.body.items[0].net, 628550);
  assert.equal(fixed.body.items[0].frozen, true);
  const audit = await request(admin, '/audit');
  assert.ok(audit.body.items.some((x) => x.action === 'close'));
  await navigate(admin, 'audit');
  await snap(
    admin,
    '12. 감사 이력과 정정 절차',
    '누가 언제 등록·서명·검수·제출·승인·마감을 했는지 기록합니다. 마감 후 정정하려면 관리자가 사유와 함께 마감을 해제해야 하며, 이전 확정 명세는 삭제하지 않습니다.',
  );
  await teacher.reload();
  await teacher.waitForSelector('#month');
  assert.equal(await teacher.locator('[data-view=source]').count(), 0);
  const pwa = await admin.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return fetch('/manifest.webmanifest').then((r) => r.json());
  });
  assert.equal(pwa.display, 'standalone');
  const cachesList = await admin.evaluate(async () => {
    const all = [];
    for (const key of await caches.keys())
      for (const req of await (await caches.open(key)).keys()) all.push(new URL(req.url).pathname);
    return all;
  });
  assert.ok(!cachesList.some((p) => p.startsWith('/api/')));
  assert.deepEqual(errors, []);
  if (reportMode) {
    const images = await Promise.all(
      steps.map(async (s) => ({
        ...s,
        img: 'data:image/png;base64,' + (await readFile(path.join(out, s.file))).toString('base64'),
      })),
    );
    const css =
      "body{font:15px/1.9 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5b426b;background:#f5f1fa;margin:0}main{max-width:1080px;margin:auto;padding:35px 22px}h1{font-size:29px;line-height:1.5}section{background:white;padding:26px;border:1px solid #e6dcef;border-radius:14px;margin:24px 0}h2{font-size:20px}p{font-size:13px;color:#9d81af}img{display:block;max-width:100%;max-height:850px;margin:20px auto 0;border:1px solid #ebdff3;border-radius:10px}.note{background:#ece3f8;padding:18px;border-radius:9px;font-size:12px;color:#8b67a4}@media print{body{background:white}main{padding:0}section{break-before:page;border:0;padding:0}img{max-height:210mm;object-fit:contain;object-position:top}p{font-size:12px}@page{size:A4;margin:13mm}}";
    const html =
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>더블와이짐 · 장기 운영 버전 시뮬레이션</title><style>' +
      css +
      '</style></head><body><main><small>DOUBLE Y · OPERATION WORKFLOW</small><h1>회원 10명 선생님의<br>신규·추가 결제부터 월말 마감까지</h1><div class="note">가상 회원·계정·손글씨로 새 앱을 실제 조작했습니다. 운영 데이터나 Firebase 배포 자료가 아닙니다. 아래는 실시간 앱이 아닌 시뮬레이션 기록입니다.</div>' +
      images
        .map(
          (s) =>
            '<section><h2>' +
            s.title +
            '</h2><p>' +
            s.text +
            '</p><img src="' +
            s.img +
            '" alt="' +
            s.title +
            '"></section>',
        )
        .join('') +
      (firebaseMode
        ? '<section><h2>Firebase 검증 범위</h2><p>Firebase Authentication·Firestore 에뮬레이터에 실제로 저장하고 화면을 조작했습니다. 실제 운영 프로젝트 배포 자료는 아닙니다. 계정·회원·계약·수업·서명·정산은 개별 문서입니다. 실사용 전 실제 프로젝트·HTTPS 배포·관리형 예약 백업과 현장 기기 검증이 필요합니다.</p><p>손글씨는 수업 확인 기록이며 회원 휴대폰 본인 인증은 포함하지 않습니다.</p></section></main></body></html>'
        : '<section><h2>운영 범위</h2><p>SQLite 로컬 서버 검증 자료입니다. 외부 배포는 수행하지 않았습니다.</p></section></main></body></html>');
    await writeFile(path.join(out, '장기운영_실제화면_시뮬레이션.html'), html);
    const report = await browser.newPage();
    await report.setContent(html, { waitUntil: 'load' });
    await report.emulateMedia({ media: 'print' });
    await report.pdf({
      path: path.join(out, '장기운영_실제화면_시뮬레이션.pdf'),
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    await writeFile(
      path.join(out, 'verified.json'),
      JSON.stringify(
        {
          storage: firebaseMode ? 'firestore-emulator' : 'sqlite',
          members: 11,
          contracts: 12,
          lessons: 3,
          gross: 650000,
          tax: 21450,
          net: 628550,
          closed: true,
          steps: steps.map((s) => ({ title: s.title, file: s.file })),
        },
        null,
        2,
      ),
    );
  }
  await navigate(admin, 'dashboard');
  await admin.waitForSelector('.priority-panel');
  if (reportMode)
    await admin.screenshot({ path: path.join(out, 'admin-home.png'), fullPage: true });
  await navigate(teacher, 'dashboard');
  await teacher.waitForSelector('.recent-lesson');
  assert.match(await teacher.locator('.recent-lesson').first().textContent(), /10.09/);
  await teacher.locator('#menu-toggle').click();
  assert.equal(await teacher.locator('.sidebar').evaluate((el) => el.inert), false);
  await teacher.keyboard.press('Escape');
  assert.equal(await teacher.locator('.sidebar').evaluate((el) => el.inert), true);
  assert.equal(
    await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await teacher.setViewportSize({ width: 320, height: 740 });
  assert.equal(
    await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    '320px home',
  );
  await teacher.setViewportSize({ width: 390, height: 844 });

  const navButtons = await teacher.locator('.mobile-nav button').evaluateAll((buttons) =>
    buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, bottom: r.bottom };
    }),
  );
  assert.equal(navButtons.length, 4);
  assert.ok(
    navButtons.every((b) => Math.abs(b.y - navButtons[0].y) < 2 && b.bottom <= 844),
    'home navigation is one visible row: ' +
      JSON.stringify({
        navButtons,
        viewport: await teacher.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          nav: {
            display: getComputedStyle(document.querySelector('.mobile-nav')).display,
            direction: getComputedStyle(document.querySelector('.mobile-nav')).flexDirection,
            rect: document.querySelector('.mobile-nav').getBoundingClientRect().toJSON(),
          },
        })),
      }),
  );
  assert.ok(navButtons[3].x > navButtons[0].x, 'home navigation spans the screen');
  if (reportMode)
    await teacher.screenshot({ path: path.join(out, 'trainer-home-final.png'), fullPage: false });
  assert.equal(errors.length, 0, errors.join('\n'));
  if (firebaseMode && process.argv.includes('--delete-lesson')) await deleteLessonScenario(admin);
  if (firebaseMode && process.argv.includes('--fixed-fee')) await fixedFeeScenario(admin);
  if (firebaseMode && process.argv.includes('--classes')) await extendedScenario(admin, browser);
  if (firebaseMode && process.argv.includes('--representative'))
    await representativeScenario(admin, browser);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 10-member import, new/renewal, private mobile signing/server lock, late lesson, reconciliation, employee submit/admin approval/month close, frozen payout, audit, PWA cache policy.',
  );
} finally {
  await browser?.close();
  await new Promise((r) => app.server.close(r));
  await rm(dir, { recursive: true, force: true });
}
