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
      if (method === 'POST' && ['/registrations', '/contracts'].includes(route))
        body = { paymentConfirmed: true, ...body };
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
        for (const paymentConfirmed of [false, undefined]) {
          assert.equal(
            (
              await req('/registrations', {
                method: 'POST',
                auth: teacher,
                body: { ...body, paymentConfirmed },
              })
            ).status,
            400,
          );
        }
        assert.equal(
          (await svc.db.collection('members').where('name', '==', body.name).get()).size,
          0,
          '미결제는 회원·상품을 생성하지 않음',
        );
        const r = await ok('/registrations', {
          method: 'POST',
          auth: teacher,
          body,
          key: 'registration-key-1',
        });
        assert.equal(r.body.contract.payment_confirmed, true);
        assert.ok(r.body.contract.payment_confirmed_at);
        c = r.body.contract;
        assert.equal(
          (await ok('/contracts/' + c.id + '/lessons', { auth: teacher })).body.items.length,
          0,
        );
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
        await ok('/member-mode/exit', {
          method: 'POST',
          auth: teacher,
          body: {},
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
        const summary = (await ok('/reconcile?month=2026-10&summary=1', { auth: owner })).body;
        assert.equal(summary.total, comparison.total);
        assert.equal(summary.unresolved, 201);
        assert.equal(
          (await req('/reconcile?month=2026-10&summary=1', { auth: teacher })).status,
          403,
        );
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
          body: {},
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
        '최근 수업은 같은 날짜도 시간 역순이며 다음 페이지가 중복되지 않음',
        async () => {
          const target = (await new Store(svc.db).get('contracts', c.id)).person_id;
          for (const time of ['14:00', '18:00'])
            await ok('/lessons', {
              method: 'POST',
              auth: owner,
              body: { contractId: c.id, date: '2026-10-20', time },
            });
          const first = (
            await ok('/lessons?month=2026-10&order=recent&limit=1&personId=' + target, {
              auth: owner,
            })
          ).body;
          assert.equal(first.items[0].time, '18:00');
          const second = (
            await ok(
              '/lessons?month=2026-10&order=recent&limit=1&personId=' +
                target +
                '&after=' +
                encodeURIComponent(first.next),
              { auth: owner },
            )
          ).body;
          assert.equal(second.items[0].time, '14:00');
          assert.notEqual(first.items[0].id, second.items[0].id);
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
      await t.test(
        '숫자 4자리 PIN: 앞자리 0·변경·회원 모드 복귀·관리자 초기화·기존 로그인 호환',
        async () => {
          const pinPerson = (
            await ok('/people', {
              method: 'POST',
              auth: owner,
              body: { name: 'PIN 선생님', profile: 'morning', hireMonth: '2026-01' },
            })
          ).body;
          const issued = (
            await ok('/accounts', {
              method: 'POST',
              auth: owner,
              body: {
                username: 'pin.teacher',
                password: '0427',
                role: 'employee',
                personId: pinPerson.id,
              },
            })
          ).body;
          assert.equal(JSON.stringify(issued).includes('pin_key'), false);
          let session = (
            await ok('/login', {
              method: 'POST',
              body: { username: 'pin.teacher', password: '0427' },
            })
          ).auth;
          const original = session;
          session = (
            await ok('/password', {
              method: 'POST',
              auth: session,
              body: { currentPassword: '0427', password: '0836' },
            })
          ).auth;
          assert.equal((await req('/me', { auth: original })).status, 401);
          assert.equal(
            (
              await req('/login', {
                method: 'POST',
                body: { username: 'pin.teacher', password: '0427' },
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await req('/password', {
                method: 'POST',
                auth: session,
                body: { currentPassword: '0836', password: 'abc4' },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await req('/password', {
                method: 'POST',
                auth: session,
                body: { currentPassword: '0836', password: '12345' },
              })
            ).status,
            400,
          );
          const stored = await new Store(svc.db).get('accounts', issued.id);
          assert.match(stored.pin_key, /^[a-f0-9]{64}$/);
          assert.equal(
            JSON.stringify((await ok('/me', { auth: session })).body).includes('pin_key'),
            false,
          );
          const registration = (
            await ok('/registrations', {
              method: 'POST',
              auth: session,
              body: {
                name: 'PIN 회원',
                paidDate: '2026-10-01',
                startDate: '2026-10-01',
                category: 'pt',
                saleType: 'new',
                amount: 1000000,
                quantity: 10,
              },
            })
          ).body;
          const lesson = (
            await ok('/lessons', {
              method: 'POST',
              auth: session,
              body: { contractId: registration.contract.id, date: '2026-10-22', time: '11:00' },
            })
          ).body;
          await ok('/member-mode', {
            method: 'POST',
            auth: session,
            body: { lessonId: lesson.id },
          });
          assert.equal((await req('/members', { auth: session })).status, 403);
          await ok('/member-mode/exit', {
            method: 'POST',
            auth: session,
            body: {},
          });
          let account = (await ok('/accounts', { auth: owner })).body.items.find(
            (x) => x.id === issued.id,
          );
          assert.equal(JSON.stringify(account).includes('pin_key'), false);
          await ok('/accounts/' + issued.id, {
            method: 'PATCH',
            auth: owner,
            body: { version: account.version, password: 'normal123', reason: '일반 비밀번호 전환' },
          });
          assert.equal((await req('/me', { auth: session })).status, 401);
          assert.equal(
            (
              await req('/login', {
                method: 'POST',
                body: { username: 'pin.teacher', password: '0836' },
              })
            ).status,
            401,
          );
          session = (
            await ok('/login', {
              method: 'POST',
              body: { username: 'pin.teacher', password: 'normal123' },
            })
          ).auth;
          session = (
            await ok('/password', {
              method: 'POST',
              auth: session,
              body: { currentPassword: 'normal123', password: '1938' },
            })
          ).auth;
          account = (await ok('/accounts', { auth: owner })).body.items.find(
            (x) => x.id === issued.id,
          );
          await ok('/accounts/' + issued.id, {
            method: 'PATCH',
            auth: owner,
            body: { version: account.version, password: '0567', reason: 'PIN 초기화' },
          });
          assert.equal((await req('/me', { auth: session })).status, 401);
          const reset = await ok('/login', {
            method: 'POST',
            body: { username: 'pin.teacher', password: '0567' },
          });
          assert.equal(reset.body.user.mustChange, true);
          assert.equal(
            (await ok('/login', { method: 'POST', body: { username: 'owner', password: pw } })).body
              .user.role,
            'admin',
          );
          for (let i = 0; i < 10; i++)
            assert.equal(
              (
                await req('/login', {
                  method: 'POST',
                  body: { username: 'unknown.pin', password: '0000' },
                })
              ).status,
              401,
            );
          assert.equal(
            (
              await req('/login', {
                method: 'POST',
                body: { username: 'unknown.pin', password: '0000' },
              })
            ).status,
            429,
          );
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
      await t.test(
        '서명 임시 화면: 미저장 복귀 무반영·비밀번호 없는 복귀·서명과 수업 원자 저장',
        async () => {
          const d = await import('../firebase/domain.mjs');
          const person = (
            await ok('/people', {
              method: 'POST',
              auth: owner,
              body: { name: '서명 임시 검증', profile: 'standard', hireMonth: '2026-01' },
            })
          ).body;
          const registration = (
            await ok('/registrations', {
              method: 'POST',
              auth: owner,
              body: {
                name: '임시 서명 회원',
                personId: person.id,
                paidDate: '2026-11-01',
                quantity: 10,
                amount: 0,
                category: 'pt',
                saleType: 'new',
                fixedFee: 20000,
              },
            })
          ).body;
          const ticket = registration.contract;
          const input = { contractId: ticket.id, date: '2026-11-01', time: '09:00' };
          const count = async () =>
            (await svc.db.collection('lessons').where('contract_id', '==', ticket.id).get()).size;
          const remaining = async () => (await d.progress(new Store(svc.db), ticket)).remaining;
          const commission = async () =>
            (await d.calculate(new Store(svc.db), person, '2026-11')).commission;
          const draft = (await ok('/member-mode', { method: 'POST', auth: owner, body: input }))
            .body;
          assert.equal(draft.draft, true);
          assert.equal(draft.snapshot.remaining, 9);
          assert.equal((await ok('/me', { auth: owner })).body.user.memberMode, true);
          assert.equal((await req('/members', { auth: owner })).status, 403);
          assert.equal((await ok('/member-mode', { auth: owner })).body.lessonId, draft.lessonId);
          assert.equal(await count(), 0);
          assert.equal(await remaining(), 10);
          assert.equal(await commission(), 0);
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          assert.equal((await ok('/me', { auth: owner })).body.user.memberMode, false);
          assert.equal(await count(), 0);
          assert.equal(await remaining(), 10);
          assert.equal(
            (await svc.db.collection('audit').where('entity_id', '==', draft.lessonId).get()).size,
            0,
          );
          const current = (await ok('/member-mode', { method: 'POST', auth: owner, body: input }))
            .body;
          assert.equal(
            (
              await req('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                body: { snapshot: current.snapshot, version: 1, confirmed: true, strokes: [] },
              })
            ).status,
            400,
          );
          assert.equal(await count(), 0);
          assert.equal(await remaining(), 10);
          assert.equal(
            (
              await req('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                body: {
                  snapshot: { ...current.snapshot, member: '다른 회원' },
                  version: 1,
                  confirmed: true,
                  strokes,
                },
              })
            ).status,
            409,
          );
          assert.equal(await count(), 0);
          const body = { snapshot: current.snapshot, version: 1, confirmed: true, strokes };
          const saved = await ok('/member-mode/sign', {
            method: 'POST',
            auth: owner,
            key: 'draft-sign-once',
            body,
          });
          assert.deepEqual(
            (
              await ok('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                key: 'draft-sign-once',
                body,
              })
            ).body,
            saved.body,
          );
          assert.equal(await count(), 1);
          assert.equal(await remaining(), 9);
          assert.equal(await commission(), 20000);
          assert.equal(
            (await ok('/member-mode', { auth: owner })).body.confirmation.state,
            'signed',
          );
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          const another = (
            await ok('/login', { method: 'POST', body: { username: 'owner', password: pw } })
          ).auth;
          const later = (
            await ok('/member-mode', {
              method: 'POST',
              auth: owner,
              body: { ...input, time: '11:00' },
            })
          ).body;
          await ok('/lessons', {
            method: 'POST',
            auth: another,
            body: { ...input, time: '10:00' },
          });
          assert.equal(
            (
              await req('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                body: { snapshot: later.snapshot, version: 1, confirmed: true, strokes },
              })
            ).status,
            409,
          );
          assert.equal(await count(), 2);
          assert.equal(await remaining(), 8);
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          assert.equal(await count(), 2);
          assert.equal(await remaining(), 8);
        },
      );
      await t.test(
        '노쇼는 서명 없이 1회 차감·정상 정산하며 미서명과 다짐 누락에서 제외',
        async () => {
          const d = await import('../firebase/domain.mjs');
          const imports = await import('../firebase/imports.mjs');
          const person = (
            await ok('/people', {
              method: 'POST',
              auth: owner,
              body: { name: '노쇼 검증 강사', profile: 'standard', hireMonth: '2026-01' },
            })
          ).body;
          const registration = (
            await ok('/registrations', {
              method: 'POST',
              auth: owner,
              body: {
                name: '노쇼 검증 회원',
                personId: person.id,
                paidDate: '2026-11-01',
                quantity: 10,
                amount: 0,
                category: 'pt',
                saleType: 'new',
                fixedFee: 20000,
              },
            })
          ).body;
          const contract = registration.contract;
          const input = { contractId: contract.id, date: '2026-11-01', time: '09:00' };
          const remaining = async () => (await d.progress(new Store(svc.db), contract)).remaining;
          const pay = () => d.calculate(new Store(svc.db), person, '2026-11');
          let draft = (await ok('/member-mode', { method: 'POST', auth: owner, body: input })).body;
          assert.equal(await remaining(), 10);
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          assert.equal(await remaining(), 10);
          draft = (await ok('/member-mode', { method: 'POST', auth: owner, body: input })).body;
          const body = {
            version: draft.version,
            snapshot: draft.snapshot,
            noShow: true,
            confirmed: true,
            strokes: [],
          };
          assert.equal(
            (
              await req('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                body: { ...body, confirmed: false },
              })
            ).status,
            400,
          );
          assert.equal(await remaining(), 10);
          assert.equal(
            (
              await req('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                body: { ...body, snapshot: { ...draft.snapshot, time: '10:00' } },
              })
            ).status,
            409,
          );
          const saved = (
            await ok('/member-mode/sign', { method: 'POST', auth: owner, key: 'noshow-once', body })
          ).body;
          assert.equal(saved.noShow, true);
          assert.equal(
            (
              await ok('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                key: 'noshow-once',
                body,
              })
            ).body.lesson_id,
            saved.lesson_id,
          );
          const receipt = (await ok('/member-mode', { auth: owner })).body;
          assert.equal(receipt.confirmation.state, 'noshow');
          assert.equal(receipt.signature, null);
          assert.ok(receipt.noShow.actor_id);
          assert.equal(receipt.version, 2);
          assert.equal(await remaining(), 9);
          assert.equal(
            (await svc.db.collection('signatures').where('lesson_id', '==', saved.lesson_id).get())
              .size,
            0,
          );
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          assert.equal((await pay()).commission, 20000);
          assert.equal((await pay()).unconfirmed, 0);
          assert.equal(
            (await pay()).lines.find((x) => x.lessonId === saved.lesson_id).signature,
            'noshow',
          );
          assert.equal(
            (await imports.reconcile(new Store(svc.db), '2026-11', person.id))[0].kind,
            'noshow',
          );
          const summary = (
            await ok('/reconcile?month=2026-11&summary=1&personId=' + person.id, { auth: owner })
          ).body;
          assert.equal(summary.unresolved, 0);
          const submitted = (
            await ok('/payroll/' + person.id, {
              method: 'POST',
              auth: owner,
              body: { month: '2026-11', action: 'submit', version: 0 },
            })
          ).body;
          const approved = (
            await ok('/payroll/' + person.id, {
              method: 'POST',
              auth: owner,
              body: { month: '2026-11', action: 'approve', version: submitted.version },
            })
          ).body;
          assert.deepEqual(approved.warning, {
            unconfirmed: 0,
            unresolved: 0,
            sourceMissing: false,
          });
          assert.equal(approved.currentUnconfirmed, 0);
          assert.equal(approved.commission, 20000);
          await ok('/payroll/' + person.id, {
            method: 'POST',
            auth: owner,
            body: {
              month: '2026-11',
              action: 'return',
              version: approved.version,
              note: '노쇼 삭제 복구 검증을 위한 반려',
            },
          });
          await assert.rejects(
            d.owned(
              new Store(svc.db),
              { id: 'other-teacher', role: 'employee', person_id: 'other-person' },
              'lessons',
              saved.lesson_id,
            ),
            (e) => e.status === 403,
          );
          const history = (await ok('/lessons/' + saved.lesson_id + '/signatures', { auth: owner }))
            .body;
          assert.equal(history.items.length, 0);
          assert.ok(history.noShow.recorded_at);
          await ok('/member-mode', {
            method: 'POST',
            auth: owner,
            body: { lessonId: saved.lesson_id },
          });
          assert.equal(
            (
              await req('/member-mode/sign', {
                method: 'POST',
                auth: owner,
                body: { ...body, version: 2, strokes },
              })
            ).status,
            409,
          );
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          await ok('/lessons/' + saved.lesson_id, {
            method: 'DELETE',
            auth: owner,
            body: { version: 2, reason: '노쇼 삭제 복구 검증' },
          });
          assert.equal(await remaining(), 10);
          assert.equal((await pay()).commission, 0);
          assert.ok((await svc.db.collection('lessons').doc(saved.lesson_id).get()).data().no_show);
          const pending = (
            await ok('/lessons', { method: 'POST', auth: owner, body: { ...input, time: '11:00' } })
          ).body;
          await atomic(svc.db, (s) =>
            s.put('payroll_runs', d.pair(person.id, '2026-11'), {
              person_id: person.id,
              month: '2026-11',
              state: 'submitted',
              version: 1,
            }),
          );
          await assert.rejects(
            atomic(svc.db, (s) =>
              d.signLesson(s, { id: 'admin', role: 'admin' }, pending.id, {
                version: 1,
                snapshot: undefined,
                confirmed: true,
                noShow: true,
              }),
            ),
            /수업 내용/,
          );
          const snapshot = await d.snapshot(new Store(svc.db), pending.id);
          await assert.rejects(
            atomic(svc.db, (s) =>
              d.signLesson(s, { id: 'admin', role: 'admin' }, pending.id, {
                version: 1,
                snapshot,
                confirmed: true,
                noShow: true,
              }),
            ),
            /제출/,
          );
          await atomic(svc.db, (s) => s.del('payroll_runs', d.pair(person.id, '2026-11')));
          await ok('/member-mode', { method: 'POST', auth: owner, body: { lessonId: pending.id } });
          await ok('/member-mode/sign', {
            method: 'POST',
            auth: owner,
            body: { version: 1, snapshot, confirmed: true, strokes },
          });
          await ok('/member-mode/exit', { method: 'POST', auth: owner, body: {} });
          await assert.rejects(
            atomic(svc.db, (s) =>
              d.signLesson(s, { id: 'admin', role: 'admin' }, pending.id, {
                version: 1,
                snapshot,
                confirmed: true,
                noShow: true,
              }),
            ),
            /서명/,
          );
        },
      );
      await t.test(
        '대표 계정은 본인 급여 없이 관리자와 같은 조회·등록·정정·삭제 가능',
        async () => {
          const rep = (
            await ok('/people', {
              method: 'POST',
              auth: owner,
              body: { name: '관리자 권한 대표', profile: 'representative', hireMonth: '2026-11' },
            })
          ).body;
          const issued = (
            await ok('/accounts', {
              method: 'POST',
              auth: owner,
              body: {
                username: 'representative',
                password: '0261',
                role: 'employee',
                personId: rep.id,
              },
            })
          ).body;
          assert.equal(issued.role, 'admin');
          let account = (
            await ok('/login', {
              method: 'POST',
              body: { username: 'representative', password: '0261' },
            })
          ).auth;
          assert.equal(
            (await req('/people', { auth: account })).status,
            403,
            '대표도 최초 비밀번호 변경 필요',
          );
          account = (
            await ok('/password', {
              method: 'POST',
              auth: account,
              body: { currentPassword: '0261', password: '0372' },
            })
          ).auth;
          const me = (await ok('/me', { auth: account })).body.user;
          assert.equal(me.role, 'admin');
          assert.equal(me.representative, true);
          assert.equal(me.readOnly, false);
          for (const route of [
            '/people',
            '/members',
            '/accounts',
            '/lessons?month=2026-11',
            '/payroll?month=2026-11',
            '/reconcile?month=2026-11',
          ])
            await ok(route, { auth: account });
          const payroll = (await ok('/payroll?month=2026-11', { auth: account })).body;
          assert.equal(
            payroll.items.some((x) => x.personId === rep.id),
            false,
          );
          assert.equal(
            (await req('/payroll/' + rep.id + '?month=2026-11', { auth: account })).status,
            404,
          );
          const trainer = (
            await ok('/people', {
              method: 'POST',
              auth: account,
              body: { name: '대표 관리 검증 강사', profile: 'standard', hireMonth: '2026-01' },
            })
          ).body;
          const reg = (
            await ok('/registrations', {
              method: 'POST',
              auth: account,
              body: {
                name: '대표 관리 검증 회원',
                personId: trainer.id,
                paidDate: '2026-11-01',
                quantity: 10,
                amount: 0,
                category: 'pt',
                saleType: 'new',
                fixedFee: 20000,
              },
            })
          ).body;
          const lesson = (
            await ok('/lessons', {
              method: 'POST',
              auth: account,
              body: { contractId: reg.contract.id, date: '2026-11-01', time: '10:00' },
            })
          ).body;
          const corrected = (
            await ok('/lessons/' + lesson.id, {
              method: 'PATCH',
              auth: account,
              body: { version: 1, date: '2026-11-01', time: '11:00', reason: '대표 정정 검증' },
            })
          ).body;
          assert.equal(corrected.time, '11:00');
          await ok('/lessons/' + lesson.id, {
            method: 'DELETE',
            auth: account,
            body: { version: corrected.version, reason: '대표 삭제 검증' },
          });
          assert.equal(
            (await ok('/members/' + reg.member.id, { auth: account })).body.contracts[0].remaining,
            10,
          );
          assert.equal(
            (await ok('/payroll/' + trainer.id + '?month=2026-11', { auth: account })).body
              .commission,
            0,
          );
          // Previously issued representative accounts stored as employee receive the same effective permissions.
          await atomic(svc.db, async (s) => {
            const old = await s.get('accounts', issued.id);
            await s.put('accounts', issued.id, { ...old, role: 'employee' });
          });
          assert.equal((await ok('/me', { auth: account })).body.user.role, 'admin');
          await ok('/members', {
            method: 'POST',
            auth: account,
            body: { name: '기존 대표 계정 등록 검증', personId: trainer.id },
          });
          await ok('/accounts', {
            method: 'POST',
            auth: account,
            body: {
              username: 'rep-created-staff',
              password: '0482',
              role: 'employee',
              personId: trainer.id,
            },
          });
          const overview = (await ok('/overview?month=2026-11', { auth: account })).body;
          assert.equal(
            overview.staff.some((x) => x.name === '관리자 권한 대표'),
            false,
          );
        },
      );
    } finally {
      await new Promise((r) => app.server.close(r));
      await svc.db.recursiveDelete(svc.db.collection('signature_payloads'));
    }
  },
);
function digestJSON(v) {
  return JSON.stringify(v);
}
