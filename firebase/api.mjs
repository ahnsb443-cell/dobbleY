import { Store, atomic } from './store.mjs';
import {
  id,
  fail,
  AppError,
  digest,
  month,
  today,
  version,
  text,
  page,
  cursor,
  integer,
} from '../lib/utils.mjs';
import { headers } from '../lib/security.mjs';
import * as d from './domain.mjs';
import * as w from './workflow.mjs';
import * as imp from './imports.mjs';
import * as auth from './auth.mjs';
export function createFirebaseApi(
  svc,
  { secureCookies = true, publicOrigin = '', setupToken = '' } = {},
) {
  async function memberPayload(s, a) {
    if (!a.member_lesson_id) fail(409, '진행 중인 회원 확인 화면이 없습니다.');
    const l = await d.owned(s, a, 'lessons', a.member_lesson_id),
      confirmation = await d.confirmation(s, l);
    const sig =
      confirmation.state === 'signed' ? await s.get('signatures', confirmation.signatureId) : null;
    return {
      lessonId: l.id,
      version: l.version,
      snapshot: await d.snapshot(s, l.id),
      confirmation,
      signature: sig
        ? {
            id: sig.id,
            signed_at: sig.signed_at,
            strokes: JSON.parse((await d.required(s, 'signature_payloads', sig.id)).strokes),
          }
        : null,
    };
  }
  async function route(s, a, url, method, b) {
    const path = url.pathname.split('/').filter(Boolean),
      kind = path[1],
      key = path[2],
      m = month(url.searchParams.get('month') || today().slice(0, 7));
    if (kind === 'me') return { user: await auth.userView(s, a), csrf: a.csrf };
    if (kind === 'logout') {
      await s.del('auth_sessions', a.session_hash);
      return { ok: true };
    }
    if (kind === 'member-mode') {
      const session = await d.required(s, 'auth_sessions', a.session_hash);
      if (path[2] === 'exit' && method === 'POST') {
        await s.put('auth_sessions', a.session_hash, { ...session, member_lesson_id: null });
        return { ok: true };
      }
      if (path[2] === 'sign' && method === 'POST') return d.signLesson(s, a, a.member_lesson_id, b);
      if (method === 'POST') {
        const l = await d.owned(s, a, 'lessons', b.lessonId);
        if (l.status !== 'active') fail(409, '취소된 수업입니다.');
        await s.put('auth_sessions', a.session_hash, { ...session, member_lesson_id: l.id });
        a = { ...a, member_lesson_id: l.id };
      }
      return memberPayload(s, a);
    }
    if (kind === 'people') {
      if (!key && method === 'GET') {
        const items = [];
        for (const p of a.role === 'admin'
          ? await s.query('people')
          : [await d.required(s, 'people', a.person_id)])
          items.push(await d.person(s, a, p.id));
        return { items: items.sort((a, b) => a.name.localeCompare(b.name)), profiles: d.profiles };
      }
      if (!key && method === 'POST') return d.addPerson(s, a, b);
      if (path[3] === 'employment' && method === 'PATCH') return w.employment(s, a, key, b);
      if (['terms', 'inputs'].includes(path[3]) && method === 'PUT')
        return w.settings(s, a, path[3], key, b);
      if (path[3] === 'compensation' && method === 'GET') {
        d.admin(a);
        await d.person(s, a, key);
        return {
          terms: await d.termsAt(s, key, m),
          exactTerms: await s.get('salary_terms', d.pair(key, m)),
          inputs: (await s.get('monthly_inputs', d.pair(key, m))) || {
            hours100: 0,
            extra: 0,
            deduction: 0,
            version: 0,
            note: '',
          },
        };
      }
    }
    if (kind === 'rules') {
      d.admin(a);
      if (method === 'GET') {
        const saved = await s.query('rules'),
          defaults = Object.entries(d.profiles).map(([profile, r]) => ({
            id: 'default-' + profile,
            profile,
            effective_month: '2000-01',
            version: 1,
            body: { tiers: r.tiers, bonus: r.bonus },
          }));
        return {
          items: [...defaults, ...saved].sort(
            (a, b) =>
              a.profile.localeCompare(b.profile) ||
              a.effective_month.localeCompare(b.effective_month),
          ),
        };
      }
      if (method === 'PUT') return w.settings(s, a, 'rules', null, b);
    }
    if (kind === 'accounts') {
      d.admin(a);
      if (method === 'GET') return { items: (await s.query('accounts')).map(auth.accountView) };
    }
    if (
      ['members', 'registrations', 'contracts', 'lessons', 'signatures'].includes(kind) &&
      a.role !== 'admin' &&
      !d.trainer(await d.person(s, a, a.person_id))
    )
      fail(403, '본인 급여만 조회할 수 있습니다.');
    if (kind === 'members') {
      if (!key && method === 'GET') return d.listMembers(s, a, url);
      if (!key && method === 'POST') return d.addMember(s, a, b);
      if (key && method === 'PATCH') return w.transfer(s, a, key, b);
      if (key && method === 'GET') {
        const member = await d.owned(s, a, 'members', key),
          contracts = [];
        for (const c of await s.query('contracts', [['member_id', '==', key]]))
          contracts.push(await d.progress(s, c));
        return {
          member,
          contracts: contracts.sort(
            (a, b) => a.paid_date.localeCompare(b.paid_date) || a.id.localeCompare(b.id),
          ),
        };
      }
    }
    if (kind === 'registrations' && method === 'POST') {
      const member = b.memberId
        ? await d.owned(s, a, 'members', b.memberId)
        : await d.addMember(s, a, { name: b.name, personId: b.personId || a.person_id });
      return { member, contract: await d.addContract(s, a, { ...b, memberId: member.id }) };
    }
    if (kind === 'contracts') {
      if (!key && method === 'POST') return d.addContract(s, a, b);
      if (path[3] === 'close' && method === 'POST') return w.closeContract(s, a, key, b);
    }
    if (kind === 'lessons') {
      if (!key && method === 'GET') return d.listLessons(s, a, url);
      if (!key && method === 'POST') return d.addLesson(s, a, b);
      if (key && method === 'PATCH') return d.changeLesson(s, a, key, b);
      if (path[3] === 'signatures' && method === 'GET') {
        const l = await d.owned(s, a, 'lessons', key),
          items = await s.query('signatures', [['lesson_id', '==', key]], {
            order: [['signed_at', 'desc']],
          });
        return {
          snapshot: await d.snapshot(s, key),
          confirmation: await d.confirmation(s, l),
          items: items.map(({ id, lesson_id, snapshot, signed_at, payload_hash }) => ({
            id,
            lesson_id,
            snapshot,
            signed_at,
            payload_hash,
          })),
        };
      }
    }
    if (kind === 'signatures' && method === 'GET') {
      const sig = await d.owned(s, a, 'signatures', key);
      return {
        id: sig.id,
        snapshot: sig.snapshot,
        signedAt: sig.signed_at,
        strokes: JSON.parse((await d.required(s, 'signature_payloads', key)).strokes),
        payloadHash: sig.payload_hash,
      };
    }
    if (kind === 'payroll') {
      if (!key && method === 'GET') {
        const people =
            a.role === 'admin' ? await d.eligible(s, m) : [await d.person(s, a, a.person_id, m)],
          items = [];
        for (const p of people) {
          const r = await d.result(s, a, p.id, m);
          delete r.lines;
          delete r.sales;
          items.push(r);
        }
        return {
          month: m,
          period: (await s.get('periods', m)) || { month: m, state: 'open', version: 0 },
          items,
        };
      }
      if (key && method === 'GET') {
        const r = await d.result(s, a, key, m),
          offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) fail(400, '페이지를 확인하세요.');
        const { lines, sales, ...summary } = r;
        return {
          ...summary,
          lines: lines.slice(offset, offset + 100),
          nextOffset: offset + 100 < lines.length ? offset + 100 : null,
        };
      }
      if (key && method === 'POST') return w.payrollAction(s, a, key, month(b.month), b);
    }
    if (kind === 'periods' && method === 'POST') return w.periodAction(s, a, month(key), b);
    if (kind === 'sales') {
      d.admin(a);
      if (method === 'POST') return w.addSale(s, a, b);
      if (method === 'GET') {
        let rows = (await d.monthRows(s, 'sales', m)).sort((a, b) => a.id.localeCompare(b.id)),
          after = url.searchParams.get('after');
        if (after) rows = rows.filter((r) => r.id > after);
        const items = [];
        for (const r of rows.slice(0, 50))
          items.push({
            ...r,
            person_name: r.person_id ? (await d.required(s, 'people', r.person_id)).name : null,
            member_name: r.member_id ? (await d.required(s, 'members', r.member_id)).name : null,
          });
        return { items, next: rows.length > 50 ? items.at(-1).id : null };
      }
    }
    if (kind === 'import' && key === 'members') {
      d.admin(a);
      if (method === 'GET') return { header: imp.importHeader };
      if (method === 'POST')
        return path[3] === 'preview' ? imp.memberPreview(s, a, b) : imp.importMembers(s, a, b);
    }
    if (kind === 'source') {
      d.admin(a);
      if (key === 'preview' && method === 'POST') return imp.sourcePreview(s, a, b);
      if (key === 'import' && method === 'POST') return imp.importSource(s, a, b);
      if (key === 'summary' && method === 'GET') return imp.sourceSummary(s, m, url);
      if (key && method === 'PATCH') return imp.linkSource(s, a, key, b);
      if (!key && method === 'GET') {
        const { after, limit } = page(url);
        let rows = (await d.monthRows(s, 'source_records', m)).sort(
          (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
        );
        if (after)
          rows = rows.filter((r) => r.date > after[0] || (r.date === after[0] && r.id > after[1]));
        const items = rows.slice(0, limit);
        return {
          items,
          next: rows.length > limit ? cursor(items.at(-1).date, items.at(-1).id) : null,
        };
      }
    }
    if (kind === 'reconcile') {
      d.admin(a);
      if (method === 'POST') return imp.review(s, a, b);
      const items = await imp.reconcile(s, m, url.searchParams.get('personId') || null),
        offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) fail(400, '페이지를 확인하세요.');
      if (url.searchParams.get('summary') === '1')
        return {
          total: items.length,
          unresolved: items.filter(
            (r) =>
              r.kind !== 'matched' &&
              !r.reviewed &&
              !['source-reserved', 'source-cancelled', 'source-absent'].includes(r.kind),
          ).length,
        };
      return {
        items: items.slice(offset, offset + 100),
        nextOffset: offset + 100 < items.length ? offset + 100 : null,
        total: items.length,
      };
    }
    if (kind === 'audit' && method === 'GET') {
      d.admin(a);
      const before = url.searchParams.get('before'),
        filters = before ? [['id', '<', before]] : [];
      const items = await s.query('audit', filters, {
        order: [['id', 'desc']],
        limit: 50,
        allowMore: true,
      });
      return { items: items.slice(0, 50), next: items.length > 50 ? items[49].id : null };
    }
    fail(404, '요청한 기능을 찾을 수 없습니다.');
  }
  return async (req, res) => {
    headers(res);
    const requestId = id();
    res.setHeader('X-Request-Id', requestId);
    const send = (status, value) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://localhost'),
        path = url.pathname,
        method = req.method,
        changing = !['GET', 'HEAD'].includes(method);
      if (changing) {
        const origin = req.headers.origin;
        if (
          req.headers['sec-fetch-site'] === 'cross-site' ||
          (origin &&
            (publicOrigin
              ? new URL(origin).origin !== publicOrigin
              : new URL(origin).host !== req.headers.host))
        )
          fail(403, '다른 사이트의 요청은 허용하지 않습니다.');
      }
      let b = {};
      if (changing && path !== '/api/logout') {
        if (!req.headers['content-type']?.startsWith('application/json'))
          fail(415, 'JSON 요청이 필요합니다.');
        const raw = req.rawBody;
        if (raw) {
          if (raw.length > 1024 * 1024) fail(413, '요청은 1MB 이하로 보내세요.');
          try {
            b = JSON.parse(raw.toString());
          } catch {
            fail(400, 'JSON 형식을 확인하세요.');
          }
        } else {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 1024 * 1024) fail(413, '요청은 1MB 이하로 보내세요.');
          }
          try {
            b = JSON.parse(body);
          } catch {
            fail(400, 'JSON 형식을 확인하세요.');
          }
        }
        if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, '입력 형식을 확인하세요.');
      }
      if (await new Store(svc.db).get('control', 'restore_in_progress'))
        fail(503, '자료 복원 중입니다. 운영자 확인 후 접속하세요.');
      if (path === '/api/status' && method === 'GET')
        return send(200, {
          setupRequired: !(await new Store(svc.db).get('control', 'bootstrap')),
          remoteSetupTokenRequired: true,
          version: '2.0.0-firebase',
          storage: 'firestore',
        });
      if (path === '/api/setup' && method === 'POST') {
        await auth.throttle(svc.db, 'setup:' + req.socket.remoteAddress);
        if (
          !setupToken ||
          typeof b.setupToken !== 'string' ||
          digest(b.setupToken) !== digest(setupToken)
        )
          fail(403, '최초 관리자 설정 코드가 필요합니다.');
        if (await new Store(svc.db).get('control', 'bootstrap')) fail(409, '이미 설정되었습니다.');
        const display = text(b.name, '관리자 이름');
        await auth.provision(svc, b, async (uid, name) =>
          atomic(svc.db, async (s) => {
            if (await s.get('control', 'bootstrap')) fail(409, '이미 설정되었습니다.');
            const a = {
              id: uid,
              username: name,
              role: 'admin',
              person_id: null,
              display_name: display,
              active: 1,
              must_change: 0,
              version: 1,
            };
            await s.put('accounts', uid, a, { create: true });
            await s.put('control', 'schema', {
              version: 1,
              storage: 'firestore',
              created_at: d.now(),
            });
            await s.put('control', 'bootstrap', { created_at: d.now(), account_id: uid });
            await s.audit(a, 'setup', 'account', uid);
          }),
        );
        return send(
          201,
          await auth.issueSession(
            svc,
            (await auth.signIn(svc.projectId, b.username, b.password)).idToken,
            secureCookies,
            res,
          ),
        );
      }
      if (path === '/api/login' && method === 'POST') {
        const name = auth.username(b.username);
        await auth.throttle(svc.db, 'login-user:' + name);
        await auth.throttle(svc.db, 'login-ip:' + req.socket.remoteAddress, 100);
        const login = await auth.signIn(svc.projectId, name, b.password),
          value = await auth.issueSession(svc, login.idToken, secureCookies, res);
        await atomic(svc.db, async (s) => {
          await s.del('attempts', digest('login-user:' + name));
        });
        return send(200, value);
      }
      let a = await auth.authenticate(svc, req);
      auth.checkSession(a, path, method);
      if (changing && req.headers['x-csrf-token'] !== a.csrf) fail(403, '세션을 새로고침하세요.');
      if (path === '/api/password' && method === 'POST') {
        auth.password(b.password);
        if (b.password === b.currentPassword) fail(400, '다른 새 비밀번호를 사용하세요.');
        await auth.throttle(svc.db, 'password:' + a.id);
        await auth.signIn(svc.projectId, a.username, b.currentPassword);
        // Fail closed first: pending operation invalidates old sessions before Auth mutation.
        await atomic(svc.db, async (s) => {
          const actor = await auth.freshActor(s, a);
          auth.checkSession(actor, path, method);
          await s.put('accounts', a.id, {
            ...(await d.required(s, 'accounts', a.id)),
            must_change: 1,
            version: actor.version + 1,
          });
          await s.audit(actor, 'password-change', 'account', a.id);
        });
        await svc.auth.updateUser(a.id, { password: b.password });
        await svc.auth.revokeRefreshTokens(a.id);
        await atomic(svc.db, async (s) => {
          const account = await d.required(s, 'accounts', a.id);
          if (account.version !== a.version + 1)
            fail(409, '계정 상태가 변경되었습니다. 관리자에게 확인하세요.');
          await s.put('accounts', a.id, { ...account, must_change: 0 });
        });
        return send(
          200,
          await auth.issueSession(
            svc,
            (await auth.signIn(svc.projectId, a.username, b.password)).idToken,
            secureCookies,
            res,
          ),
        );
      }
      if (path === '/api/member-mode/exit' && method === 'POST') {
        await auth.throttle(svc.db, 'unlock:' + a.id);
        await auth.signIn(svc.projectId, a.username, b.password);
      }
      if (path === '/api/accounts' && method === 'POST') {
        d.admin(a);
        if (!['admin', 'employee'].includes(b.role)) fail(400, '권한을 확인하세요.');
        const value = await auth.provision(svc, b, async (uid, name) =>
          atomic(svc.db, async (s) => {
            const actor = await auth.freshActor(s, a);
            auth.checkSession(actor, path, method);
            d.admin(actor);
            const p = b.personId ? await d.person(s, actor, b.personId) : null;
            if (b.role === 'employee' && !p) fail(400, '직원 구성원을 연결하세요.');
            if (p) await s.unique('account-person', p.id, uid);
            const account = {
              id: uid,
              username: name,
              role: b.role,
              person_id: p?.id || null,
              display_name: p?.name || text(b.name, '이름'),
              active: 1,
              must_change: 1,
              version: 1,
            };
            await s.put('accounts', uid, account, { create: true });
            await s.audit(actor, 'create', 'account', uid);
            return auth.accountView(account);
          }),
        );
        return send(200, value);
      }
      if (path.startsWith('/api/accounts/') && method === 'PATCH') {
        d.admin(a);
        const uid = path.split('/')[3];
        if (uid === a.id) fail(400, '본인 계정은 비밀번호 메뉴에서 변경하세요.');
        if (b.password !== undefined) auth.password(b.password);
        await atomic(svc.db, async (s) => {
          const actor = await auth.freshActor(s, a);
          auth.checkSession(actor, path, method);
          d.admin(actor);
          const old = await d.required(s, 'accounts', uid);
          version(old, b.version);
          if (b.active !== undefined && typeof b.active !== 'boolean')
            fail(400, '활성 상태를 확인하세요.');
          const active = b.active === undefined ? old.active : b.active ? 1 : 0,
            reason = text(b.reason, '변경 사유', 300);
          if (
            !active &&
            old.role === 'admin' &&
            (
              await s.query('accounts', [
                ['role', '==', 'admin'],
                ['active', '==', 1],
              ])
            ).length <= 1
          )
            fail(409, '마지막 관리자는 중지할 수 없습니다.');
          await s.put('accounts', uid, {
            ...old,
            active: b.password !== undefined ? 0 : active,
            pending_active: active,
            must_change: b.password !== undefined ? 1 : old.must_change,
            version: old.version + 1,
          });
          await s.audit(actor, 'account-update', 'account', uid, reason, {
            active,
            passwordReset: b.password !== undefined,
          });
        });
        if (b.password !== undefined) {
          await svc.auth.updateUser(uid, { password: b.password });
          await svc.auth.revokeRefreshTokens(uid);
          await atomic(svc.db, async (s) => {
            const r = await d.required(s, 'accounts', uid);
            if (r.version !== b.version + 1)
              fail(409, '계정 상태가 변경되었습니다. 다시 초기화하세요.');
            await s.put('accounts', uid, { ...r, active: r.pending_active });
          });
        }
        return send(200, { ok: true });
      }
      const reusable =
        changing && !['/api/logout', '/api/member-mode', '/api/member-mode/exit'].includes(path);
      const key = reusable ? req.headers['idempotency-key'] : null;
      if (reusable && (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)))
        fail(400, '중복 방지 요청 키가 필요합니다.');
      const value = await atomic(svc.db, async (s) => {
        a = await auth.freshActor(s, a);
        auth.checkSession(a, path, method);
        const hash = digest(JSON.stringify(b)),
          tag = key ? digest(a.id + ':' + key) : null,
          old = tag ? await s.get('idempotency', tag) : null;
        if (old) {
          if (old.route !== method + ' ' + path || old.request_hash !== hash)
            fail(409, '같은 요청 키의 내용이 다릅니다.');
          return JSON.parse(old.response);
        }
        const out = await route(s, a, url, method, b);
        if (tag)
          await s.put('idempotency', tag, {
            id: tag,
            actor_id: a.id,
            route: method + ' ' + path,
            request_hash: hash,
            response: JSON.stringify(out),
            created_at: d.now(),
          });
        return out;
      });
      if (path === '/api/logout')
        res.setHeader('Set-Cookie', auth.sessionCookie('', secureCookies, 0));
      send(200, value);
    } catch (e) {
      let status = e.status || 500;
      if (e.code === 6 || e.code === 'already-exists') status = 409;
      if (e.code === 10 || e.code === 4) status = 409;
      if (status >= 500) console.error('firebase_request_error', requestId, e.code || e.name);
      send(status, {
        error:
          status >= 500
            ? '서버 처리 오류입니다. 요청 번호: ' + requestId
            : status === 409 && !e.status
              ? '동시 변경이 발생했습니다. 다시 조회하세요.'
              : e.message,
        code: e.code === 'MEMBER_MODE' ? e.code : undefined,
        requestId,
      });
    }
  };
}
