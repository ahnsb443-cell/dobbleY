import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { services, Store, atomic } from '../firebase/store.mjs';
import * as d from '../firebase/domain.mjs';
import * as c from '../firebase/classes.mjs';
import * as w from '../firebase/workflow.mjs';
import { strokes } from './helpers.mjs';
const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
test(
  '직책별 인센티브·월 멤버십 합계·듀엣·그룹·시간급 실제 Firestore 계산',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T09:00:00Z') });
    const svc = services('demo-classes-' + randomBytes(4).toString('hex')),
      a = { id: 'admin', role: 'admin', display_name: '검증 관리자' },
      run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db),
      m = '2026-11';
    const people = {};
    for (const [key, profile, base] of [
      ['lead', 'lead', 1200000],
      ['trainer', 'standard', 1000000],
      ['mixed', 'mixed', 1000000],
      ['manager', 'manager', 3000000],
      ['fc', 'fc', 2500000],
      ['night', 'part', 12000],
      ['clean', 'part', 13000],
      ['day', 'daily', 40000],
    ]) {
      people[key] = await run((s) =>
        d.addPerson(s, a, { name: key, profile, base, hireMonth: '2026-01' }),
      );
    }
    const employee = { id: 'teacher', role: 'employee', person_id: people.mixed.id };
    async function contract(pid, amount, quantity = 20, category = 'pt', vatIncluded = false) {
      return run(async (s) => {
        const member = await d.addMember(s, a, {
          name: '검증 ' + randomBytes(3).toString('hex'),
          personId: pid,
        });
        return d.addContract(s, a, {
          memberId: member.id,
          paidDate: m + '-01',
          startDate: m + '-01',
          amount,
          quantity,
          category,
          saleType: 'new',
          vatIncluded,
        });
      });
    }
    await contract(people.trainer.id, 30000000);
    await contract(people.mixed.id, 10000000);
    await contract(people.mixed.id, 4000000, 20, 'pilates');
    const managerContract = await contract(people.manager.id, 5500000, 10, 'pt', true);
    await run((s) =>
      d.addLesson(s, a, { contractId: managerContract.id, date: m + '-10', time: '14:00' }),
    );
    let groupOne, duet, duetSignature;
    await t.test(
      '월 합계는 개별 회원권 장부를 대체하며 PT팀은 필라테스·매니저 PT 제외',
      async () => {
        await run((s) =>
          w.addSale(s, a, {
            date: m + '-01',
            category: 'membership',
            kind: 'sale',
            amount: 1000000,
            note: '이전 개별 장부',
          }),
        );
        await run((s) =>
          w.setMembershipTotal(s, a, {
            month: m,
            version: 0,
            amount: 55000000,
            vatIncluded: true,
            note: '다짐 월 합계',
          }),
        );
        let totals = await d.salesTotals(read(), m);
        assert.equal(totals.membership, 50000000);
        assert.equal(totals.centerNet, 99000000);
        assert.equal(totals.pt, 40000000);
        assert.equal((await d.calculate(read(), people.lead, m)).incentive, 1200000);
        const manager = await d.calculate(read(), people.manager, m);
        assert.equal(manager.incentive, 2360000);
        assert.equal(manager.commission, 250000);
        assert.equal(manager.gross, 5610000);
        assert.equal((await d.calculate(read(), people.fc, m)).incentive, 1500000);
        await run((s) =>
          w.addSale(s, a, {
            date: '2026-10-01',
            category: 'pt',
            kind: 'sale',
            personId: people.trainer.id,
            amount: 30000000,
            note: '이전 기준',
          }),
        );
        await run((s) =>
          w.addSale(s, a, {
            date: '2026-10-01',
            category: 'pt',
            kind: 'sale',
            personId: people.manager.id,
            amount: 5000000,
            note: '이전 기준 매니저',
          }),
        );
        assert.equal((await d.salesTotals(read(), '2026-10')).pt, 35000000);

        assert.equal((await read().get('contracts', managerContract.id)).gross_amount, 5500000);
        await assert.rejects(
          run((s) =>
            w.setMembershipTotal(s, employee, {
              month: m,
              version: 1,
              amount: 1,
              vatIncluded: false,
              note: '권한',
            }),
          ),
          (e) => e.status === 403,
        );
        await assert.rejects(
          run((s) =>
            w.setMembershipTotal(s, a, {
              month: m,
              version: 0,
              amount: 1,
              vatIncluded: false,
              note: '충돌',
            }),
          ),
          (e) => e.status === 409,
        );
        await run((s) =>
          w.setMembershipTotal(s, a, {
            month: m,
            version: 1,
            amount: 66000000,
            vatIncluded: true,
            note: '수정된 다짐 합계',
          }),
        );
        assert.equal((await d.salesTotals(read(), m)).membership, 60000000);
        await run((s) =>
          w.setMembershipTotal(s, a, {
            month: m,
            version: 2,
            amount: 55000000,
            vatIncluded: true,
            note: '정확한 합계',
          }),
        );
      },
    );
    await t.test('그룹 단가는 관리자 설정, 참여인원과 무관하며 기존 기록 단가 보존', async () => {
      const rate = await run((s) =>
        c.createGroupRate(s, a, people.mixed.id, {
          name: '그룹 필라테스',
          effectiveDate: m + '-01',
          hourlyRate: 35000,
          billableMinutes: 60,
          reason: '계약',
        }),
      );
      await assert.rejects(
        run((s) =>
          c.createGroupRate(s, employee, people.mixed.id, {
            name: '임의',
            effectiveDate: m + '-01',
            hourlyRate: 1,
            billableMinutes: 60,
            reason: '변경',
          }),
        ),
        (e) => e.status === 403,
      );
      groupOne = await run((s) =>
        c.addGroupLesson(s, employee, {
          rateId: rate.id,
          date: m + '-10',
          time: '18:00',
          participants: 1,
        }),
      );
      const changed = await run((s) =>
        c.changeGroupLesson(s, employee, groupOne.id, {
          version: 1,
          participants: 25,
          reason: '인원 확인',
        }),
      );
      assert.equal(changed.amount, 35000);
      await assert.rejects(
        run((s) =>
          c.addGroupLesson(s, employee, {
            rateId: rate.id,
            date: m + '-11',
            time: '18:00',
            participants: 2,
            hourlyRate: 99999,
          }),
        ),
        (e) => e.status === 400,
      );
      const next = await run((s) =>
        c.createGroupRate(s, a, people.mixed.id, {
          name: '그룹 필라테스',
          effectiveDate: m + '-15',
          hourlyRate: 40000,
          billableMinutes: 60,
          reason: '단가 변경',
        }),
      );
      await assert.rejects(
        run((s) =>
          c.addGroupLesson(s, employee, {
            rateId: rate.id,
            date: m + '-20',
            time: '18:00',
            participants: 2,
          }),
        ),
        (e) => e.status === 409,
      );
      await run((s) =>
        c.addGroupLesson(s, employee, {
          rateId: next.id,
          date: m + '-20',
          time: '18:00',
          participants: 2,
        }),
      );
      const result = await d.calculate(read(), people.mixed, m);
      assert.equal(result.groupCommission, 75000);
      assert.equal(result.groupMinutes, 120);
      assert.equal((await read().get('group_lessons', groupOne.id)).hourly_rate, 35000);
      assert.equal(result.revenue, 14000000);
    });
    await t.test('듀엣 두 단가를 합친 뒤 반올림, 회원별 1회 차감·개별 서명·동시 정정', async () => {
      const first = await contract(people.mixed.id, 110000, 3, 'pilates', true),
        second = await contract(people.mixed.id, 220000, 7, 'pilates', true);
      duet = await run((s) =>
        c.addDuet(s, employee, {
          contractIds: [first.id, second.id],
          date: m + '-16',
          time: '13:00',
        }),
      );
      assert.equal((await d.progress(read(), first)).used, 1);
      assert.equal((await d.progress(read(), second)).used, 1);
      const calculated = await d.calculate(read(), people.mixed, m);
      assert.equal(calculated.rate, 50);
      assert.equal(calculated.lessons, 1);
      assert.equal(calculated.memberSessions, 2);
      assert.equal(calculated.commission, Math.round((100000 / 3 + 200000 / 7) * 0.5));
      assert.equal(calculated.commission, 30952);
      await assert.rejects(
        run((s) =>
          c.addDuet(s, employee, {
            contractIds: [first.id, second.id],
            date: m + '-16',
            time: '13:00',
          }),
        ),
        (e) => e.status === 409,
      );
      await assert.rejects(
        run((s) =>
          d.changeLesson(s, employee, duet.lesson_ids[0], {
            version: 1,
            date: m + '-17',
            reason: '한쪽 정정',
          }),
        ),
        (e) => e.status === 409,
      );
      const snap = await d.snapshot(read(), duet.lesson_ids[0]);
      assert.equal(snap.memberId, first.member_id);
      duetSignature = await run((s) =>
        d.signLesson(s, employee, duet.lesson_ids[0], {
          snapshot: snap,
          version: 1,
          confirmed: true,
          strokes,
        }),
      );
      await run((s) =>
        c.changeDuet(s, employee, duet.id, {
          version: 1,
          date: m + '-17',
          time: '13:00',
          reason: '두 회원 날짜 정정',
        }),
      );
      assert.equal(
        (await d.confirmation(read(), await read().get('lessons', duet.lesson_ids[0]))).state,
        'stale',
      );
      assert.ok(await read().get('signature_payloads', duetSignature.id));
      await assert.rejects(
        run((s) =>
          c.changeDuet(s, employee, duet.id, { version: 2, void: true, reason: '임의 취소' }),
        ),
        (e) => e.status === 403,
      );
      await run((s) =>
        c.changeDuet(s, a, duet.id, { version: 2, void: true, reason: '관리자 취소' }),
      );
      assert.equal((await d.progress(read(), first)).used, 0);
      assert.equal((await d.progress(read(), second)).used, 0);
      assert.ok(await read().get('signatures', duetSignature.id));
    });
    await t.test('야간·미화 2시간 30분, 분 단위 정확한 시급과 일급 근무일수 계산', async () => {
      for (const [key, expected] of [
        ['night', 30000],
        ['clean', 32500],
      ]) {
        await run((s) =>
          w.settings(s, a, 'inputs', people[key].id, {
            month: m,
            version: 0,
            hours100: 250,
            workMinutes: 150,
            extra: 0,
            deduction: 0,
            note: '2시간 30분',
          }),
        );
        assert.equal((await d.calculate(read(), people[key], m)).base, expected);
      }
      await run((s) =>
        w.settings(s, a, 'inputs', people.night.id, {
          month: m,
          version: 1,
          hours100: 217,
          workMinutes: 130,
          extra: 0,
          deduction: 0,
          note: '2시간 10분',
        }),
      );
      assert.equal((await d.calculate(read(), people.night, m)).base, 26000);
      await run((s) =>
        w.settings(s, a, 'inputs', people.day.id, {
          month: m,
          version: 0,
          hours100: 300,
          extra: 0,
          deduction: 0,
          note: '3일',
        }),
      );
      assert.equal((await d.calculate(read(), people.day, m)).base, 120000);
    });
    await t.test('제출·승인·월 마감 후 그룹 수업료와 월 멤버십 매출 변경 차단', async () => {
      await run((s) =>
        w.payrollAction(s, employee, people.mixed.id, m, { action: 'submit', version: 0 }),
      );
      await run((s) =>
        w.payrollAction(s, a, people.mixed.id, m, {
          action: 'approve',
          version: 1,
          note: '그룹수업 확인',
        }),
      );
      const frozen = await d.result(read(), a, people.mixed.id, m);
      await assert.rejects(
        run((s) =>
          c.changeGroupLesson(s, a, groupOne.id, { version: 2, hourlyRate: 1, reason: '차단' }),
        ),
        (e) => e.status === 409,
      );
      await assert.rejects(
        run((s) =>
          w.setMembershipTotal(s, a, {
            month: m,
            version: 3,
            amount: 1,
            vatIncluded: false,
            note: '차단',
          }),
        ),
        (e) => e.status === 409,
      );
      for (const p of Object.values(people).filter((p) => p.id !== people.mixed.id)) {
        await run((s) => w.payrollAction(s, a, p.id, m, { action: 'submit', version: 0 }));
        await run((s) =>
          w.payrollAction(s, a, p.id, m, { action: 'approve', version: 1, note: '가상 자료 검수' }),
        );
      }
      await run((s) => w.periodAction(s, a, m, { action: 'close', version: 0, note: '마감 검증' }));
      assert.equal((await d.result(read(), a, people.mixed.id, m)).net, frozen.net);
      const rates = await c.groupRates(read(), employee);
      await assert.rejects(
        run((s) =>
          c.addGroupLesson(s, employee, { rateId: rates[0].id, date: m + '-20', time: '19:00' }),
        ),
        (e) => e.status === 409,
      );
    });
    await t.test(
      '그룹 시간강사는 같은 구성원 ID로 다음 적용 월부터 개인·듀엣 겸용 전환',
      async () => {
        t.mock.timers.setTime(new Date('2026-12-01T09:00:00Z').getTime());
        const p = await run((s) =>
          d.addPerson(s, a, {
            name: '그룹 전담 선생님',
            profile: 'group',
            base: 0,
            hireMonth: '2026-12',
          }),
        );
        const user = { id: 'same-employee-account', role: 'employee', person_id: p.id };
        const rate = await run((s) =>
          c.createGroupRate(s, a, p.id, {
            name: '그룹 필라테스',
            effectiveDate: '2026-12-01',
            hourlyRate: 40000,
            billableMinutes: 60,
            reason: '그룹 계약',
          }),
        );
        await run((s) =>
          c.addGroupLesson(s, user, {
            rateId: rate.id,
            date: '2026-12-01',
            time: '10:00',
            participants: 7,
          }),
        );
        await assert.rejects(
          run((s) => d.addMember(s, user, { name: '아직 개인 수업 불가', personId: p.id })),
          (e) => e.status === 400,
        );
        await run((s) =>
          w.settings(s, a, 'terms', p.id, {
            month: '2027-01',
            profile: 'mixed',
            base: 1000000,
            taxBps: 330,
            version: 0,
            reason: '개인레슨 겸용 시작',
          }),
        );
        assert.equal((await d.person(read(), user, p.id, '2026-12')).profile, 'group');
        assert.equal((await d.person(read(), user, p.id, '2027-01')).profile, 'mixed');
        assert.equal((await d.calculate(read(), p, '2026-12')).groupCommission, 40000);
        t.mock.timers.setTime(new Date('2027-01-01T09:00:00Z').getTime());
        const member = await run((s) =>
          d.addMember(s, user, { name: '같은 계정 개인 회원', personId: p.id }),
        );
        assert.equal(member.person_id, user.person_id);
        assert.equal((await c.groupRates(read(), user)).length, 1);
      },
    );
  },
);

