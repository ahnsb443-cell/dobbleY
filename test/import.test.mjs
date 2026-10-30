import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { memberImportPreview, importMembers, importHeader } from '../lib/import.mjs';
import { parseSource, importSource, reconcile, review } from '../lib/daygym.mjs';
import { addLesson, payroll } from '../lib/domain.mjs';
const block = (name, day, status = '출석') =>
  '2026.10.' +
  day +
  '(목)\n10:00 ~ 10:50\nP.T수업\nPT\n가상 강사\n개인\navatar\n' +
  name +
  '\n' +
  status +
  '\n' +
  (status === '예약완료' ? '예약취소' : '변경') +
  '\n010-0000-0000\n1:1 PT 50회';
test('엑셀 셀 일괄 등록: 10명 및 재입력 중복 방지·동명이인 분리', async () => {
  const f = await fixture();
  try {
    const rows = Array.from({ length: 10 }, (_, i) =>
      [
        'M' + i,
        '회원' + (i < 2 ? '동명이인' : i),
        '가상 강사',
        'C' + i,
        '2026-09-01',
        '2026-09-01',
        '3000000',
        '30',
        '4',
        '2026-10-01',
      ].join('\t'),
    );
    const input = importHeader + '\n' + rows.join('\n');
    assert.equal(memberImportPreview(f.s, f.a, { text: input }).errors.length, 0);
    const out = f.s.tx(() => importMembers(f.s, f.a, { text: input }));
    assert.equal(out.members, 10);
    assert.equal(out.contracts, 10);
    assert.equal(f.s.one("SELECT count(*) n FROM members WHERE name='회원동명이인'").n, 2);
    const repeat = importMembers(f.s, f.a, { text: input });
    assert.equal(repeat.duplicates, 10);
    assert.equal(repeat.contracts, 0);
  } finally {
    await f.close();
  }
});
test('다짐 200건·예약취소 버튼·전화번호 제외·중복·상태 변경 명시 선택', async () => {
  const f = await fixture();
  try {
    const input = Array.from({ length: 200 }, (_, i) =>
        block(
          '가상회원' + i,
          String((i % 20) + 1).padStart(2, '0'),
          i % 4 === 0 ? '예약완료' : i % 4 === 1 ? '결석' : '출석',
        ),
      ).join('\n'),
      parsed = parseSource(input);
    assert.equal(parsed.rows.length, 200);
    assert.equal(parsed.rows.filter((r) => r.state === 'reserved').length, 50);
    assert.equal(parsed.rows.filter((r) => r.state === 'attended').length, 100);
    assert.ok(!JSON.stringify(parsed.rows).includes('010-'));
    const out = importSource(f.s, f.a, { text: input });
    assert.equal(out.count, 200);
    assert.equal(importSource(f.s, f.a, { text: input }).count, 0);
    const changed = block('가상회원0', '01', '출석');
    assert.equal(importSource(f.s, f.a, { text: changed }).count, 0);
    const slot = parseSource(changed).rows[0].slot;
    assert.equal(importSource(f.s, f.a, { text: changed, updates: [slot] }).count, 1);
  } finally {
    await f.close();
  }
});
test('다짐 대조는 금액 불변·검수는 데이터 버전 변경 시 다시 확인', async () => {
  const f = await fixture();
  try {
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' }),
      before = payroll(f.s, f.p, '2026-10').net;
    importSource(f.s, f.a, { text: block('가상 회원', '07', '결석') });
    let r = reconcile(f.s, '2026-10')[0];
    assert.equal(r.kind, 'payroll-absent');
    review(f.s, f.a, {
      month: '2026-10',
      key: r.key,
      fingerprint: r.fingerprint,
      note: '가상 종이 서명 대조',
    });
    assert.equal(reconcile(f.s, '2026-10')[0].reviewed, true);
    const update = block('가상 회원', '07', '출석');
    importSource(f.s, f.a, { text: update, updates: [parseSource(update).rows[0].slot] });
    r = reconcile(f.s, '2026-10')[0];
    assert.equal(r.kind, 'matched');
    assert.equal(r.reviewed, false);
    assert.equal(payroll(f.s, f.p, '2026-10').net, before);
  } finally {
    await f.close();
  }
});
test('잘린 예약·잘못된 날짜·중복 상충 상태는 오류 노출', () => {
  assert.ok(parseSource('아무 내용').errors.length);
  assert.ok(parseSource(block('가상 회원', '32', '출석')).errors.length);
  const result = parseSource(
    block('가상 회원', '01', '출석') + '\n' + block('가상 회원', '01', '결석'),
  );
  assert.equal(result.rows.length, 1);
  assert.ok(result.errors.length);
});
