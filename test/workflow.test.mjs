import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { payrollAction, periodAction, setRule, setTerms, setInputs } from '../lib/workflow.mjs';
import { result, addLesson, addContract, changeLesson } from '../lib/domain.mjs';
test('제출·반려·예외 승인·마감·재개와 확정 스냅샷 보존', async () => {
  const f = await fixture();
  try {
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-05', time: '10:00' });
    let r = payrollAction(f.s, f.user, f.p.id, '2026-10', {
      action: 'submit',
      version: 0,
      note: '기록 확인',
    });
    assert.equal(r.state, 'submitted');
    assert.throws(
      () => addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-06', time: '10:00' }),
      (e) => e.status === 409,
    );
    assert.throws(
      () => payrollAction(f.s, f.a, f.p.id, '2026-10', { action: 'approve', version: r.version }),
      (e) => e.status === 400,
    );
    r = payrollAction(f.s, f.a, f.p.id, '2026-10', {
      action: 'approve',
      version: r.version,
      note: '가상 서명/다짐 별도 증빙 확인',
    });
    const net = r.net;
    assert.ok(r.frozen);
    const closed = periodAction(f.s, f.a, '2026-10', {
      action: 'close',
      version: 0,
      note: '검수 완료',
    });
    assert.equal(closed.state, 'closed');
    assert.throws(
      () =>
        changeLesson(f.s, f.a, l.id, {
          version: 1,
          date: '2026-10-06',
          time: '10:00',
          reason: '정정',
        }),
      (e) => e.status === 409,
    );
    assert.throws(
      () =>
        setTerms(f.s, f.a, f.p.id, {
          month: '2026-10',
          version: 0,
          base: 900000,
          taxBps: 330,
          reason: '조건 정정',
        }),
      (e) => e.status === 409,
    );
    setTerms(f.s, f.a, f.p.id, {
      month: '2026-11',
      version: 0,
      base: 900000,
      taxBps: 330,
      reason: '다음 달 조건',
    });
    assert.equal(result(f.s, f.a, f.p.id, '2026-10').net, net);
    const history = f.s.one('SELECT count(*) n FROM payroll_versions').n;
    periodAction(f.s, f.a, '2026-10', {
      action: 'reopen',
      version: closed.version,
      note: '추가 수업 증빙 접수',
    });
    assert.equal(result(f.s, f.a, f.p.id, '2026-10').state, 'draft');
    assert.equal(f.s.one('SELECT count(*) n FROM payroll_versions').n, history);
    assert.throws(() => f.s.run('DELETE FROM payroll_versions'), /immutable/);
    assert.throws(() => f.s.run('DELETE FROM audit'), /immutable/);
  } finally {
    await f.close();
  }
});
test('날짜 이동은 원래 월과 이동 월 모두 검사, 다른 직원 수정 충돌 없음', async () => {
  const f = await fixture();
  try {
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-05', time: '10:00' });
    f.s.run("INSERT INTO periods(month,state) VALUES('2026-09','closed')");
    assert.throws(() =>
      changeLesson(f.s, f.a, l.id, {
        version: 1,
        date: '2026-09-29',
        time: '10:00',
        reason: '월 이동',
      }),
    );
    const changed = changeLesson(f.s, f.user, l.id, {
      version: 1,
      date: '2026-10-06',
      time: '10:00',
      reason: '정정',
    });
    assert.equal(changed.version, 2);
    assert.throws(
      () =>
        changeLesson(f.s, f.user, l.id, {
          version: 1,
          date: '2026-10-07',
          time: '10:00',
          reason: '충돌',
        }),
      (e) => e.status === 409,
    );
  } finally {
    await f.close();
  }
});
test('마감 전 승인값도 설정 변경으로 바꾸지 못함', async () => {
  const f = await fixture();
  try {
    payrollAction(f.s, f.user, f.p.id, '2026-10', { action: 'submit', version: 0 });
    payrollAction(f.s, f.a, f.p.id, '2026-10', {
      action: 'approve',
      version: 1,
      note: '예외 확인',
    });
    assert.throws(
      () =>
        setRule(f.s, f.a, {
          profile: 'morning',
          month: '2026-10',
          version: 0,
          tiers: [[0, 100]],
          reason: '변경',
        }),
      (e) => e.status === 409,
    );
    assert.throws(
      () =>
        setInputs(f.s, f.a, f.p.id, '2026-10', {
          version: 0,
          hours100: 0,
          extra: 100000,
          deduction: 0,
          note: '수정',
        }),
      (e) => e.status === 409,
    );
  } finally {
    await f.close();
  }
});
test('직책 변경도 적용 월별 조건으로 보존하며 종료 직원의 미래 급여를 제외', async () => {
  const f = await fixture();
  try {
    setTerms(f.s, f.a, f.p.id, {
      month: '2026-10',
      version: 0,
      profile: 'lead',
      base: 1200000,
      taxBps: 330,
      reason: '팀장 승격',
    });
    assert.equal(result(f.s, f.a, f.p.id, '2026-09').profile, 'morning');
    assert.equal(result(f.s, f.a, f.p.id, '2026-10').profile, 'lead');
    const { endEmployment } = await import('../lib/workflow.mjs');
    endEmployment(f.s, f.a, f.p.id, {
      version: 1,
      endDate: '2026-10-29',
      reason: '가상 계약 종료',
    });
    assert.throws(
      () => result(f.s, f.a, f.p.id, '2026-11'),
      (e) => e.status === 404,
    );
    assert.equal(result(f.s, f.a, f.p.id, '2026-10').base, 1200000);
  } finally {
    await f.close();
  }
});
test('담당 인수인계는 이전 매출·수업·서명을 보존하고 잔여 계약만 새 담당에게', async () => {
  const f = await fixture();
  try {
    const { addPerson, signatureState, snapshot, signLesson } = await import('../lib/domain.mjs'),
      { transferMember } = await import('../lib/workflow.mjs'),
      { strokes } = await import('./helpers.mjs');
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-05', time: '10:00' });
    signLesson(f.s, f.user, l.id, {
      version: 1,
      snapshot: snapshot(f.s, l.id),
      confirmed: true,
      strokes,
    });
    const target = addPerson(f.s, f.a, {
      name: '새 담당',
      profile: 'standard',
      hireMonth: '2026-01',
    });
    transferMember(f.s, f.a, f.m.id, {
      version: 1,
      personId: target.id,
      effectiveDate: '2026-10-06',
      reason: '가상 인수인계',
    });
    assert.equal(f.s.one('SELECT person_id FROM lessons WHERE id=?', l.id).person_id, f.p.id);
    assert.equal(
      f.s.one('SELECT person_id FROM contracts WHERE id=?', f.c.id).person_id,
      target.id,
    );
    assert.equal(signatureState(f.s, l.id).state, 'signed');
    assert.equal(
      f.s.one('SELECT person_id FROM sales WHERE contract_id=?', f.c.id).person_id,
      f.p.id,
    );
    assert.throws(
      () => addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' }),
      (e) => e.status === 403,
    );
  } finally {
    await f.close();
  }
});
test('마감 후 누락 서명을 받아도 확정 금액과 당시 경고는 보존', async () => {
  const f = await fixture();
  try {
    const { snapshot, signLesson } = await import('../lib/domain.mjs'),
      { strokes } = await import('./helpers.mjs');
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' });
    payrollAction(f.s, f.user, f.p.id, '2026-10', { action: 'submit', version: 0 });
    payrollAction(f.s, f.a, f.p.id, '2026-10', {
      action: 'approve',
      version: 1,
      note: '가상 별도 서면 확인, 서명 추후 수령',
    });
    periodAction(f.s, f.a, '2026-10', {
      action: 'close',
      version: 0,
      note: '별도 증빙 승인 후 마감',
    });
    const original = result(f.s, f.a, f.p.id, '2026-10');
    assert.equal(original.warning.unconfirmed, 1);
    signLesson(f.s, f.user, l.id, {
      version: 1,
      snapshot: snapshot(f.s, l.id),
      confirmed: true,
      strokes,
    });
    const after = result(f.s, f.a, f.p.id, '2026-10');
    assert.equal(after.net, original.net);
    assert.equal(after.currentUnconfirmed, 0);
    assert.equal(after.warning.unconfirmed, 1);
  } finally {
    await f.close();
  }
});
