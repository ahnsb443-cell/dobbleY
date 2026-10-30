import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
const reportMode = process.argv.includes('--report'),
  out = path.resolve(process.env.REPORT_DIR || 'reports/long-term-simulation'),
  dir = await mkdtemp(path.join(tmpdir(), 'dy-browser-')),
  app = await createApp({ dataDir: dir });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + app.server.address().port;
let browser;
const pw = () => randomBytes(20).toString('hex'),
  adminPw = pw(),
  temp = pw(),
  teacherPw = pw(),
  steps = [],
  errors = [];
if (reportMode) await mkdir(out, { recursive: true });
async function snap(page, title, text) {
  if (!reportMode) return;
  await page.evaluate(() => document.activeElement?.blur());
  const file = String(steps.length + 1).padStart(2, '0') + '.png';
  await page.screenshot({ path: path.join(out, file), fullPage: false });
  steps.push({ title, text, file });
}
async function clickSubmit(page) {
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
  await page.locator('#return-form [name=password]').fill(teacherPw);
  await page.locator('#return-form button').click();
  await page.waitForFunction(() => document.querySelector('#member-screen').hidden);
}
async function record(page, context, name, date, capture = false) {
  await page.locator('[data-view=members]').first().click();
  await page.waitForSelector('.member-card');
  const card = page
    .locator('.member-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.locator('[data-complete]').click();
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
      '회원·날짜·시간·회차·잔여횟수와 서명 원본 해시를 개별 저장합니다. 교사 비밀번호로 복귀하며, 서명 원본은 일반 API에서 변경·삭제하지 못합니다.',
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
  await admin.locator('[name=name]').fill('가상 관리자');
  await admin.locator('[name=username]').fill('demo.admin');
  await admin.locator('[name=password]').fill(adminPw);
  await admin.locator('[name=confirm]').fill(adminPw);
  await admin.locator('#login-form button').click();
  await admin.waitForSelector('[data-view=people]');
  await admin.locator('#month').fill('2026-10');
  await admin.locator('#month').dispatchEvent('change');
  await admin.locator('[data-view=people]').first().click();
  await admin.locator('#new-person').click();
  await admin.locator('[name=name]').fill('가상 민준쌤');
  await admin.locator('[name=profile]').selectOption('morning');
  await admin.locator('[name=hireMonth]').fill('2026-09');
  await clickSubmit(admin);
  await closed(admin);
  await admin.locator('[data-view=members]').first().click();
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
  await admin.locator('[data-view=people]').first().click();
  await admin.locator('#new-account').click();
  await admin.locator('[name=username]').fill('demo.teacher');
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
  await teacher.locator('[name=username]').fill('demo.teacher');
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
  await teacher.locator('[data-view=members]').first().click();
  await teacher.waitForSelector('.member-card');
  assert.equal(await teacher.locator('[data-view=people]').count(), 0);
  assert.equal(await teacher.locator('.member-card').count(), 10);
  await teacher.locator('#new-registration').click();
  await teacher.locator('[name=name]').fill('가상 신규회원');
  await teacher.locator('[name=paidDate]').fill('2026-10-02');
  await teacher.locator('[name=startDate]').fill('2026-10-02');
  await teacher.locator('[name=amount]').fill('3000000');
  await teacher.locator('[name=quantity]').fill('30');
  await snap(
    teacher,
    '3. 신규 회원 1명 등록',
    '신규 회원만 이름을 입력합니다. 공급가액 300만원·30회를 저장하면 회원 11명, 월 신규 매출 300만원이 됩니다. 회원 생성과 계약·매출은 한 트랜잭션으로 저장됩니다.',
  );
  await clickSubmit(teacher);
  await closed(teacher);
  assert.equal(await teacher.locator('.member-card').count(), 11);
  const first = teacher
    .locator('.member-card')
    .filter({ has: teacher.getByRole('heading', { name: '가상 회원01', exact: true }) });
  await first.locator('[data-renew]').click();
  await teacher.locator('[name=paidDate]').fill('2026-10-03');
  await teacher.locator('[name=startDate]').fill('2026-10-03');
  await teacher.locator('[name=amount]').fill('2000000');
  await teacher.locator('[name=quantity]').fill('20');
  await snap(
    teacher,
    '4. 기존 회원 추가 결제',
    '회원01을 선택해 200만원·20회권을 추가합니다. 회원 수는 11명 그대로이며 기존 30회권 잔여와 새 20회권을 섞지 않습니다. 월 신규+추가 매출 500만원으로 오전파트 50%가 적용됩니다.',
  );
  await clickSubmit(teacher);
  await closed(teacher);
  assert.equal(await teacher.locator('.member-card').count(), 11);
  await record(teacher, context, '가상 회원01', '2026-10-07', true);
  await record(teacher, context, '가상 신규회원', '2026-10-08');
  await teacher.locator('[data-view=payroll]').first().click();
  assert.match(await teacher.locator('table').textContent(), /580,200/);
  const source = (member, date, status) =>
    '2026.10.' +
    date +
    '(목) 10:00 ~ 10:50 P.T수업 PT 가상 민준쌤 개인 avatar ' +
    member +
    ' ' +
    status +
    ' 변경 010-0000-0000 1:1 PT 30회';
  await admin.locator('[data-view=source]').first().click();
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
  await teacher.locator('[data-view=payroll]').first().click();
  await teacher.locator('[data-payroll]').click();
  await teacher.waitForSelector('#modal .statement');
  assert.match(await teacher.locator('#modal').textContent(), /628,550/);
  await snap(
    teacher,
    '10. 직원이 월말 내역 확인 후 제출',
    '총 3회 × 회당 5만원 = 수업료 15만원. 기본급 50만원을 더한 지급총액 65만원에서 3.3%를 뺀 실지급 예상은 628,550원입니다. 직원이 확인 완료·제출합니다.',
  );
  await teacher.locator('#submit-payroll').click();
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
  await admin.locator('[data-view=payroll]').first().click();
  await admin.locator('[data-payroll]').click();
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
  await admin.locator('[data-view=audit]').first().click();
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
      '<section><h2>운영 범위</h2><p>여러 PC와 폰이 하나의 Node 서버와 영속 SQLite DB에 접속합니다. 회원·계약·수업·서명·정산은 개별 테이블이며 전체 JSON 4MB 누적 제한을 없앴습니다. 자동 Firebase 연결이나 외부 배포는 수행하지 않았습니다.</p><p>원본 서명은 손글씨 수업 확인 기록입니다. 회원 휴대폰 본인 인증·공인 인증서 전자서명은 아닙니다. 실사용 전 HTTPS·백업·복구·보관 정책·운영 서버 연결을 구성해야 합니다.</p></section></main></body></html>';
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
  console.log(
    'PASS: 10-member import, new/renewal, private mobile signing/server lock, late lesson, reconciliation, employee submit/admin approval/month close, frozen payout, audit, PWA cache policy.',
  );
} finally {
  await browser?.close();
  await new Promise((r) => app.server.close(r));
  await rm(dir, { recursive: true, force: true });
}
