import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const screens =
  process.env.GUIDE_SCREEN_DIR || path.resolve(root, '../artifacts/dobbley-guide/screens');
const artifacts = path.resolve(root, '../artifacts/dobbley-guide');
await mkdir(artifacts, { recursive: true });
async function shot(name, caption) {
  const data = await readFile(path.join(screens, name + '.png'));
  return `<figure><img src="data:image/png;base64,${data.toString('base64')}" alt="${caption}"><figcaption>${caption}</figcaption></figure>`;
}
const footer =
  '<footer>DOUBLE Y GYM · 언주역점 | 선생님용 이용 가이드 · 2026.11.02 <span>화면의 회원·계정·서명은 모두 가상 예시입니다.</span></footer>';
const pair = async (a, b) => `<div class="screens">${await shot(...a)}${await shot(...b)}</div>`;
const pages = [];
pages.push(
  `<section><div class="eyebrow">DOUBLE Y GYM · EONJU</div><h1>선생님 이용 가이드</h1><p class="lead">예약은 다짐에서,<br>상품별 사인지와 급여 확인은 이 앱에서.</p><div class="flow"><b>① 다짐 수업 예약</b><i>→</i><b>② 회원·상품 선택</b><i>→</i><b>③ 수업 후 회원 서명</b><i>→</i><b>④ 잔여·정산 반영</b></div><div class="cover"><div>${await shot('03-home', '실제 앱의 선생님 홈 화면')}</div><div><h2>하루 사용 순서</h2><ol><li>기존처럼 <strong>다짐 CRM에서 수업을 예약</strong>합니다.</li><li>수업이 끝나면 이 앱에서 회원과 <strong>차감할 상품</strong>을 선택합니다.</li><li>날짜·시간·회차를 확인한 뒤 회원에게 서명을 받습니다.</li><li><strong>확인 · 서명 저장</strong>을 누르면 잔여와 정산에 반영됩니다.</li><li>저장 완료 안내 뒤 <strong>1.5초 후 자동으로 홈</strong>으로 돌아옵니다.</li></ol><div class="callout">신규·추가 등록은 결제 완료 건만.<br>추가 상품은 종이 사인지를 새로 만드는 것처럼<br><strong>같은 회원 안에 새 상품 서명지</strong>가 생깁니다.</div><p class="small">접속 주소<br><a href="https://dobbley-gym-payroll.web.app">dobbley-gym-payroll.web.app</a></p></div></div>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">01 · 시작하기</div><h2>로그인과 휴대폰 홈 화면에 저장</h2><p>관리자에게 받은 아이디와 임시 비밀번호로 로그인합니다. 처음 접속하면 본인 비밀번호로 변경합니다. 아이디는 이메일이 아닐 수 있습니다.</p>${await pair(['01-login', '관리자에게 받은 아이디·비밀번호로 로그인'], ['02-first-password', '최초 1회 본인 비밀번호로 변경'])}<div class="columns"><div><h3>삼성 갤럭시</h3><p><strong>Chrome</strong>에서 접속 → 오른쪽 위 ⋮ → <strong>홈 화면에 추가 / 앱 설치</strong>. Samsung Internet에서는 ☰ → <strong>현재 페이지 추가 → 홈 화면</strong>을 찾습니다. 기종에 따라 문구가 다를 수 있습니다.</p></div><div><h3>업데이트와 계정</h3><p>업데이트 안내를 받으면 앱을 새로고침하거나 닫았다 다시 엽니다. 비밀번호는 본인만 사용합니다. 서명 저장이나 선생님 화면 복귀 때는 비밀번호를 다시 입력하지 않습니다.</p></div></div>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">02 · 결제 완료 신규 회원</div><h2>회원 → 신규 회원 등록</h2><p>이미 등록된 회원은 새로 만들지 말고 다음 장의 <strong>추가 상품</strong>을 사용합니다. 선생님이 신규 등록하면 본인 담당 회원으로 저장됩니다.</p>${await pair(['04-new-member', '회원 이름·수업 구분·결제일·시작일 입력'], ['05-paid-confirm', '횟수·결제금액 입력 후 결제 완료 확인 → 등록 저장'])}<div class="callout"><strong>결제 완료 확인 전에는 저장할 수 없습니다.</strong> 이름, 결제일, 수업 시작일, 등록 횟수, 총 결제금액을 실제 결제 내용대로 입력합니다. 총 결제금액은 <strong>부가세 포함</strong>으로 입력하며 앱이 공급가로 환산합니다.</div><p class="small">예시: 결제금액 1,100,000원 / 10회 → 공급가액 1,000,000원 / 회당 공급단가 100,000원. 등록 저장만으로 수업을 차감하거나 회원 서명을 생성하지 않습니다. 회원·상품 잔여·신규 매출과 정산 기준이 반영됩니다.</p>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">03 · 재등록 / 추가 상품</div><h2>같은 회원 안에 새 사인지를 만듭니다</h2><p>회원 카드의 <strong>＋ 추가 상품</strong> 또는 <strong>잔여 · 정산 기준 → 추가 상품 등록</strong>을 누릅니다. 새 상품의 결제일·시작일·횟수·결제금액을 입력하고 결제 완료를 확인해 저장합니다.</p>${await pair(['06-add-product', '기존 회원에게 새 상품을 추가 등록'], ['07-new-sign-sheet', '새 상품은 별도 서명지로 시작'])}<div class="callout"><strong>기존 잔여 9회 + 새 상품 20회 = 전체 잔여 29회</strong><br>기존 상품의 9회와 단가·서명은 그대로 남습니다. 새 20회는 새 상품의 단가로 관리됩니다. 회원을 두 명으로 중복 등록하지 않습니다.</div><p class="small">회원의 ‘잔여 · 정산 기준’에서 상품별 횟수·단가를 확인합니다. 표를 좌우로 이동하면 <strong>서명 목록 / 수업 체크·서명</strong> 버튼이 보입니다. ‘서명 목록’이 상품별 사인지입니다. 추가 결제는 재등록 매출로 집계됩니다.</p>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">04 · 수업 체크와 회원 서명</div><h2>다짐 예약 후, 실제 수업의 서명은 여기서</h2><p>회원의 <strong>PT 수업 체크 · 서명</strong>을 누르거나, 해당 상품의 <strong>수업 체크·서명</strong>을 누릅니다. 상품 서명지에서 시작하면 그 상품이 선택됩니다.</p>${await pair(['08-select-product', '차감할 상품·실제 수업 날짜·시작 시간 확인'], ['09-member-sign', '회원이 날짜·회차·잔여를 보고 확인란 체크와 서명'])}<ol class="compact"><li>기존 상품과 추가 상품 중 <strong>이번 수업에서 사용할 상품</strong>을 고릅니다.</li><li>날짜는 실제 수업 날짜, 회차는 그 상품의 진행 순서입니다. 날짜와 회차를 혼동하지 않습니다.</li><li>회원에게 폰을 건네 서명을 받고 <strong>확인 · 서명 저장</strong>을 누릅니다.</li></ol><div class="callout">그림만 그리거나 확인란만 체크해도 저장되지 않습니다.<br><strong>저장 없이 홈으로 돌아가기 / 뒤로가기 = 기록·차감·정산 반영 없음.</strong></div>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">05 · 저장 결과 확인</div><h2>완료 안내 → 자동 홈 복귀 → 상품별 기록</h2><p>저장 성공 시 <strong>서명 저장 완료</strong> 안내가 잠깐 나오고 자동으로 홈으로 돌아갑니다. 선생님 비밀번호를 다시 입력할 필요가 없습니다.</p>${await pair(['10-saved', '저장 성공 후 1.5초 동안 완료 안내'], ['11-product-history', '선택한 상품의 회차별 서명 목록'])}<div class="columns"><div><h3>무엇이 반영되나요?</h3><p>해당 상품 잔여 1회가 차감되고, 해당 수업료가 정산에 반영됩니다. 새 상품에서 1회 진행하면 예시의 새 잔여는 19회, 기존 잔여는 9회 그대로입니다.</p></div><div><h3>잘못 저장했다면</h3><p>관리자에게 회원·상품·수업 날짜와 시간을 알려 삭제 또는 정정을 요청합니다. 관리자가 삭제하면 잔여와 정산이 복구됩니다. 기존 서명 이력은 보존됩니다.</p></div></div><p class="small">오류가 뜨면 성공 안내를 확인하기 전까지 저장된 것으로 판단하지 않습니다. 네트워크를 확인하고 ‘저장 상태 다시 확인’을 사용합니다. 승인·마감된 수업의 변경은 관리자 확인이 필요합니다.</p>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">06 · 노쇼와 그룹수업</div><h2>예외 상황도 실제 내용대로 기록</h2>${await pair(['13-no-show', '회원 불참: 노쇼 선택 후 처리 확인 → 노쇼 저장'], ['14-group-half-pay', '그룹수업: 참여인원 0명은 50%로 미리보기'])}<div class="columns"><div><h3>개인 수업 노쇼</h3><p>서명 화면의 <strong>노쇼 (회원 불참)</strong>를 체크합니다. 회원 서명 없이 처리 확인 후 저장합니다. <strong>잔여 1회 차감·수업료 정상 지급</strong>이며, 서명대기와 다짐 출석 대조 경고에서 제외됩니다. 체크만 하고 나오면 반영되지 않습니다.</p></div><div><h3>그룹수업</h3><p>그룹레슨의 ‘내 수업 선택’에서 본인에게 배정된 수업을 고르고 날짜·시간·실제 참여인원을 기록합니다. 다른 선생님의 단가는 표시되지 않습니다. <strong>0명은 정상 수업료의 50%, 1명 이상은 100%</strong>입니다. 정상 35,000원 수업이면 0명은 17,500원입니다. 단가가 없으면 관리자에게 설정을 요청합니다.</p></div></div><p class="small">듀엣은 두 회원 상품을 연결해 기록하고 서명은 각 회원에게 따로 받습니다. 두 회원 모두 자기 상품에서 1회씩 차감됩니다.</p>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">07 · 내 페이롤 / 월말 확인</div><h2>매출·수업·계약 조건을 함께 확인하세요</h2><div class="cover"><div>${await shot('12-payroll', '월 선택 → 개인·그룹 수업료와 예상 정산 확인')}</div><div><h3>월말 확인 순서</h3><ol><li>정산 월을 선택합니다.</li><li>누락 수업·서명·노쇼와 상품별 잔여를 확인합니다.</li><li>신규·추가 결제금액, 적용 요율, 그룹수업, 기본급·추가 수당·세금·공제를 확인합니다.</li><li><strong>월말 확인 · 제출</strong>을 누릅니다.</li><li>관리자 승인·마감 후에는 확정 금액을 확인합니다.</li></ol><h3>PT 공통 개인 매출 성과금</h3><p>부가세 제외 개인 월 매출 기준입니다. PT팀장도 동일하게 적용됩니다.</p><table><tr><th>개인 매출</th><th>성과금</th></tr><tr><td>1,000만원</td><td>20만원</td></tr><tr><td>1,200만원</td><td>40만원</td></tr><tr><td>1,400만원</td><td>60만원</td></tr></table><p class="small">이후 200만원마다 20만원 추가. PT팀장 팀 매출 인센티브는 별도로 합산합니다. 보장 요율·고정 수업료는 각자 계약 조건과 적용 기간을 따릅니다.</p><h3>계약별 매출 인센티브</h3><p class="small"><strong>FC팀장</strong> 회원권 총매출 3,500만 / 4,000만 / 4,500만원부터 2% / 2.5% / 3%.<br><strong>PT팀장</strong> 본인 포함 PT팀 매출 3,000만 / 3,500만 / 4,000만원부터 2% / 2.5% / 3%. 총괄매니저 PT·개인/그룹 필라테스는 제외합니다.<br><strong>총괄매니저</strong> 센터 총매출 8,000만원까지 2%, 초과분만 4%. 모두 VAT 제외 기준입니다.</p></div></div><div class="callout"><strong>기억할 세 가지</strong> ① 예약은 다짐 ② 결제 완료 신규·추가 상품은 이 앱에 등록 ③ 수업 후 상품을 골라 서명 저장.<br>FC·급여 전용 구성원은 직책에 맞는 화면을 사용합니다. 내 회원만 보이는 것이 정상이며, 담당 변경·고정료 변경·오류 삭제는 관리자에게 요청합니다.</div>${footer}</section>`,
);
pages.push(
  `<section><div class="eyebrow">08 · 회원별로 한 번 더 확인</div><h2>내 페이롤 → 당월 회원별 서명 확인</h2><div class="cover"><div>${await shot('15-monthly-members', '정산 월의 기록이 회원별로 모여 표시됩니다.')}</div><div><h3>회원별 목록에서 확인</h3><ol><li>내 페이롤에서 정산할 월을 선택합니다.</li><li><strong>당월 회원별 서명 확인</strong>으로 내려갑니다.</li><li>회원 이름 아래의 <strong>서명 / 노쇼 / 확인 필요</strong> 건수를 확인합니다.</li><li>각 수업의 날짜·시간·회차·상품 시작일을 봅니다.</li><li><strong>서명 보기 → 이 서명 원본 보기</strong>를 눌러 저장된 회원 서명을 확인합니다.</li><li>확인을 마친 뒤 <strong>월말 확인 · 제출</strong>을 누릅니다.</li></ol><div class="callout">신규 상품과 추가 상품의 수업도 같은 회원 이름 아래 표시됩니다. 수업별 회차와 상품 시작일로 구분할 수 있습니다.</div><p>듀엣은 회원별로 표시되므로 ‘회원 확인 건수’와 실제 수업 횟수가 다를 수 있습니다. 노쇼는 별도 표시되며 서명 누락 건수에 포함하지 않습니다.</p><p class="small">확인 필요가 있거나 수업이 누락됐다면 해당 수업을 확인하고 필요 시 관리자에게 문의합니다. 이미 승인한 정산금은 유지하며, 서명 상태는 현재 기준으로 확인할 수 있습니다. 선생님은 본인 담당 수업만 조회합니다.</p></div></div>${footer}</section>`,
);
const html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>더블와이짐 언주역점 · 선생님 이용 가이드</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;color:#17191c;font-family:"Noto Sans CJK KR","Noto Sans CJK JP",sans-serif;font-size:13px;line-height:1.7;background:#e9eaec}section{position:relative;width:210mm;min-height:297mm;padding:13mm 14mm 15mm;margin:12px auto;background:white;break-after:page}section:last-child{break-after:auto}h1{font-size:34px;line-height:1.3;margin:9px 0}h2{font-size:24px;line-height:1.4;margin:8px 0 12px}h3{font-size:15px;margin:10px 0 4px}p{margin:8px 0}.eyebrow{color:#ff650d;font-size:11px;font-weight:700;letter-spacing:1px}.lead{font-size:20px;margin:16px 0}.flow{background:#fff1e5;border-radius:10px;padding:12px;display:flex;align-items:center;gap:8px;font-size:11px;margin:16px 0}.flow i{color:#ff650d}.cover{display:grid;grid-template-columns:.9fr 1.1fr;gap:15px;align-items:start}.cover figure img{max-height:560px}.screens{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:12px 0}figure{margin:0;text-align:center}figure img{display:block;margin:0 auto;width:auto;max-width:100%;height:auto;max-height:470px;border:1px solid #ddd;border-radius:12px}figcaption{font-size:10px;color:#666;margin:7px 0}.callout{background:#fff4e9;border-left:4px solid #ff650d;padding:12px;margin:12px 0;font-size:12px;line-height:1.8}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.small{font-size:10.5px;color:#555}ol{padding-left:20px}li{margin:5px 0}ol.compact{font-size:12px}.compact li{margin:2px 0}footer{position:absolute;left:14mm;right:14mm;bottom:7mm;border-top:1px solid #ddd;padding-top:6px;font-size:8px;color:#777;display:flex;justify-content:space-between}a{color:#e85b00}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}th{background:#fff4e9}@media print{body{background:white}section{margin:0;height:297mm;min-height:0;overflow:hidden}}@media screen and (max-width:820px){body{background:white}section{width:100%;min-height:0;padding:20px;margin:0;border-bottom:1px solid #ddd}footer{position:static;margin-top:20px;display:block}.cover,.screens,.columns{grid-template-columns:1fr}.screens img{max-height:none;width:min(100%,390px)}.flow{flex-wrap:wrap}}
</style></head><body>${pages.join('')}</body></html>`;
await writeFile(path.join(root, 'public/trainer-guide.html'), html);
const browser = await chromium.launch({
  headless: true,
  ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
  const overflow = await page
    .locator('section')
    .evaluateAll((xs) =>
      xs
        .map((x, i) => ({ page: i + 1, overflow: x.scrollHeight > x.clientHeight + 2 }))
        .filter((x) => x.overflow),
    );
  if (overflow.length) throw Error('Guide page overflow: ' + JSON.stringify(overflow));
  await page.pdf({
    path: path.join(root, 'public/trainer-guide.pdf'),
    printBackground: true,
    preferCSSPageSize: true,
  });
} finally {
  await browser.close();
}
await copyFile(
  path.join(root, 'public/trainer-guide.pdf'),
  path.join(artifacts, '더블와이짐_선생님_이용가이드.pdf'),
);
await copyFile(
  path.join(root, 'public/trainer-guide.html'),
  path.join(artifacts, '더블와이짐_선생님_이용가이드.html'),
);
console.log('Built 9-page trainer guide from actual simulated app screenshots.');