test(
  '회원권 고정 수업료: 비율 독립·듀엣·이관·권한·확정 보호',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const imp = await import('../firebase/imports.mjs');
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T09:00:00Z') });
    const svc = services('demo-fixed-' + randomBytes(4).toString('hex'));
    const a = { id: 'admin', role: 'admin', display_name: '검증 관리자' };
    const run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const p = await run((s) =>
      d.addPerson(s, a, { name: '고정 검증', profile: 'standard', hireMonth: '2026-01' }),
    );
    const employee = { id: 'employee', role: 'employee', person_id: p.id };
    const add = (fixedFee, amount = 0) =>
      run(async (s) => {
        const member = await d.addMember(s, a, {
          name: randomBytes(5).toString('hex'),
          personId: p.id,
        });
        return d.addContract(s, a, {
          memberId: member.id,
          paidDate: '2026-11-01',
          quantity: 10,
          amount,
          category: 'pt',
          saleType: 'new',
          fixedFee,
        });
      });
    for (const value of [0, -1, 1.5, '20000', 1000001])
      await assert.rejects(add(value), /고정 수업료/);
    const fixed = await add(20000);
    const regular = await add(null, 660000);
    const lesson = await run((s) =>
      d.addLesson(s, employee, { contractId: fixed.id, date: '2026-11-10', time: '10:00' }),
    );
    const before = await d.calculate(read(), p, '2026-11');
    assert.equal(before.rate, 30);
    assert.equal(before.commission, 20000);
    assert.equal(before.lines[0].fixedFee, 20000);
    assert.equal((await d.progress(read(), fixed)).remaining, 9);
    await add(null, 8000000); // Changes the monthly percentage but never the fixed payment.
    const raised = await d.calculate(read(), p, '2026-11');
    assert.equal(raised.rate, 50);
    assert.equal(raised.lines.find((l) => l.lessonId === lesson.id).unit, 20000);
    const duet = await run((s) =>
      c.addDuet(s, employee, {
        contractIds: [fixed.id, regular.id],
        date: '2026-11-11',
        time: '10:00',
      }),
    );
    let pay = await d.calculate(read(), p, '2026-11');
    assert.equal(
      pay.lines.filter((l) => l.sessionId === duet.id).reduce((n, l) => n + l.unit, 0),
      53000,
    );
    const secondFixed = await add(20000);
    const both = await run((s) =>
      c.addDuet(s, employee, {
        contractIds: [fixed.id, secondFixed.id],
        date: '2026-11-12',
        time: '10:00',
      }),
    );
    pay = await d.calculate(read(), p, '2026-11');
    assert.equal(
      pay.lines.filter((l) => l.sessionId === both.id).reduce((n, l) => n + l.unit, 0),
      40000,
    );
    assert.equal((await d.progress(read(), fixed)).remaining, 7);
    await assert.rejects(
      run((s) =>
        d.setContractFee(s, employee, fixed.id, {
          version: 1,
          fixedFee: 30000,
          reason: '직원 변경',
        }),
      ),
      /관리자/,
    );
    await assert.rejects(
      run((s) =>
        d.addContract(s, employee, {
          memberId: fixed.member_id,
          paidDate: '2026-11-01',
          quantity: 10,
          amount: 0,
          category: 'pt',
          saleType: 'renew',
          fixedFee: 20000,
        }),
      ),
      /관리자/,
    );
    await assert.rejects(
      run((s) =>
        d.setContractFee(s, a, fixed.id, { version: 99, fixedFee: 30000, reason: '충돌' }),
      ),
      /변경/,
    );
    await assert.rejects(
      run((s) => d.setContractFee(s, a, fixed.id, { version: 1, fixedFee: 30000, reason: '' })),
      /사유/,
    );
    const changed = await run((s) =>
      d.setContractFee(s, a, regular.id, {
        version: 1,
        fixedFee: 20000,
        reason: '기존 회원권 조건 정정',
      }),
    );
    assert.equal(changed.fixed_fee, 20000);
    assert.equal(
      (await d.calculate(read(), p, '2026-11')).lines.find((l) => l.contractId === regular.id).unit,
      20000,
    );
    await run((s) =>
      d.setContractFee(s, a, regular.id, { version: 2, fixedFee: null, reason: '비율제 복귀' }),
    );
    assert.equal(
      (await d.calculate(read(), p, '2026-11')).lines.find((l) => l.contractId === regular.id).unit,
      33000,
    );
    assert.equal((await read().query('audit', [['action', '==', 'contract-fee']])).length, 2);
    const row = [
      'fixed-import',
      '이관 고정',
      p.name,
      'fixed-ticket',
      '2026-10-01',
      '2026-10-01',
      '0',
      '36',
      '20',
      '2026-11-01',
    ];
    const text = imp.fixedFeeImportHeader + '\n' + [...row, '20000'].join('\t');
    assert.deepEqual((await imp.memberPreview(read(), a, { text })).errors, []);
    assert.equal((await run((s) => imp.importMembers(s, a, { text }))).contracts, 1);
    assert.equal((await imp.memberPreview(read(), a, { text })).rows[0].duplicate, true);
    assert.equal(
      (await imp.memberPreview(read(), a, { text: text.replace(/20000$/, '30000') })).errors.length,
      1,
    );
    const legacy =
      imp.importHeader +
      '\n' +
      ['legacy', '기존 형식', p.name, 'legacy-ticket', ...row.slice(4)].join('\t');
    assert.deepEqual((await imp.memberPreview(read(), a, { text: legacy })).errors, []);
    assert.equal((await imp.memberPreview(read(), a, { text: legacy })).rows[0].fixedFee, null);
    const imported = (await read().query('contracts', [['external_ref', '==', 'fixed-ticket']]))[0];
    assert.equal((await d.progress(read(), imported)).remaining, 16);
    assert.equal(imported.fixed_fee, 20000);
    // A submitted payroll also blocks fee changes, including changes to percentage mode.
    await run((s) => s.put('payroll_runs', d.pair(p.id, '2026-11'), { state: 'submitted' }));
    await assert.rejects(
      run((s) =>
        d.setContractFee(s, a, fixed.id, { version: 1, fixedFee: null, reason: '제출 후' }),
      ),
      /제출/,
    );
    await run((s) => s.put('periods', '2026-11', { state: 'closed' }));
    await assert.rejects(
      run((s) =>
        d.setContractFee(s, a, fixed.id, { version: 1, fixedFee: 30000, reason: '마감 후' }),
      ),
      /마감/,
    );
    assert.equal((await read().get('contracts', fixed.id)).fixed_fee, 20000);
  },
);

