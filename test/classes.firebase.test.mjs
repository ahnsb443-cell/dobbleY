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
