import {
  accountView,
  admin,
  owner,
  authenticate,
  issue,
  encode,
  verify,
  password,
  username,
  throttle,
  headers,
} from './security.mjs';
import {
  fail,
  AppError,
  id,
  day,
  month,
  bounds,
  json,
  version,
  text,
  integer,
  digest,
  cursor,
  today,
} from './utils.mjs';
import { profiles, trainer } from './profiles.mjs';
import {
  audit,
  seed,
  person,
  effectivePerson,
  member,
  contract,
  lesson,
  progress,
  snapshot,
  signatureState,
  addPerson,
  addMember,
  addContract,
  addLesson,
  changeLesson,
  signLesson,
  listMembers,
  listLessons,
  result,
  eligible,
} from './domain.mjs';
import {
  setTerms,
  setInputs,
  setRule,
  addSale,
  payrollAction,
  periodAction,
  endEmployment,
  transferMember,
  closeContract,
} from './workflow.mjs';
import {
  sourcePreview,
  importSource,
  reconcile,
  review,
  sourceList,
  sourceSummary,
} from './daygym.mjs';
import { memberImportPreview, importMembers, importHeader } from './import.mjs';
export function createApi(
  s,
  { secureCookies = false, publicOrigin = '', setupToken = '', allowLocalSetup = true } = {},
) {
  seed(s);
  let requests = 0;
  function cookie(raw, age = 43200) {
    return (
      '__session=' +
      raw +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
      age +
      (secureCookies ? '; Secure' : '')
    );
  }
  const me = (a) => ({
    ...accountView(a),
    person: a.person_id
      ? effectivePerson(s, s.one('SELECT * FROM people WHERE id=?', a.person_id))
      : null,
  });
  function memberPayload(a) {
    if (!a.member_lesson_id) fail(409, '진행 중인 회원 확인 화면이 없습니다.');
    const l = lesson(s, a, a.member_lesson_id),
      snap = snapshot(s, l.id),
      confirmation = signatureState(s, l.id),
      sig =
        confirmation.state === 'signed'
          ? s.one('SELECT id,signed_at FROM signatures WHERE id=?', confirmation.signatureId)
          : null;
    return {
      lessonId: l.id,
      version: l.version,
      snapshot: snap,
      confirmation,
      signature: sig
        ? {
            ...sig,
            strokes: json(
              s.one('SELECT strokes FROM signature_payloads WHERE signature_id=?', sig.id).strokes,
            ),
          }
        : null,
    };
  }
  function publicResult(r) {
    if (r.frozen) {
      r.currentUnresolved = reconcile(s, r.month, r.personId).filter(
        (x) =>
          x.kind !== 'matched' &&
          !x.reviewed &&
          !['source-reserved', 'source-cancelled', 'source-absent'].includes(x.kind),
      ).length;
    }
    delete r.internal;
    return r;
  }
  function route(a, url, method, b, req, res) {
    const path = url.pathname.split('/').filter(Boolean),
      m = url.searchParams.get('month') || today().slice(0, 7),
      key = path[2];
    if (url.pathname === '/api/me' && method === 'GET') return { user: me(a), csrf: a.csrf };
    if (url.pathname === '/api/logout' && method === 'POST') {
      s.run('DELETE FROM auth_sessions WHERE hash=?', a.session_hash);
      res.setHeader('Set-Cookie', cookie('', 0));
      return { ok: true };
    }
    if (url.pathname === '/api/password' && method === 'POST') {
      password(b.password);
      if (!verify(b.currentPassword, a.password)) fail(400, '현재 비밀번호가 다릅니다.');
      if (b.currentPassword === b.password) fail(400, '새 비밀번호를 다르게 설정하세요.');
      s.run('DELETE FROM attempts WHERE key=?', digest('password:' + a.id));
      s.run(
        'UPDATE accounts SET password=?,must_change=0,version=version+1 WHERE id=?',
        encode(b.password),
        a.id,
      );
      s.run('DELETE FROM auth_sessions WHERE account_id=?', a.id);
      const updated = s.one('SELECT * FROM accounts WHERE id=?', a.id),
        session = issue(s, updated);
      res.setHeader('Set-Cookie', cookie(session.raw));
      audit(s, a, 'password-change', 'account', a.id);
      return { user: me(updated), csrf: session.csrf };
    }
    if (a.must_change) fail(403, '임시 비밀번호를 먼저 변경하세요.');
    if (url.pathname === '/api/member-mode/exit' && method === 'POST') {
      if (!verify(b.password, a.password)) fail(400, '선생님 비밀번호가 일치하지 않습니다.');
      s.run('DELETE FROM attempts WHERE key=?', digest('unlock:' + a.id));
      s.run('UPDATE auth_sessions SET member_lesson_id=NULL WHERE hash=?', a.session_hash);
      return { ok: true };
    }
    if (url.pathname === '/api/member-mode' && method === 'GET') return memberPayload(a);
    if (url.pathname === '/api/member-mode/sign' && method === 'POST') {
      if (!a.member_lesson_id) fail(409, '먼저 회원 확인 화면을 여세요.');
      return signLesson(s, a, a.member_lesson_id, b);
    }
    if (a.member_lesson_id) {
      const e = new AppError(403, '회원 확인 화면이 진행 중입니다. 선생님 비밀번호로 복귀하세요.');
      e.code = 'MEMBER_MODE';
      throw e;
    }
    if (url.pathname === '/api/member-mode' && method === 'POST') {
      const l = lesson(s, a, b.lessonId);
      if (l.status !== 'active') fail(409, '취소된 수업입니다.');
      s.run('UPDATE auth_sessions SET member_lesson_id=? WHERE hash=?', l.id, a.session_hash);
      a.member_lesson_id = l.id;
      return memberPayload(a);
    }
    if (url.pathname === '/api/people' && method === 'GET')
      return {
        items:
          a.role === 'admin'
            ? s.all('SELECT * FROM people ORDER BY name').map((p) => effectivePerson(s, p))
            : s
                .all('SELECT * FROM people WHERE id=?', a.person_id)
                .map((p) => effectivePerson(s, p)),
        profiles,
      };
    if (url.pathname === '/api/people' && method === 'POST') return addPerson(s, a, b);
    if (path[1] === 'people' && path[3] === 'employment' && method === 'PATCH')
      return endEmployment(s, a, key, b);
    if (path[1] === 'people' && path[3] === 'terms' && method === 'PUT')
      return setTerms(s, a, key, b);
    if (path[1] === 'people' && path[3] === 'inputs' && method === 'PUT')
      return setInputs(s, a, key, month(b.month), b);
    if (path[1] === 'people' && path[3] === 'compensation' && method === 'GET') {
      admin(a);
      person(s, a, key);
      month(m);
      return {
        terms: s.one(
          'SELECT * FROM salary_terms WHERE person_id=? AND effective_month<=? ORDER BY effective_month DESC LIMIT 1',
          key,
          m,
        ),
        exactTerms:
          s.one('SELECT * FROM salary_terms WHERE person_id=? AND effective_month=?', key, m) ||
          null,
        inputs: s.one('SELECT * FROM monthly_inputs WHERE person_id=? AND month=?', key, m) || {
          hours100: 0,
          extra: 0,
          deduction: 0,
          version: 0,
          note: '',
        },
      };
    }
    if (path[1] === 'rules') {
      admin(a);
      if (method === 'GET')
        return {
          items: s
            .all('SELECT * FROM rules ORDER BY profile,effective_month')
            .map((r) => ({ ...r, body: json(r.body) })),
        };
      if (method === 'PUT') return setRule(s, a, b);
    }
    if (path[1] === 'accounts') {
      admin(a);
      if (method === 'GET' && !key)
        return { items: s.all('SELECT * FROM accounts ORDER BY username').map(accountView) };
      if (method === 'POST' && !key) {
        const name = username(b.username);
        password(b.password);
        if (!['admin', 'employee'].includes(b.role)) fail(400, '권한을 확인하세요.');
        const pid = b.personId || null,
          p = pid ? person(s, a, pid) : null;
        if (b.role === 'employee' && !p) fail(400, '직원에게 구성원을 연결하세요.');
        const key = id();
        s.run(
          'INSERT INTO accounts(id,username,password,role,person_id,display_name) VALUES(?,?,?,?,?,?)',
          key,
          name,
          encode(b.password),
          b.role,
          pid,
          p?.name || text(b.name, '계정 이름'),
        );
        audit(s, a, 'create', 'account', key, '', { role: b.role, personId: pid });
        return accountView(s.one('SELECT * FROM accounts WHERE id=?', key));
      }
      if (method === 'PATCH' && key) {
        const target = s.one('SELECT * FROM accounts WHERE id=?', key);
        version(target, b.version);
        if (key === a.id) fail(400, '본인 계정은 비밀번호 메뉴에서 변경하세요.');
        const active =
          b.active === undefined
            ? target.active
            : b.active === true
              ? 1
              : b.active === false
                ? 0
                : fail(400, '활성 상태를 확인하세요.');
        if (
          !active &&
          target.active &&
          target.role === 'admin' &&
          s.one("SELECT count(*) n FROM accounts WHERE role='admin' AND active=1").n <= 1
        )
          fail(409, '마지막 관리자는 중지할 수 없습니다.');
        const pass = b.password === undefined ? target.password : encode(b.password);
        const note = text(b.reason, '계정 변경 사유', 200);
        s.run(
          'UPDATE accounts SET active=?,password=?,must_change=?,version=version+1 WHERE id=?',
          active,
          pass,
          b.password === undefined ? target.must_change : 1,
          key,
        );
        s.run('DELETE FROM auth_sessions WHERE account_id=?', key);
        audit(s, a, 'account-update', 'account', key, note, {
          active,
          passwordReset: b.password !== undefined,
        });
        return { ok: true };
      }
    }
    const training = ['members', 'registrations', 'contracts', 'lessons', 'signatures'];
    if (training.includes(path[1]) && a.role !== 'admin' && !trainer(person(s, a, a.person_id)))
      fail(403, '본인 급여만 조회할 수 있습니다.');
    if (url.pathname === '/api/members' && method === 'GET') return listMembers(s, a, url);
    if (url.pathname === '/api/members' && method === 'POST') return addMember(s, a, b);
    if (path[1] === 'members' && key && method === 'PATCH') return transferMember(s, a, key, b);
    if (path[1] === 'members' && key && method === 'GET') {
      const row = member(s, a, key);
      return {
        member: row,
        contracts: s
          .all('SELECT * FROM contracts WHERE member_id=? ORDER BY paid_date,id', key)
          .map((c) => progress(s, c)),
      };
    }
    if (url.pathname === '/api/registrations' && method === 'POST') {
      const row = b.memberId
        ? member(s, a, b.memberId)
        : addMember(s, a, { name: b.name, personId: b.personId || a.person_id });
      return { member: row, contract: addContract(s, a, { ...b, memberId: row.id }) };
    }
    if (path[1] === 'contracts' && key && path[3] === 'close' && method === 'POST')
      return closeContract(s, a, key, b);
    if (url.pathname === '/api/contracts' && method === 'POST') return addContract(s, a, b);
    if (url.pathname === '/api/lessons' && method === 'GET') return listLessons(s, a, url);
    if (url.pathname === '/api/lessons' && method === 'POST') return addLesson(s, a, b);
    if (path[1] === 'lessons' && key && method === 'PATCH') return changeLesson(s, a, key, b);
    if (path[1] === 'lessons' && key && path[3] === 'signatures' && method === 'GET') {
      lesson(s, a, key);
      return {
        snapshot: snapshot(s, key),
        confirmation: signatureState(s, key),
        items: s
          .all(
            'SELECT id,lesson_id,snapshot,signed_at,payload_hash FROM signatures WHERE lesson_id=? ORDER BY rowid DESC',
            key,
          )
          .map((r) => ({ ...r, snapshot: json(r.snapshot) })),
      };
    }
    if (path[1] === 'signatures' && key && method === 'GET') {
      const sig = s.one('SELECT * FROM signatures WHERE id=?', key);
      if (!sig) fail(404, '서명을 찾을 수 없습니다.');
      owner(a, sig.person_id);
      return {
        id: sig.id,
        snapshot: json(sig.snapshot),
        signedAt: sig.signed_at,
        strokes: json(
          s.one('SELECT strokes FROM signature_payloads WHERE signature_id=?', key).strokes,
        ),
        payloadHash: sig.payload_hash,
      };
    }
    if (path[1] === 'payroll' && !key && method === 'GET') {
      month(m);
      const people =
        a.role === 'admin'
          ? eligible(s, m)
          : s.all('SELECT * FROM people WHERE id=? AND hire_month<=?', a.person_id, m);
      return {
        month: m,
        period: s.one('SELECT * FROM periods WHERE month=?', m) || {
          month: m,
          state: 'open',
          version: 0,
        },
        items: people.map((p) => {
          const r = publicResult(result(s, a, p.id, m));
          delete r.lines;
          delete r.sales;
          return r;
        }),
      };
    }
    if (path[1] === 'payroll' && key && method === 'GET') {
      const r = publicResult(result(s, a, key, month(m)));
      const { lines, sales, ...summary } = r;
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      if (!Number.isSafeInteger(offset)) fail(400, '페이지를 확인하세요.');
      return {
        ...summary,
        lines: lines.slice(offset, offset + 100),
        nextOffset: offset + 100 < lines.length ? offset + 100 : null,
      };
    }
    if (path[1] === 'payroll' && key && method === 'POST')
      return publicResult(payrollAction(s, a, key, month(b.month), b));
    if (path[1] === 'periods' && method === 'POST') return periodAction(s, a, month(key), b);
    if (url.pathname === '/api/sales' && method === 'POST') return addSale(s, a, b);
    if (url.pathname === '/api/sales' && method === 'GET') {
      admin(a);
      const [start, end] = bounds(m),
        limit = 50,
        after = url.searchParams.get('after') || '';
      const items = s.all(
        'SELECT x.*,p.name person_name,me.name member_name FROM sales x LEFT JOIN people p ON p.id=x.person_id LEFT JOIN members me ON me.id=x.member_id WHERE x.date>=? AND x.date<? AND x.id>? ORDER BY x.id LIMIT ?',
        start,
        end,
        after,
        limit + 1,
      );
      return {
        items: items.slice(0, limit),
        next: items.length > limit ? items[limit - 1].id : null,
      };
    }
    if (path[1] === 'import' && path[2] === 'members') {
      admin(a);
      if (method === 'GET') return { header: importHeader };
      if (method === 'POST')
        return path[3] === 'preview' ? memberImportPreview(s, a, b) : importMembers(s, a, b);
    }
    if (path[1] === 'source') {
      admin(a);
      if (url.pathname === '/api/source/summary' && method === 'GET')
        return sourceSummary(s, a, url);
      if (url.pathname === '/api/source/preview' && method === 'POST')
        return sourcePreview(s, a, b);
      if (url.pathname === '/api/source/import' && method === 'POST') return importSource(s, a, b);
      if (url.pathname === '/api/source' && method === 'GET') return sourceList(s, a, url);
      if (key && method === 'PATCH') {
        const row = s.one('SELECT * FROM source_records WHERE id=?', key);
        version(row, b.version);
        const p = b.personId ? person(s, a, b.personId) : null,
          me = b.memberId ? member(s, a, b.memberId) : null,
          c = b.contractId ? contract(s, a, b.contractId) : null;
        if (
          (me &&
            me.person_id !== p?.id &&
            !s.one(
              'SELECT 1 FROM member_assignments WHERE member_id=? AND person_id=? AND effective_date<=? LIMIT 1',
              me.id,
              p?.id || '',
              row.date,
            )) ||
          (c && (c.member_id !== me?.id || c.person_id !== p?.id))
        )
          fail(400, '강사·회원·회원권 연결이 다릅니다.');
        s.run(
          'UPDATE source_records SET person_id=?,member_id=?,contract_id=?,version=version+1 WHERE id=?',
          p?.id || null,
          me?.id || null,
          c?.id || null,
          key,
        );
        audit(s, a, 'source-link', 'source', key, text(b.reason, '연결 사유', 200), {
          personId: p?.id,
          memberId: me?.id,
          contractId: c?.id,
        });
        return { ok: true };
      }
    }
    if (path[1] === 'reconcile') {
      admin(a);
      if (method === 'GET') {
        const rows = reconcile(s, month(m), url.searchParams.get('personId') || null),
          offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) fail(400, '페이지를 확인하세요.');
        if (url.searchParams.get('summary') === '1')
          return {
            total: rows.length,
            unresolved: rows.filter(
              (r) =>
                r.kind !== 'matched' &&
                !r.reviewed &&
                !['source-reserved', 'source-cancelled', 'source-absent'].includes(r.kind),
            ).length,
          };
        return {
          items: rows.slice(offset, offset + 100),
          nextOffset: offset + 100 < rows.length ? offset + 100 : null,
          total: rows.length,
        };
      }
      if (method === 'POST') return review(s, a, b);
    }
    if (path[1] === 'audit' && method === 'GET') {
      admin(a);
      const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) fail(400, '페이지를 확인하세요.');
      const rows = s.all(
        'SELECT x.*,a.display_name actor FROM audit x LEFT JOIN accounts a ON a.id=x.actor_id WHERE x.id<? ORDER BY x.id DESC LIMIT 51',
        before,
      );
      return {
        items: rows.slice(0, 50).map((r) => ({ ...r, details: json(r.details) })),
        next: rows.length > 50 ? rows[49].id : null,
      };
    }
    fail(404, '요청한 기능을 찾을 수 없습니다.');
  }
  return async (req, res) => {
    headers(res);
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    const requestId = id();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, 'http://localhost'),
        method = req.method,
        changing = !['GET', 'HEAD'].includes(method);
      if (changing) {
        const origin = req.headers.origin;
        if (origin) {
          let valid = false;
          try {
            valid = publicOrigin
              ? new URL(origin).origin === publicOrigin
              : new URL(origin).host === req.headers.host;
          } catch {}
          if (!valid) fail(403, '다른 사이트의 요청은 허용하지 않습니다.');
        }
        if (req.headers['sec-fetch-site'] === 'cross-site')
          fail(403, '다른 사이트의 요청은 허용하지 않습니다.');
      }
      let b = {};
      if (changing && url.pathname !== '/api/logout') {
        if (!req.headers['content-type']?.startsWith('application/json'))
          fail(415, 'JSON 요청이 필요합니다.');
        let body = '';
        for await (const part of req) {
          body += part;
          if (Buffer.byteLength(body) > 1024 * 1024) fail(413, '요청은 1MB 이하로 보내세요.');
        }
        try {
          b = JSON.parse(body);
        } catch {
          fail(400, 'JSON 형식을 확인하세요.');
        }
        if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, '입력 형식을 확인하세요.');
      }
      if (url.pathname === '/api/status' && method === 'GET')
        return send(200, {
          setupRequired: !s.one('SELECT id FROM accounts LIMIT 1'),
          remoteSetupTokenRequired:
            !allowLocalSetup ||
            !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress),
          version: '1.0.0',
        });
      if (url.pathname === '/api/setup' && method === 'POST') {
        if (s.one('SELECT id FROM accounts LIMIT 1'))
          fail(409, '관리자 계정이 이미 설정되어 있습니다.');
        throttle(s, 'setup:' + req.socket.remoteAddress);
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (
          !(allowLocalSetup && local) &&
          (!setupToken ||
            typeof b.setupToken !== 'string' ||
            digest(b.setupToken) !== digest(setupToken))
        )
          fail(403, '최초 관리자 설정 코드가 필요합니다.');
        const name = username(b.username),
          pass = encode(b.password),
          display = text(b.name, '관리자 이름');
        const response = s.tx(() => {
          if (s.one('SELECT id FROM accounts LIMIT 1')) fail(409, '이미 설정되었습니다.');
          const key = id();
          s.run(
            "INSERT INTO accounts(id,username,password,role,display_name,must_change) VALUES(?,?,?,'admin',?,0)",
            key,
            name,
            pass,
            display,
          );
          const a = s.one('SELECT * FROM accounts WHERE id=?', key),
            session = issue(s, a);
          audit(s, a, 'setup', 'account', key);
          res.setHeader('Set-Cookie', cookie(session.raw));
          return { user: me(a), csrf: session.csrf };
        });
        return send(201, response);
      }
      if (url.pathname === '/api/login' && method === 'POST') {
        const name = username(b.username);
        throttle(s, 'login-user:' + name);
        throttle(s, 'login-ip:' + req.socket.remoteAddress, 100);
        const a = s.one('SELECT * FROM accounts WHERE username=? COLLATE NOCASE', name),
          ended = a?.person_id
            ? s.one('SELECT end_date FROM people WHERE id=?', a.person_id)?.end_date
            : null;
        if (!verify(b.password, a?.password) || !a?.active || (ended && ended < today()))
          fail(401, '아이디 또는 비밀번호가 다릅니다.');
        const session = issue(s, a);
        s.run(
          'DELETE FROM attempts WHERE key IN (?,?)',
          digest('login-user:' + name),
          digest('login-ip:' + req.socket.remoteAddress),
        );
        res.setHeader('Set-Cookie', cookie(session.raw));
        return send(200, { user: me(a), csrf: session.csrf });
      }
      const a = authenticate(s, req);
      if (!a) fail(401, '로그인이 필요합니다.');
      if (changing && req.headers['x-csrf-token'] !== a.csrf)
        fail(403, '세션을 새로고침하고 다시 시도하세요.');
      if (a.must_change && !['/api/me', '/api/password', '/api/logout'].includes(url.pathname))
        fail(403, '임시 비밀번호를 먼저 변경하세요.');
      if (
        a.member_lesson_id &&
        (![
          '/api/me',
          '/api/logout',
          '/api/member-mode',
          '/api/member-mode/sign',
          '/api/member-mode/exit',
        ].includes(url.pathname) ||
          (url.pathname === '/api/member-mode' && method !== 'GET'))
      ) {
        const e = new AppError(403, '회원 확인 화면이 진행 중입니다.');
        e.code = 'MEMBER_MODE';
        throw e;
      }
      if (changing && url.pathname === '/api/password') throttle(s, 'password:' + a.id);
      if (changing && url.pathname === '/api/member-mode/exit') throttle(s, 'unlock:' + a.id);
      const reusable =
        changing &&
        !['/api/logout', '/api/password', '/api/member-mode/exit', '/api/member-mode'].includes(
          url.pathname,
        );
      const key = reusable ? req.headers['idempotency-key'] : null;
      if (reusable && (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)))
        fail(400, '중복 방지 요청 키가 필요합니다.');
      let value;
      if (changing) {
        value = s.tx(() => {
          const requestHash = digest(JSON.stringify(b)),
            old = key
              ? s.one('SELECT * FROM idempotency WHERE actor_id=? AND key=?', a.id, key)
              : null;
          if (old) {
            if (old.route !== url.pathname || old.request_hash !== requestHash)
              fail(409, '같은 요청 키의 내용이 다릅니다.');
            return json(old.response);
          }
          const r = route(a, url, method, b, req, res);
          if (key)
            s.run(
              'INSERT INTO idempotency VALUES(?,?,?,?,?,?)',
              a.id,
              key,
              url.pathname,
              requestHash,
              JSON.stringify(r),
              new Date().toISOString(),
            );
          return r;
        });
      } else value = route(a, url, method, b, req, res);
      if (++requests % 100 === 0) {
        s.run('DELETE FROM auth_sessions WHERE expires<?', Date.now());
        s.run('DELETE FROM attempts WHERE reset<?', Date.now());
      }
      send(200, value);
    } catch (e) {
      let status = e instanceof AppError ? e.status : 500,
        message = e.message;
      if (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(message)) {
        status = 409;
        message = '중복된 아이디·등록번호 또는 수업 날짜/시간입니다.';
      } else if (e.code === 'ERR_SQLITE_ERROR' && /constraint failed/.test(message)) {
        status = 400;
        message = '연결된 자료 또는 입력 범위를 확인하세요.';
      }
      if (status === 500) {
        console.error('request_error', requestId, e.code || e.name);
        message = '서버 처리 중 오류가 발생했습니다. 요청 번호: ' + requestId;
      }
      send(status, {
        error: message,
        code: e.code === 'MEMBER_MODE' ? e.code : undefined,
        requestId,
      });
    }
    function send(status, value) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    }
  };
}