test(
  '기초잔여 이관은 과거 결제일·신규매출을 만들지 않고 회원권별 잔여·고정료·중복을 보존',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const { importBalances } = await import('../firebase/balances.mjs');
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T09:00:00Z') });
    const svc = services('demo-balance-' + randomBytes(4).toString('hex'));
    const a = { id: 'admin', role: 'admin', display_name: '이관 검증' };
    const run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const p = await run((s) =>
      d.addPerson(s, a, { name: '검증 선생님', profile: 'standard', hireMonth: '2026-10' }),
    );
    const rows = [
      {
        row: 1,
        name: '동일 회원',
        instructor: p.name,
        quantity: 30,
        remaining: 14,
        gross: 1980000,
        category: 'pt',
      },
      {
        row: 2,
        name: '동일 회원',
        instructor: p.name,
        quantity: 20,
        remaining: 20,
        gross: 1045000,
        category: 'pt',
      },
      {
        row: 3,
        name: '고정 회원',
        instructor: p.name,
        quantity: 36,
        remaining: 16,
        gross: null,
        fixedFee: 20000,
        category: 'pt',
      },
    ];
    const input = { batch: 'test-baseline', asOf: '2026-11-02', rows };
    assert.deepEqual(await run((s) => importBalances(s, a, input)), {
      members: 2,
      contracts: 3,
      duplicates: 0,
    });
    assert.equal((await read().query('sales')).length, 0);
    assert.equal((await read().query('members')).length, 2);
    const contracts = await read().query('contracts');
    const regular = contracts.find((c) => c.source_row === 1),
      fixed = contracts.find((c) => c.source_row === 3);
    assert.equal(regular.amount, 1800000);
    assert.equal(regular.gross_amount, 1980000);
    assert.equal(regular.paid_date, '');
    assert.equal(regular.carry_used, 16);
    assert.equal((await d.progress(read(), regular)).remaining, 14);
    assert.equal((await d.progress(read(), fixed)).remaining, 16);
    assert.deepEqual(await run((s) => importBalances(s, a, input)), {
      members: 0,
      contracts: 0,
      duplicates: 3,
    });
    await assert.rejects(
      run((s) => importBalances(s, a, { ...input, rows: [{ ...rows[0], remaining: 13 }] })),
      /内容|내용/,
    );
    await assert.rejects(
      run((s) => importBalances(s, { role: 'employee' }, input)),
      /관리자/,
    );
    const l = await run((s) =>
      d.addLesson(s, a, { contractId: fixed.id, date: '2026-11-02', time: '18:00' }),
    );
    assert.equal(
      (await d.calculate(read(), p, '2026-11')).lines.find((x) => x.lessonId === l.id).unit,
      20000,
    );
    assert.equal((await d.progress(read(), fixed)).remaining, 15);
    await assert.rejects(
      run((s) => d.addLesson(s, a, { contractId: regular.id, date: '2026-11-01', time: '18:00' })),
      /날짜/,
    );
    await assert.rejects(
      run((s) =>
        importBalances(s, a, { ...input, batch: 'bad', rows: [{ ...rows[0], gross: null }] }),
      ),
      /금액/,
    );
  },
);

