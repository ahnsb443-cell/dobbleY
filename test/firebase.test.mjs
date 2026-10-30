import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFirebaseApp } from '../firebase/local.mjs';
import { services, Store, atomic } from '../firebase/store.mjs';
import { fixture as sqlFixture, strokes } from './helpers.mjs';
import { payroll as sqlPayroll } from '../lib/domain.mjs';
const enabled = !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
test(
  'Firebase Auth·Firestore 실제 에뮬레이터 운영 흐름',
  { skip: !enabled, timeout: 120000 },
  async (t) => {
    const projectId = 'demo-double-y',
      svc = services(projectId),
      app = await createFirebaseApp({ projectId, setupToken: 'test-setup-code' });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + app.server.address().port,
      pw = randomBytes(18).toString('hex'),
      teacherPw = randomBytes(18).toString('hex');
    let owner, teacher, p, c, l, signature;
    async function req(
      route,
      { method = 'GET', body, auth = {}, key = randomBytes(16).toString('hex'), external } = {},
    ) {
      const r = await fetch(origin + '/api' + route, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth.cookie ? { Cookie: auth.cookie } : {}),
          ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {}),
          'Idempotency-Key': key,
          ...(external ? { Origin: external } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json();
      return {
        status: r.status,
        body: data,
        auth: {
          cookie: r.headers.get('set-cookie')?.split(';')[0] || auth.cookie,
          csrf: data.csrf || auth.csrf,
        },
      };
    }
    async function ok(route, opts) {
      const r = await req(route, opts);
      assert.ok(r.status < 300, route + ' ' + JSON.stringify(r));
      return r;
    }
    try {
      await t.test('설정 코드·Firebase 인증·최초 관리자 중복 방지', async () => {
        assert.equal(
          (
            await req('/setup', {
              method: 'POST',
              body: { username: 'owner', name: '관리자', password: pw, setupToken: 'wrong' },
            })
          ).status,
          403,
        );
        const r = await ok('/setup', {
          method: 'POST',
          body: { username: 'owner', name: '관리자', password: pw, setupToken: 'test-setup-code' },
        });
        owner = r.auth;
        assert.equal(r.body.user.role, 'admin');
        assert.equal((await ok('/status')).body.storage, 'firestore');
        assert.equal(
          (
            await req('/setup', {
              method: 'POST',
              body: {
                username: 'owner2',
                name: '관리자',
                password: pw,
                setupToken: 'test-setup-code',
              },
            })
          ).status,
          409,
        );
      });
      await t.test('구성원·직원 계정 발급, 임시 비밀번호 변경', async () => {
        p = (
          await ok('/people', {
            method: 'POST',
            auth: owner,
            body: { name: '가상 강사', profile: 'morning', hireMonth: '2026-01' },
          })
        ).body;
        await ok('/accounts', {
          method: 'POST',
          auth: owner,
          body: { username: 'teacher', password: teacherPw, role: 'employee', personId: p.id },
        });
        teacher = (
          await ok('/login', { method: 'POST', body: { username: 'teacher', password: teacherPw } })
        ).auth;
        assert.equal((await req('/members', { auth: teacher })).status, 403);
        const changed = await ok('/password', {
          method: 'POST',
          auth: teacher,
          body: { currentPassword: teacherPw, password: teacherPw + 'new' },
        });
        const old = teacher;
        teacher = changed.auth;
        assert.equal((await req('/me', { auth: old })).status, 401);
      });
      await t.test('개인 등록·멱등성·권한·신규와 추가 결제 분리', async () => {
        const body = {
          name: '가상 회원',
          personId: p.id,
          paidDate: '2026-10-01',
          startDate: '2026-10-01',
          category: 'pt',
          saleType: 'new',
          amount: 5000000,
          quantity: 50,
        };
        const r = await ok('/registrations', {
          method: 'POST',
          auth: teacher,
          body,
          key: 'registration-key-1',
        });
        c = r.body.contract;
        assert.deepEqual(
          (
            await ok('/registrations', {
              method: 'POST',
              auth: teacher,
              body,
              key: 'registration-key-1',
            })
          ).body,
          r.body,
        );
        assert.equal(
          (
            await req('/registrations', {
              method: 'POST',
              auth: teacher,
              body: { ...body, amount: 1 },
              key: 'registration-key-1',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req('/people', {
              method: 'POST',
              auth: teacher,
              body: { name: 'x', profile: 'staff', hireMonth: '2026-01' },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await req('/members', {
              method: 'POST',
              auth: teacher,
              external: 'https://evil.example',
              body: { name: 'x' },
            })
          ).status,
          403,
        );
        const second = (
          await ok('/people', {
            method: 'POST',
            auth: owner,
            body: { name: '다른 선생님', profile: 'morning', hireMonth: '2026-01' },
          })
        ).body;
        const m = (
          await ok('/members', {
            method: 'POST',
            auth: owner,
            body: { name: '비공개 회원', personId: second.id },
          })
        ).body;
        assert.equal((await req('/members/' + m.id, { auth: teacher })).status, 403);
        assert.equal((await ok('/members', { auth: teacher })).body.items.length, 1);
      });
      await t.test('동시 중복 수업은 1건, 회원 모드로 다른 탭·재전송 차단', async () => {
        const body = { contractId: c.id, date: '2026-10-07', time: '16:00' };
        const rows = await Promise.all([
          req('/lessons', { method: 'POST', auth: teacher, body }),
          req('/lessons', { method: 'POST', auth: teacher, body }),
        ]);
        assert.deepEqual(rows.map((x) => x.status).sort(), [200, 409]);
        l = rows.find((x) => x.status === 200).body;
        const mode = await ok('/member-mode', {
          method: 'POST',
          auth: teacher,
          body: { lessonId: l.id },
        });
        assert.equal((await req('/members', { auth: teacher })).body.code, 'MEMBER_MODE');
        assert.equal(
          (
            await req('/registrations', {
              method: 'POST',
              auth: teacher,
              key: 'registration-key-1',
              body: {},
            })
          ).body.code,
          'MEMBER_MODE',
        );
        signature = (
          await ok('/member-mode/sign', {
            method: 'POST',
            auth: teacher,
            body: { snapshot: mode.body.snapshot, version: l.version, confirmed: true, strokes },
          })
        ).body;
        assert.equal(
          (await ok('/member-mode', { auth: teacher })).body.confirmation.state,
          'signed',
        );
        assert.equal(
          (
            await req('/member-mode/exit', {
              method: 'POST',
              auth: teacher,
              body: { password: 'wrong' },
            })
          ).status,
          401,
        );
        await ok('/member-mode/exit', {
          method: 'POST',
          auth: teacher,
          body: { password: teacherPw + 'new' },
        });
      });
      await t.test('Firebase 급여는 기존 검증 수식과 일치, 서명 획은 목록에서 제외', async () => {
        const r = (await ok('/payroll/' + p.id + '?month=2026-10', { auth: teacher })).body;
        const f = await sqlFixture();
        try {
          const sl = await import('../lib/domain.mjs');
          sl.addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '16:00' });
          const q = sqlPayroll(f.s, f.p, '2026-10');
          for (const key of ['rate', 'gross', 'tax', 'net', 'commission', 'base'])
            assert.equal(r[key], q[key], key);
        } finally {
          await f.close();
        }
        assert.equal(r.rate, 50);
        assert.equal(r.net, 531850);
        assert.equal('internal' in r, false);
        const rows = (await ok('/lessons?month=2026-10', { auth: teacher })).body;
        assert.equal(JSON.stringify(rows).includes('"strokes"'), false);
        const payload = await new Store(svc.db).get('signature_payloads', signature.id);
        assert.equal(digestJSON(strokes), digestJSON(JSON.parse(payload.strokes)));
      });
      await t.test('다짐 200건 입력 및 재가져오기 중복 방지', async () => {
        const body = {
          text: Array.from(
            { length: 200 },
            (_, i) =>
              '2026.10.' +
              String(1 + Math.floor(i / 10)).padStart(2, '0') +
              '(목) ' +
              String(8 + (i % 10)).padStart(2, '0') +
              ':00 ~ ' +
              String(8 + (i % 10)).padStart(2, '0') +
              ':50 P.T수업 PT 가상 강사 개인 avatar 테스트' +
              i +
              ' 출석 변경 1:1 PT 30회',
          ).join('\n'),
        };
        const r = await ok('/source/import', { method: 'POST', auth: owner, body });
        assert.equal(r.body.count, 200);
        assert.equal(
          (await ok('/source/import', { method: 'POST', auth: owner, body })).body.duplicates,
          200,
        );
        const comparison = (await ok('/reconcile?month=2026-10', { auth: owner })).body;
        assert.ok(comparison.total >= 201);
      });
      await t.test('제출→예외 사유 승인→마감 후 금액 잠금, 누락 서명은 추후 수령', async () => {
        const late = (
          await ok('/lessons', {
            method: 'POST',
            auth: teacher,
            body: { contractId: c.id, date: '2026-10-08', time: '17:00' },
          })
        ).body;
        const before = (await ok('/payroll/' + p.id + '?month=2026-10', { auth: teacher })).body;
        const submitted = (
          await ok('/payroll/' + p.id, {
            method: 'POST',
            auth: teacher,
            body: { month: '2026-10', action: 'submit', version: before.version },
          })
        ).body;
        assert.equal(
          (
            await req('/lessons', {
              method: 'POST',
              auth: teacher,
              body: { contractId: c.id, date: '2026-10-08', time: '16:00' },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req('/payroll/' + p.id, {
              method: 'POST',
              auth: owner,
              body: { month: '2026-10', action: 'approve', version: submitted.version },
            })
          ).status,
          400,
        );
        const approved = (
          await ok('/payroll/' + p.id, {
            method: 'POST',
            auth: owner,
            body: {
              month: '2026-10',
              action: 'approve',
              version: submitted.version,
              note: '가상 자료 예외 승인',
            },
          })
        ).body;
        assert.equal(approved.frozen, true);
        assert.equal(approved.net, before.net);
        const list = (await ok('/payroll?month=2026-10', { auth: owner })).body;
        for (const r of list.items.filter((r) => r.personId !== p.id)) {
          const sub = (
            await ok('/payroll/' + r.personId, {
              method: 'POST',
              auth: owner,
              body: { month: '2026-10', action: 'submit', version: r.version },
            })
          ).body;
          await ok('/payroll/' + r.personId, {
            method: 'POST',
            auth: owner,
            body: { month: '2026-10', action: 'approve', version: sub.version, note: '확인' },
          });
        }
        await ok('/periods/2026-10', {
          method: 'POST',
          auth: owner,
          body: { action: 'close', version: 0, note: '가상 월말 마감' },
        });
        assert.equal(
          (await ok('/payroll/' + p.id + '?month=2026-10', { auth: teacher })).body.periodClosed,
          true,
        );
        assert.ok((await svc.db.collection('payroll_versions').get()).size >= 2);
        const mode = (
          await ok('/member-mode', { method: 'POST', auth: teacher, body: { lessonId: late.id } })
        ).body;
        await ok('/member-mode/sign', {
          method: 'POST',
          auth: teacher,
          body: { snapshot: mode.snapshot, version: late.version, confirmed: true, strokes },
        });
        await ok('/member-mode/exit', {
          method: 'POST',
          auth: teacher,
          body: { password: teacherPw + 'new' },
        });
        const after = (await ok('/payroll/' + p.id + '?month=2026-10', { auth: teacher })).body;
        assert.equal(after.net, approved.net);
        assert.equal(after.unconfirmed, 1);
        assert.equal(after.currentUnconfirmed, 0);
        assert.equal(
          (
            await req('/people/' + p.id + '/terms', {
              method: 'PUT',
              auth: owner,
              body: { month: '2026-10', base: 1, taxBps: 330, version: 0, reason: '차단 확인' },
            })
          ).status,
          409,
        );
      });

      await t.test(
        '지급률·급여 조건은 적용 월별 저장, 미래 변경이 마감 금액을 바꾸지 않음',
        async () => {
          const frozen = (await ok('/payroll/' + p.id + '?month=2026-10', { auth: owner })).body;
          await ok('/rules', {
            method: 'PUT',
            auth: owner,
            body: {
              profile: 'morning',
              month: '2026-11',
              tiers: [
                [0, 38],
                [4000000, 42],
                [5000000, 50],
              ],
              bonus: false,
              version: 0,
              reason: '새 계약',
            },
          });
          await ok('/people/' + p.id + '/terms', {
            method: 'PUT',
            auth: owner,
            body: {
              profile: 'morning',
              month: '2026-11',
              base: 600000,
              taxBps: 330,
              version: 0,
              reason: '새 기본급',
            },
          });
          const next = (await ok('/payroll/' + p.id + '?month=2026-11', { auth: teacher })).body;
          assert.equal(next.rate, 38);
          assert.equal(next.base, 600000);
          assert.equal(
            (await ok('/payroll/' + p.id + '?month=2026-10', { auth: teacher })).body.net,
            frozen.net,
          );
          assert.deepEqual(
            (await ok('/rules', { auth: owner })).body.items.find(
              (r) => r.effective_month === '2026-11',
            ).body.tiers,
            [
              [0, 38],
              [4000000, 42],
              [5000000, 50],
            ],
          );
        },
      );
      await t.test(
        '마감 해제·과거 수업 보완 시 기존 서명은 보존하고 재서명 필요 표시',
        async () => {
          await ok('/periods/2026-10', {
            method: 'POST',
            auth: owner,
            body: { action: 'reopen', version: 1, note: '누락 수업 확인' },
          });
          const original = await new Store(svc.db).get('signature_payloads', signature.id);
          await ok('/lessons', {
            method: 'POST',
            auth: teacher,
            body: { contractId: c.id, date: '2026-10-06', time: '16:00' },
          });
          const history = (await ok('/lessons/' + l.id + '/signatures', { auth: teacher })).body;
          assert.equal(history.confirmation.state, 'stale');
          assert.equal(history.snapshot.ordinal, 2);
          assert.deepEqual(
            await new Store(svc.db).get('signature_payloads', signature.id),
            original,
          );
          await assert.rejects(
            atomic(svc.db, (s) =>
              s.put('signature_payloads', signature.id, { id: signature.id, strokes: '[]' }),
            ),
            (e) => e.status === 409,
          );
          await assert.rejects(
            atomic(svc.db, (s) => s.del('signatures', signature.id)),
            (e) => e.status === 409,
          );
        },
      );
      await t.test('일반 직원은 개인 급여만 조회, 관리자 초기화는 기존 세션 폐기', async () => {
        const staff = (
          await ok('/people', {
            method: 'POST',
            auth: owner,
            body: { name: '일반 직원', profile: 'staff', hireMonth: '2026-01', base: 2000000 },
          })
        ).body;
        const pass = randomBytes(18).toString('hex'),
          account = (
            await ok('/accounts', {
              method: 'POST',
              auth: owner,
              body: { username: 'staff', password: pass, role: 'employee', personId: staff.id },
            })
          ).body;
        let session = (
          await ok('/login', { method: 'POST', body: { username: 'staff', password: pass } })
        ).auth;
        session = (
          await ok('/password', {
            method: 'POST',
            auth: session,
            body: { currentPassword: pass, password: pass + 'new' },
          })
        ).auth;
        assert.equal((await req('/members', { auth: session })).status, 403);
        const salary = (await ok('/payroll?month=2026-10', { auth: session })).body.items;
        assert.equal(salary.length, 1);
        assert.equal(salary[0].personId, staff.id);
        const current = (await ok('/accounts', { auth: owner })).body.items.find(
          (x) => x.id === account.id,
        );
        await ok('/accounts/' + account.id, {
          method: 'PATCH',
          auth: owner,
          body: { version: current.version, password: pass + 'reset', reason: '직원 요청 초기화' },
        });
        assert.equal((await req('/me', { auth: session })).status, 401);
        assert.equal(
          (
            await ok('/login', {
              method: 'POST',
              body: { username: 'staff', password: pass + 'reset' },
            })
          ).body.user.mustChange,
          true,
        );
      });
      await t.test(
        '회원 담당 인수인계는 과거 매출·수업·서명 소유권 유지, 퇴사 후 세션 차단',
        async () => {
          const people = (await ok('/people', { auth: owner })).body.items,
            target = people.find((x) => x.name === '다른 선생님');
          const member = (await ok('/members/' + c.member_id, { auth: owner })).body.member;
          const before = await new Store(svc.db).get('signatures', signature.id);
          await ok('/members/' + member.id, {
            method: 'PATCH',
            auth: owner,
            body: {
              version: member.version,
              personId: target.id,
              effectiveDate: '2026-10-10',
              reason: '담당 인계',
            },
          });
          assert.equal((await new Store(svc.db).get('lessons', l.id)).person_id, p.id);
          assert.deepEqual(await new Store(svc.db).get('signatures', signature.id), before);
          assert.equal((await req('/members/' + member.id, { auth: teacher })).status, 403);
          const current = (await ok('/people', { auth: owner })).body.items.find(
            (x) => x.id === p.id,
          );
          await ok('/people/' + p.id + '/employment', {
            method: 'PATCH',
            auth: owner,
            body: { version: current.version, endDate: '2026-10-10', reason: '계약 종료' },
          });
          assert.equal((await req('/me', { auth: teacher })).status, 401);
        },
      );

      await t.test(
        'Firestore 이관용 내보내기·체크섬·격리 복원, 기존 자료 덮어쓰기 차단',
        async () => {
          const dir = await mkdtemp(path.join(tmpdir(), 'dy-firebase-export-'));
          try {
            const env = { ...process.env, FIREBASE_PROJECT_ID: projectId, BACKUP_DIR: dir };
            execFileSync(process.execPath, ['scripts/firebase-export.mjs'], { env, stdio: 'pipe' });
            const file = path.join(
              dir,
              (await readdir(dir)).find((x) => x.endsWith('.jsonl')),
            );
            const contents = await readFile(file, 'utf8');
            assert.equal(contents.includes('"collection":"auth_sessions"'), false);
            assert.ok(contents.includes('"collection":"signature_payloads"'));
            const target = 'demo-restore-double-y',
              targetEnv = { ...env, FIREBASE_PROJECT_ID: target };
            execFileSync(process.execPath, ['scripts/firebase-restore.mjs', file], {
              env: targetEnv,
              stdio: 'pipe',
            });
            const restored = await new Store(services(target).db).get(
              'signature_payloads',
              signature.id,
            );
            assert.deepEqual(
              restored,
              await new Store(svc.db).get('signature_payloads', signature.id),
            );
            assert.throws(() =>
              execFileSync(process.execPath, ['scripts/firebase-restore.mjs', file], {
                env: targetEnv,
                stdio: 'pipe',
              }),
            );
            await writeFile(file, contents + ' ');
            assert.throws(() =>
              execFileSync(process.execPath, ['scripts/firebase-restore.mjs', file], {
                env: targetEnv,
                stdio: 'pipe',
              }),
            );
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      );
      await t.test('Firestore 보안 규칙으로 직접 데이터 접근 거부', async () => {
        const target =
          'http://' +
          process.env.FIRESTORE_EMULATOR_HOST +
          '/v1/projects/' +
          projectId +
          '/databases/(default)/documents/accounts';
        const r = await fetch(target);
        assert.equal(r.status, 403);
      });
    } finally {
      await new Promise((r) => app.server.close(r));
      await svc.db.recursiveDelete(svc.db.collection('signature_payloads'));
    }
  },
);
function digestJSON(v) {
  return JSON.stringify(v);
}
