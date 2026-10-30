import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpFixture, randomPassword, strokes } from './helpers.mjs';
test('로그인·개인 격리·멱등 저장·회원 화면 서버 잠금·비밀번호 초기화', async () => {
  const f = await httpFixture();
  try {
    assert.equal((await f.req('/members')).status, 401);
    const initial = await f.req('/setup', {
      method: 'POST',
      body: { username: 'owner', password: randomPassword(), name: '가상 관리자' },
    });
    assert.equal(initial.status, 201);
    const admin = initial.auth;
    assert.ok(admin.cookie.startsWith('__session='));
    const p = await f.req('/people', {
      method: 'POST',
      auth: admin,
      body: { name: '가상 강사', profile: 'morning', hireMonth: '2026-01' },
    });
    assert.equal(p.status, 200);
    const other = await f.req('/people', {
      method: 'POST',
      auth: admin,
      body: { name: '다른 강사', profile: 'standard', hireMonth: '2026-01' },
    });
    const temporary = randomPassword();
    const account = await f.req('/accounts', {
      method: 'POST',
      auth: admin,
      body: { username: 'teacher', password: temporary, role: 'employee', personId: p.body.id },
    });
    assert.equal(account.status, 200);
    assert.ok(!JSON.stringify(account.body).includes(temporary));
    const login = await f.req('/login', {
      method: 'POST',
      body: { username: 'teacher', password: temporary },
    });
    assert.equal((await f.req('/members', { auth: login.auth })).status, 403);
    const permanent = randomPassword(),
      changed = await f.req('/password', {
        method: 'POST',
        auth: login.auth,
        body: { currentPassword: temporary, password: permanent },
      });
    assert.equal(changed.status, 200);
    assert.equal((await f.req('/me', { auth: login.auth })).status, 401);
    const auth = changed.auth;
    assert.equal((await f.req('/people', { auth })).body.items.length, 1);
    assert.equal((await f.req('/accounts', { auth })).status, 403);
    const body = {
      name: '가상 회원',
      personId: p.body.id,
      paidDate: '2026-10-01',
      amount: 5000000,
      quantity: 50,
      saleType: 'new',
      category: 'pt',
    };
    const create = await f.req('/registrations', {
      method: 'POST',
      auth,
      key: 'same-request-key',
      body,
    });
    assert.equal(create.status, 200);
    const again = await f.req('/registrations', {
      method: 'POST',
      auth,
      key: 'same-request-key',
      body,
    });
    assert.equal(again.body.member.id, create.body.member.id);
    assert.equal(f.store.one('SELECT count(*) n FROM members').n, 1);
    assert.equal(
      (
        await f.req('/registrations', {
          method: 'POST',
          auth,
          key: 'same-request-key',
          body: { ...body, amount: 1 },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.req('/members', {
          method: 'POST',
          auth,
          body: { name: '위조', personId: other.body.id },
        })
      ).status,
      403,
    );
    const foreign = (
      await f.req('/members', {
        method: 'POST',
        auth: admin,
        body: { name: '다른 회원', personId: other.body.id },
      })
    ).body;
    assert.equal((await f.req('/members/' + foreign.id, { auth })).status, 403);
    const mine = await f.req('/members', { auth });
    assert.ok(!JSON.stringify(mine.body).includes('다른 회원'));
    const l = (
      await f.req('/lessons', {
        method: 'POST',
        auth,
        body: { contractId: create.body.contract.id, date: '2026-10-07', time: '10:00' },
      })
    ).body;
    const entered = await f.req('/member-mode', { method: 'POST', auth, body: { lessonId: l.id } });
    assert.equal(entered.status, 200);
    assert.equal(entered.body.snapshot.ordinal, 1);
    assert.equal((await f.req('/members', { auth })).status, 403);
    const replay = await f.req('/registrations', {
      method: 'POST',
      auth,
      key: 'same-request-key',
      body,
    });
    assert.equal(replay.status, 403);
    assert.equal(replay.body.code, 'MEMBER_MODE');
    assert.equal((await f.req('/me', { auth })).body.user.memberMode, true);
    const current = entered.body;
    const signed = await f.req('/member-mode/sign', {
      method: 'POST',
      auth,
      body: { version: current.version, snapshot: current.snapshot, confirmed: true, strokes },
    });
    assert.equal(signed.status, 200);
    assert.equal((await f.req('/member-mode', { auth })).body.signature.strokes.length, 1);
    const data = await f.req('/member-mode', { auth });
    assert.ok(!JSON.stringify(data.body).includes('amount'));
    assert.ok(!JSON.stringify(data.body).includes('password'));
    assert.equal(
      (
        await f.req('/member-mode/exit', {
          method: 'POST',
          auth,
          body: { password: 'incorrect-password' },
        })
      ).status,
      400,
    );
    assert.equal((await f.req('/members', { auth })).status, 403);
    await f.req('/member-mode/exit', { method: 'POST', auth, body: { password: permanent } });
    assert.equal((await f.req('/members', { auth })).status, 200);
    assert.equal((await f.req('/payroll?month=2026-10', { auth })).body.items.length, 1);
    const badCsrf = { cookie: auth.cookie, csrf: 'wrong' };
    assert.equal(
      (await f.req('/lessons', { method: 'POST', auth: badCsrf, body: {} })).status,
      403,
    );
    assert.equal(
      (
        await f.req('/members', {
          method: 'POST',
          auth,
          origin: 'https://other.invalid',
          body: { name: '위조' },
        })
      ).status,
      403,
    );
    const latest = (await f.req('/accounts', { auth: admin })).body.items.find(
      (a) => a.id === account.body.id,
    );
    const reset = await f.req('/accounts/' + account.body.id, {
      method: 'PATCH',
      auth: admin,
      body: { version: latest.version, password: randomPassword(), reason: '분실 초기화' },
    });
    assert.equal(reset.status, 200);
    assert.equal((await f.req('/me', { auth })).status, 401);
    assert.equal((await fetch(f.origin + '/.data/payroll.sqlite')).status, 404);
    assert.equal((await fetch(f.origin + '/lib/api.mjs')).status, 404);
  } finally {
    await f.close();
  }
});
test('동시 수업 저장: 같은 시간 중복 차단, 다른 회원·직원은 정상 저장', async () => {
  const f = await httpFixture();
  try {
    const setup = await f.req('/setup', {
        method: 'POST',
        body: { username: 'owner', password: randomPassword(), name: '관리자' },
      }),
      auth = setup.auth;
    const p = (
      await f.req('/people', {
        method: 'POST',
        auth,
        body: { name: '가상쌤', profile: 'morning', hireMonth: '2026-01' },
      })
    ).body;
    const regs = [];
    for (let i = 0; i < 2; i++)
      regs.push(
        (
          await f.req('/registrations', {
            method: 'POST',
            auth,
            body: {
              name: '회원' + i,
              personId: p.id,
              paidDate: '2026-10-01',
              amount: 1000000,
              quantity: 10,
              category: 'pt',
              saleType: 'new',
            },
          })
        ).body,
      );
    const b = { contractId: regs[0].contract.id, date: '2026-10-07', time: '10:00' };
    const r = await Promise.all([
      f.req('/lessons', { method: 'POST', auth, body: b }),
      f.req('/lessons', { method: 'POST', auth, body: b }),
    ]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
    const another = await f.req('/lessons', {
      method: 'POST',
      auth,
      body: { ...b, contractId: regs[1].contract.id },
    });
    assert.equal(another.status, 200);
    assert.equal(f.store.one('SELECT count(*) n FROM lessons').n, 2);
  } finally {
    await f.close();
  }
});
test('계약 종료 다음 날부터 로그인·기존 세션 차단, 종료 월까지 정산', async () => {
  const f = await httpFixture();
  try {
    const setup = await f.req('/setup', {
        method: 'POST',
        body: { username: 'owner', password: randomPassword(), name: '관리자' },
      }),
      auth = setup.auth;
    const p = (
      await f.req('/people', {
        method: 'POST',
        auth,
        body: { name: '종료 가상쌤', profile: 'morning', hireMonth: '2026-01' },
      })
    ).body;
    const pass = randomPassword();
    await f.req('/accounts', {
      method: 'POST',
      auth,
      body: { username: 'leaver', password: pass, role: 'employee', personId: p.id },
    });
    const signed = await f.req('/login', {
      method: 'POST',
      body: { username: 'leaver', password: pass },
    });
    assert.equal(signed.status, 200);
    const end = await f.req('/people/' + p.id + '/employment', {
      method: 'PATCH',
      auth,
      body: { version: p.version, endDate: '2026-10-29', reason: '계약 종료' },
    });
    assert.equal(end.status, 200);
    assert.equal((await f.req('/me', { auth: signed.auth })).status, 401);
    assert.equal(
      (await f.req('/login', { method: 'POST', body: { username: 'leaver', password: pass } }))
        .status,
      401,
    );
    assert.equal((await f.req('/payroll?month=2026-10', { auth })).body.items.length, 1);
    assert.equal((await f.req('/payroll?month=2026-11', { auth })).body.items.length, 0);
  } finally {
    await f.close();
  }
});
test('일반 직원은 급여만 조회하며 회원·수업·급여 조건 입력은 서버에서 차단', async () => {
  const f = await httpFixture();
  try {
    const setup = await f.req('/setup', {
        method: 'POST',
        body: { username: 'owner', password: randomPassword(), name: '관리자' },
      }),
      auth = setup.auth;
    const p = (
      await f.req('/people', {
        method: 'POST',
        auth,
        body: { name: '가상 일반직원', profile: 'staff', hireMonth: '2026-01', base: 2000000 },
      })
    ).body;
    const temp = randomPassword();
    await f.req('/accounts', {
      method: 'POST',
      auth,
      body: { username: 'staff', password: temp, role: 'employee', personId: p.id },
    });
    const first = await f.req('/login', {
        method: 'POST',
        body: { username: 'staff', password: temp },
      }),
      changed = await f.req('/password', {
        method: 'POST',
        auth: first.auth,
        body: { currentPassword: temp, password: randomPassword() },
      }),
      employee = changed.auth;
    assert.equal((await f.req('/members', { auth: employee })).status, 403);
    assert.equal((await f.req('/lessons?month=2026-10', { auth: employee })).status, 403);
    const pay = await f.req('/payroll?month=2026-10', { auth: employee });
    assert.equal(pay.body.items.length, 1);
    assert.equal(pay.body.items[0].net, 2000000);
    assert.equal(
      (
        await f.req('/people/' + p.id + '/inputs', {
          method: 'PUT',
          auth: employee,
          body: {
            month: '2026-10',
            version: 0,
            hours100: 0,
            extra: 999999,
            deduction: 0,
            note: '위조',
          },
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});