test(
  '관리자 수업 삭제: 서명 원본 보존·잔여/정산 복구·듀엣 원자 처리·확정 보호',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T09:00:00Z') });
    const svc = services('demo-delete-' + randomBytes(4).toString('hex'));
    const a = { id: 'admin', role: 'admin', display_name: '관리자 삭제 검증' };
    const run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const p = await run((s) =>
      d.addPerson(s, a, { name: '삭제 검증 선생님', profile: 'standard', hireMonth: '2026-01' }),
    );
    const employee = { id: 'employee', role: 'employee', person_id: p.id };
    const contract = async (carryUsed = 0) =>
      run(async (s) => {
        const m = await d.addMember(s, a, { name: randomBytes(5).toString('hex'), personId: p.id });
        return d.addContract(s, a, {
          memberId: m.id,
          paidDate: '2026-11-01',
          amount: 0,
          quantity: 10,
          category: 'pt',
          saleType: 'new',
          carryUsed,
          fixedFee: 20000,
        });
      });
    const ticket = await contract(3);
    const first = await run((s) =>
      d.addLesson(s, employee, { contractId: ticket.id, date: '2026-11-01', time: '10:00' }),
    );
    const later = await run((s) =>
      d.addLesson(s, employee, { contractId: ticket.id, date: '2026-11-02', time: '10:00' }),
    );
    const sign = async (l) =>
      run(async (s) =>
        d.signLesson(s, employee, l.id, {
          version: l.version,
          snapshot: await d.snapshot(s, l.id),
          confirmed: true,
          strokes,
        }),
      );
    const sig1 = await sign(first),
      sig2 = await sign(later);
    const payload = await read().get('signature_payloads', sig1.id);
    assert.equal((await d.progress(read(), ticket)).remaining, 5);
    assert.equal((await d.calculate(read(), p, '2026-11')).commission, 40000);
    await assert.rejects(
      run((s) => c.deleteLesson(s, employee, first.id, { version: 1, reason: '직원 요청' })),
      (e) => e.status === 403,
    );
    await assert.rejects(
      run((s) => c.deleteLesson(s, a, first.id, { version: 99, reason: '이전 화면' })),
      (e) => e.status === 409,
    );
    await assert.rejects(
      run((s) => c.deleteLesson(s, a, first.id, { version: 1, reason: '' })),
      /사유/,
    );
    assert.equal(
      (await run((s) => c.deleteLesson(s, a, first.id, { version: 1, reason: '중복 수업 삭제' })))
        .restoredSessions,
      1,
    );
    assert.equal((await read().get('lessons', first.id)).status, 'void');
    assert.equal((await d.progress(read(), ticket)).remaining, 6);
    assert.equal((await d.calculate(read(), p, '2026-11')).commission, 20000);
    assert.deepEqual(await read().get('signature_payloads', sig1.id), payload);
    assert.ok(await read().get('signatures', sig1.id));
    assert.ok(await read().get('signatures', sig2.id));
    assert.equal(
      (await d.confirmation(read(), await read().get('lessons', later.id))).state,
      'stale',
    );
    await assert.rejects(
      run((s) => c.deleteLesson(s, a, first.id, { version: 2, reason: '다시 삭제' })),
      /취소/,
    );
    assert.equal((await d.progress(read(), ticket)).remaining, 6);
    const left = await contract(),
      right = await contract();
    const duet = await run((s) =>
      c.addDuet(s, employee, {
        contractIds: [left.id, right.id],
        date: '2026-11-03',
        time: '10:00',
      }),
    );
    assert.equal((await d.progress(read(), left)).remaining, 9);
    assert.equal((await d.calculate(read(), p, '2026-11')).commission, 60000);
    assert.equal(
      (
        await run((s) =>
          c.deleteLesson(s, a, duet.lesson_ids[0], { version: 1, reason: '듀엣 중복 삭제' }),
        )
      ).restoredSessions,
      2,
    );
    assert.equal((await d.progress(read(), left)).remaining, 10);
    assert.equal((await d.progress(read(), right)).remaining, 10);
    assert.equal((await read().get('duet_sessions', duet.id)).status, 'void');
    for (const id of duet.lesson_ids)
      assert.equal((await read().get('lessons', id)).status, 'void');
    assert.equal((await d.calculate(read(), p, '2026-11')).commission, 20000);
    const currentList = await d.listLessons(
      read(),
      a,
      new URL('http://localhost/api/lessons?month=2026-11'),
    );
    assert.equal(currentList.items.length, 1);
    const historyList = await d.listLessons(
      read(),
      a,
      new URL('http://localhost/api/lessons?month=2026-11&includeDeleted=1'),
    );
    assert.equal(historyList.items.filter((l) => l.status === 'void').length, 3);
    const privateList = await d.listLessons(
      read(),
      employee,
      new URL('http://localhost/api/lessons?month=2026-11&includeDeleted=1'),
    );
    assert.equal(privateList.items.length, 1);
    const deletion = { version: 1, reason: '정산 후 삭제 시도' };
    await run((s) =>
      w.payrollAction(s, employee, p.id, '2026-11', { action: 'submit', version: 0 }),
    );
    await assert.rejects(
      run((s) => c.deleteLesson(s, a, later.id, deletion)),
      (e) => e.status === 409,
    );
    await run((s) =>
      w.payrollAction(s, a, p.id, '2026-11', { action: 'return', version: 1, note: '검증 반려' }),
    );
    await run((s) =>
      w.payrollAction(s, employee, p.id, '2026-11', { action: 'submit', version: 2 }),
    );
    await run((s) =>
      w.payrollAction(s, a, p.id, '2026-11', {
        action: 'approve',
        version: 3,
        note: '재서명 확인 예외 승인 검증',
      }),
    );
    const frozen = await d.result(read(), a, p.id, '2026-11');
    await assert.rejects(
      run((s) => c.deleteLesson(s, a, later.id, deletion)),
      (e) => e.status === 409,
    );
    assert.deepEqual(await d.result(read(), a, p.id, '2026-11'), frozen);
    await run((s) => s.put('periods', '2026-11', { state: 'closed' }));
    await assert.rejects(
      run((s) => c.deleteLesson(s, a, later.id, deletion)),
      /마감/,
    );
    assert.equal((await d.progress(read(), ticket)).remaining, 6);
    assert.equal((await read().query('audit', [['action', '==', 'lesson-delete']])).length, 2);
  },
);

