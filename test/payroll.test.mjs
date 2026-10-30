import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { payroll, addContract, addMember, addLesson, addPerson } from '../lib/domain.mjs';
import { addSale } from '../lib/workflow.mjs';
test('오전파트 경계 지급률 및 공급가 기준 수업료·세액', async () => {
  const f = await fixture();
  try {
    for (const [amount, expected] of [
      [3999999, 35],
      [4000000, 40],
      [4999999, 40],
      [5000000, 50],
    ]) {
      f.s.run('UPDATE sales SET amount=? WHERE contract_id=?', amount, f.c.id);
      f.s.run('UPDATE contracts SET amount=? WHERE id=?', amount, f.c.id);
      if (!f.s.one('SELECT id FROM lessons LIMIT 1'))
        addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-05', time: '10:00' });
      const r = payroll(f.s, f.p, '2026-10');
      assert.equal(r.rate, expected);
      assert.equal(r.commission, Math.round(((amount / 50) * expected) / 100));
      assert.equal(r.net, r.gross - Math.floor((r.gross * 330) / 10000));
    }
  } finally {
    await f.close();
  }
});
test('추가 결제는 기존 회원과 분리된 계약·잔여를 유지', async () => {
  const f = await fixture();
  try {
    f.s.run('UPDATE contracts SET paid_date=?,carry_used=? WHERE id=?', '2026-09-01', 10, f.c.id);
    f.s.run('UPDATE sales SET date=? WHERE contract_id=?', '2026-09-01', f.c.id);
    const c = addContract(f.s, f.user, {
      memberId: f.m.id,
      paidDate: '2026-10-01',
      amount: 2000000,
      quantity: 20,
      category: 'pt',
      saleType: 'renew',
    });
    assert.equal(f.s.one('SELECT count(*) n FROM members').n, 1);
    assert.equal(f.s.one('SELECT count(*) n FROM contracts').n, 2);
    addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-05', time: '10:00' });
    assert.equal(f.s.one('SELECT count(*) n FROM lessons WHERE contract_id=?', c.id).n, 0);
    assert.equal(payroll(f.s, f.p, '2026-10').renewSales, 2000000);
  } finally {
    await f.close();
  }
});
test('일반 구간 추가 성과금과 입사 초기 겸용 보장', async () => {
  const f = await fixture('standard');
  try {
    for (const [amount, bonus] of [
      [9999999, 0],
      [10000000, 200000],
      [12000000, 400000],
      [14000000, 600000],
    ]) {
      f.s.run('UPDATE sales SET amount=?', amount);
      assert.equal(payroll(f.s, f.p, '2026-10').bonus, bonus);
    }
    f.s.run("UPDATE people SET profile='mixed',hire_month='2026-09' WHERE id=?", f.p.id);
    f.p = f.s.one('SELECT * FROM people WHERE id=?', f.p.id);
    const { setTerms } = await import('../lib/workflow.mjs');
    setTerms(f.s, f.a, f.p.id, {
      month: '2026-09',
      version: 0,
      profile: 'mixed',
      base: 1000000,
      taxBps: 330,
      reason: '가상 겸용 강사 조건',
    });
    f.s.run('UPDATE sales SET amount=1000000');
    assert.equal(payroll(f.s, f.p, '2026-10').rate, 45);
    assert.equal(payroll(f.s, f.p, '2026-11').rate, 30);
  } finally {
    await f.close();
  }
});
test('팀/센터 성과급과 환불·이전 판매분 환불 제외', async () => {
  const f = await fixture('manager');
  try {
    f.s.run('UPDATE sales SET amount=10000000');
    addSale(f.s, f.a, {
      date: '2026-10-02',
      category: 'membership',
      kind: 'sale',
      amount: 80000000,
      note: '가상 매출',
    });
    const original = f.s.one("SELECT * FROM sales WHERE category='membership'");
    addSale(f.s, f.a, {
      date: '2026-10-03',
      category: 'membership',
      kind: 'refund',
      amount: 1000000,
      originalId: original.id,
      legacyRefund: true,
      note: '이전 판매 환불',
    });
    assert.equal(payroll(f.s, f.p, '2026-10').incentive, 2000000);
    assert.throws(
      () =>
        addSale(f.s, f.a, {
          date: '2026-10-04',
          category: 'membership',
          kind: 'refund',
          amount: 80000000,
          originalId: original.id,
          note: '초과 환불',
        }),
      (e) => e.status === 400,
    );
  } finally {
    await f.close();
  }
});
test('직원·시급 알바 월별 입력과 VAT 포함 변환', async () => {
  const f = await fixture();
  try {
    const p = addPerson(f.s, f.a, {
      name: '가상 알바',
      profile: 'part',
      hireMonth: '2026-01',
      base: 12000,
      taxBps: 0,
    });
    f.s.run(
      'INSERT INTO monthly_inputs(person_id,month,hours100,extra,deduction,note) VALUES(?,?,?,?,?,?)',
      p.id,
      '2026-10',
      8000,
      20000,
      10000,
      '가상 근무',
    );
    assert.equal(payroll(f.s, p, '2026-10').net, 970000);
    assert.equal(payroll(f.s, p, '2026-11').net, 0);
    const m = addMember(f.s, f.user, { name: 'VAT 회원' });
    const c = addContract(f.s, f.user, {
      memberId: m.id,
      paidDate: '2026-10-04',
      amount: 5500000,
      quantity: 50,
      vatIncluded: true,
      category: 'pt',
      saleType: 'new',
    });
    assert.equal(c.amount, 5000000);
  } finally {
    await f.close();
  }
});