test(
  '대표 직책은 급여 대상에서 제외되고 수업·급여 입력을 생성하지 않음',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T09:00:00Z') });
    const svc = services('demo-representative-' + randomBytes(4).toString('hex'));
    const a = { id: 'admin', role: 'admin', display_name: '대표 검증' },
      run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const p = await run((s) =>
      d.addPerson(s, a, {
        name: '대표 검증',
        profile: 'representative',
        hireMonth: '2026-11',
        base: 1000000,
        taxBps: 330,
      }),
    );
    assert.equal(d.trainer(p), false);
    assert.equal((await d.termsAt(read(), p.id, '2026-11')).base, 0);
    assert.equal(
      (await d.eligible(read(), '2026-11')).some((x) => x.id === p.id),
      false,
    );
    await assert.rejects(d.calculate(read(), p, '2026-11'), /정산 대상/);
    await assert.rejects(d.result(read(), a, p.id, '2026-11'), /정산 대상/);
    await assert.rejects(
      run((s) => d.addMember(s, a, { name: 'PT 회원', personId: p.id })),
      /트레이너/,
    );
    await assert.rejects(
      run((s) =>
        w.settings(s, a, 'inputs', p.id, {
          month: '2026-11',
          version: 0,
          extra: 1000000,
          note: '추가 지급 시도',
        }),
      ),
      /급여 입력/,
    );
    await run((s) =>
      w.settings(s, a, 'terms', p.id, {
        month: '2026-11',
        profile: 'representative',
        base: 1000000,
        taxBps: 330,
        version: 1,
        reason: '대표 직책 유지',
      }),
    );
    assert.equal((await d.termsAt(read(), p.id, '2026-11')).base, 0);
    assert.equal((await d.termsAt(read(), p.id, '2026-11')).tax_bps, 0);
  },
);

test(
  '그룹수업 0명 하프 페이: 등록·정정·페이롤·원 단위 반올림',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T09:00:00Z') });
    const svc = services('demo-half-' + randomBytes(4).toString('hex'));
    const a = { id: 'admin', role: 'admin', display_name: '하프 페이 검증' },
      run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const p = await run((s) =>
      d.addPerson(s, a, { name: '그룹 검증', profile: 'group', hireMonth: '2026-11' }),
    );
    const user = { id: 'teacher', role: 'employee', person_id: p.id };
    const rate = await run((s) =>
      c.createGroupRate(s, a, p.id, {
        name: '그룹',
        effectiveDate: '2026-11-01',
        hourlyRate: 35000,
        billableMinutes: 60,
        reason: '계약',
      }),
    );
    const records = [];
    for (const [i, participants] of [0, 1, 15].entries())
      records.push(
        await run((s) =>
          c.addGroupLesson(s, user, {
            rateId: rate.id,
            date: '2026-11-01',
            time: `${10 + i}:00`,
            participants,
          }),
        ),
      );
    assert.deepEqual(
      records.map((r) => r.amount),
      [17500, 35000, 35000],
    );
    assert.deepEqual(
      records.map((r) => r.payment_factor),
      [0.5, 1, 1],
    );
    assert.equal((await d.calculate(read(), p, '2026-11')).groupCommission, 87500);
    const full = await run((s) =>
      c.changeGroupLesson(s, user, records[0].id, {
        version: 1,
        participants: 1,
        reason: '인원 정정',
      }),
    );
    assert.equal(full.amount, 35000);
    const half = await run((s) =>
      c.changeGroupLesson(s, user, records[0].id, {
        version: 2,
        participants: 0,
        reason: '인원 최종 확인',
      }),
    );
    assert.equal(half.amount, 17500);
    assert.equal((await d.calculate(read(), p, '2026-11')).groupCommission, 87500);
    assert.equal(c.groupPayment(35001, 60, 0).amount, 17501);
    assert.equal(c.groupPayment(35000, 50, 0).amount, 14584);
    await assert.rejects(
      run((s) =>
        c.addGroupLesson(s, user, {
          rateId: rate.id,
          date: '2026-11-01',
          time: '14:00',
          participants: 0,
          amount: 35000,
        }),
      ),
      (e) => e.status === 400,
    );
    await run((s) => s.put('periods', '2026-11', { state: 'closed' }));
    await assert.rejects(
      run((s) =>
        c.changeGroupLesson(s, user, records[0].id, {
          version: 3,
          participants: 1,
          reason: '마감 후',
        }),
      ),
      /마감/,
    );
  },
);

test(
  '계약 기준: 기간 한정 최저 40%·고정료 독립·FC/PT 경계 구간·센터 초과분',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T09:00:00Z') });
    const svc = services('demo-contracts-' + randomBytes(4).toString('hex')),
      a = { id: 'admin', role: 'admin' },
      run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const people = {};
    for (const profile of ['standard', 'fc', 'lead', 'manager'])
      people[profile] = await run((s) =>
        d.addPerson(s, a, { name: profile, profile, hireMonth: '2026-10' }),
      );
    const teacher = people.standard;
    await run((s) =>
      w.settings(s, a, 'terms', teacher.id, {
        month: '2026-11',
        version: 0,
        base: 1000000,
        taxBps: 330,
        minimumRate: 40,
        minimumRateUntil: '2026-11',
        reason: '11월까지 최저 40% 계약',
      }),
    );
    assert.equal((await d.calculate(read(), teacher, '2026-10')).rate, 30);
    assert.equal((await d.calculate(read(), teacher, '2026-11')).rate, 40);
    assert.equal((await d.calculate(read(), teacher, '2026-12')).rate, 30);
    assert.equal((await d.calculate(read(), teacher, '2026-12')).minimumRate, 0);
    // A base pay edit from an older client preserves the existing guarantee.
    await run((s) =>
      w.settings(s, a, 'terms', teacher.id, {
        month: '2026-11',
        version: 1,
        base: 1000001,
        taxBps: 330,
        reason: '기본급만 변경',
      }),
    );
    assert.equal((await d.calculate(read(), teacher, '2026-11')).rate, 40);
    await assert.rejects(
      run((s) =>
        w.settings(s, a, 'terms', teacher.id, {
          month: '2026-11',
          version: 2,
          base: 1000000,
          taxBps: 330,
          minimumRate: 40,
          minimumRateUntil: '2026-10',
          reason: '잘못된 기간',
        }),
      ),
      /종료 월/,
    );
    const tickets = [];
    for (const fixedFee of [null, 20000])
      tickets.push(
        await run(async (s) => {
          const member = await d.addMember(s, a, {
            name: '검증 ' + String(fixedFee),
            personId: teacher.id,
          });
          return d.addContract(s, a, {
            memberId: member.id,
            paidDate: '2026-11-01',
            amount: 1100000,
            vatIncluded: true,
            quantity: 10,
            category: 'pt',
            saleType: 'new',
            ...(fixedFee === null ? {} : { fixedFee }),
          });
        }),
      );
    for (const ticket of tickets)
      await run((s) =>
        d.addLesson(s, a, { contractId: ticket.id, date: '2026-11-02', time: '10:00' }),
      );
    const low = await d.calculate(read(), teacher, '2026-11');
    assert.equal(low.commission, 60000);
    assert.equal(low.minimumRate, 40);
    const sale = {
      id: 'boundary',
      month: '2026-11',
      date: '2026-11-03',
      person_id: teacher.id,
      category: 'pt',
      kind: 'sale',
      amount: 0,
      team_pt_eligible: true,
    };
    await run((s) => s.put('sales', sale.id, { ...sale, amount: 4000000 }));
    assert.equal((await d.calculate(read(), teacher, '2026-11')).rate, 45);
    // Monthly FC totals are gross inputs, converted once to supply amounts before tier selection.
    for (const [i, [supply, expected]] of [
      [34999999, 0],
      [35000000, 700000],
      [39999999, 800000],
      [40000000, 1000000],
      [44999999, 1125000],
      [45000000, 1350000],
    ].entries()) {
      await run((s) =>
        w.setMembershipTotal(s, a, {
          month: '2026-11',
          version: i,
          amount: supply,
          vatIncluded: false,
          note: 'FC 공급가 경계 검증',
        }),
      );
      const result = await d.calculate(read(), people.fc, '2026-11');
      assert.equal(result.incentive, expected);
      assert.equal(result.incentiveDetails.revenue, supply);
      assert.equal(result.incentiveDetails.basis, 'FC 회원권 총매출');
    }
    // Two 1m contract sales already exist. PT leader's own sale is included; Pilates and manager PT are excluded by the sales ledger rules.
    for (const [supply, expected] of [
      [29999999, 0],
      [30000000, 600000],
      [34999999, 700000],
      [35000000, 875000],
      [39999999, 1000000],
      [40000000, 1200000],
    ]) {
      await run((s) => s.put('sales', sale.id, { ...sale, amount: supply - 2000000 }));
      const result = await d.calculate(read(), people.lead, '2026-11');
      assert.equal(result.incentive, expected);
      assert.equal(result.incentiveDetails.revenue, supply);
    }
    await run((s) =>
      w.setMembershipTotal(s, a, {
        month: '2026-11',
        version: 6,
        amount: 55000000,
        vatIncluded: true,
        note: '부가세 포함 FC 5500만원',
      }),
    );
    assert.equal((await d.calculate(read(), people.fc, '2026-11')).incentive, 1500000);
    for (const [center, expected] of [
      [79999999, 1600000],
      [80000000, 1600000],
      [80000001, 1600000],
      [90000000, 2000000],
    ]) {
      await run((s) => s.put('sales', sale.id, { ...sale, amount: center - 52000000 }));
      const result = await d.calculate(read(), people.manager, '2026-11');
      assert.equal(result.incentive, expected);
      assert.equal(result.incentiveDetails.revenue, center);
    }
    await run((s) => s.put('periods', '2026-11', { month: '2026-11', state: 'closed' }));
    await assert.rejects(
      run((s) =>
        w.settings(s, a, 'terms', teacher.id, {
          month: '2026-11',
          version: 2,
          base: 1000000,
          taxBps: 330,
          minimumRate: 40,
          minimumRateUntil: '2026-11',
          reason: '마감 후 변경',
        }),
      ),
      /확정/,
    );
  },
);

test(
  '모든 PT 강사·PT팀장의 공통 개인 매출 성과금 경계 및 팀 커미션 별도 합산',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const svc = services('demo-common-bonus-' + randomBytes(4).toString('hex')),
      a = { id: 'admin', role: 'admin' },
      run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const people = [];
    for (const profile of ['morning', 'standard', 'mixed', 'lead', 'manager', 'fc'])
      people.push(
        await run((s) => d.addPerson(s, a, { name: profile, profile, hireMonth: '2026-01' })),
      );
    for (const p of people) {
      for (const [amount, expected] of [
        [9999999, 0],
        [10000000, 200000],
        [11999999, 200000],
        [12000000, 400000],
        [14000000, 600000],
      ]) {
        await run((s) =>
          s.put('sales', 'bonus-' + p.id, {
            id: 'bonus-' + p.id,
            date: '2026-11-01',
            month: '2026-11',
            person_id: p.id,
            category: 'pt',
            kind: 'sale',
            amount,
            team_pt_eligible: p.profile !== 'manager',
          }),
        );
        const r = await d.calculate(read(), p, '2026-11');
        assert.equal(
          r.bonus,
          ['manager', 'fc'].includes(p.profile) ? 0 : expected,
          p.profile + ' ' + amount,
        );
        if (p.profile === 'lead')
          assert.equal(
            r.gross,
            r.base + r.bonus + r.incentive,
            '개인 성과금과 팀 성과금 각각 합산',
          );
      }
    }
  },
);

test(
  '그룹 강사 단가는 본인만 조회: 타인 지정·미연결 계정·타인 단가 기록 차단',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const svc = services('demo-private-group-rates-' + randomBytes(4).toString('hex')),
      a = { id: 'admin', role: 'admin' },
      run = (fn) => atomic(svc.db, fn),
      read = () => new Store(svc.db);
    const people = [];
    for (const name of ['그룹 강사 A', '그룹 강사 B'])
      people.push(
        await run((s) => d.addPerson(s, a, { name, profile: 'group', hireMonth: '2026-01' })),
      );
    const rates = [];
    for (const [i, p] of people.entries())
      rates.push(
        await run((s) =>
          c.createGroupRate(s, a, p.id, {
            name: '그룹 필라테스',
            effectiveDate: '2026-01-01',
            hourlyRate: i === 0 ? 35000 : 90000,
            billableMinutes: 60,
            reason: '단가 분리 검증',
          }),
        ),
      );
    const user = { id: 'teacher-a', role: 'employee', person_id: people[0].id };
    assert.deepEqual(
      (await c.groupRates(read(), user)).map((r) => r.id),
      [rates[0].id],
    );
    assert.deepEqual(
      (await c.groupRates(read(), user, people[1].id)).map((r) => r.id),
      [rates[0].id],
    );
    assert.equal((await c.groupRates(read(), a)).length, 2);
    await assert.rejects(
      c.groupRates(read(), { id: 'unlinked', role: 'employee' }),
      (e) => e.status === 403,
    );
    await assert.rejects(
      run((s) =>
        c.addGroupLesson(s, user, {
          rateId: rates[1].id,
          date: '2026-11-01',
          time: '10:00',
          participants: 1,
        }),
      ),
      (e) => e.status === 403,
    );
  },
);
