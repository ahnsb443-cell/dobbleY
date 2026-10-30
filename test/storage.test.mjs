import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, strokes } from './helpers.mjs';
import {
  addLesson,
  signLesson,
  snapshot,
  listMembers,
  listLessons,
  payroll,
} from '../lib/domain.mjs';
import { backupFile } from '../scripts/backup.mjs';
import { restoreFile } from '../scripts/restore.mjs';
test('4MB 이상 서명 누적과 수년 자료에서도 월별 조회·원본 지연 조회', async () => {
  const f = await fixture();
  try {
    const memberInsert = f.s.db.prepare(
      'INSERT INTO members(id,person_id,name,created_at) VALUES(?,?,?,?)',
    );
    f.s.tx(() => {
      for (let i = 0; i < 120; i++)
        memberInsert.run('member-' + String(i).padStart(3, '0'), f.p.id, '동명이인', '2024-01-01');
    });
    let after = '',
      seen = new Set();
    do {
      const r = listMembers(
        f.s,
        f.user,
        new URL(
          'http://localhost/api/members?limit=20' +
            (after ? '&after=' + encodeURIComponent(after) : ''),
        ),
      );
      for (const m of r.items) {
        assert.ok(!seen.has(m.id));
        seen.add(m.id);
      }
      after = r.next;
    } while (after);
    assert.equal(seen.size, 121);
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' });
    f.s.run('UPDATE people SET hire_month=? WHERE id=?', '2018-01', f.p.id);
    const history = [];
    f.s.tx(() => {
      for (let y = 2018; y <= 2024; y++) {
        const cid = 'historical-' + y;
        f.s.run(
          'INSERT INTO contracts(id,member_id,person_id,paid_date,start_date,category,sale_type,amount,quantity,carry_used,carry_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          cid,
          f.m.id,
          f.p.id,
          y + '-01-01',
          y + '-01-01',
          'pt',
          'new',
          40000000,
          400,
          0,
          y + '-01-01',
        );
        for (let m = 1; m <= 12; m++)
          for (let d = 1; d <= 28; d++) {
            const lid = 'history-' + y + '-' + m + '-' + d,
              date = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            f.s.run(
              'INSERT INTO lessons(id,contract_id,person_id,member_id,date,time,created_at) VALUES(?,?,?,?,?,?,?)',
              lid,
              cid,
              f.p.id,
              f.m.id,
              date,
              '10:00',
              date + 'T01:00:00Z',
            );
            history.push(lid);
          }
      }
    });
    const heavy = Array.from({ length: 3 }, () =>
      Array.from({ length: 1000 }, (_, i) => [((i % 80) + 10) / 100, (((i * 7) % 80) + 10) / 100]),
    );
    f.s.tx(() => {
      for (const lid of history.slice(0, 160))
        signLesson(f.s, f.user, lid, {
          version: 1,
          snapshot: snapshot(f.s, lid),
          confirmed: true,
          strokes: heavy,
        });
    });
    assert.ok(f.s.one('SELECT sum(length(strokes)) n FROM signature_payloads').n > 4 * 1024 * 1024);
    assert.equal(f.s.one('SELECT count(*) n FROM lessons').n, 2353);
    const response = listLessons(
      f.s,
      f.user,
      new URL('http://localhost/api/lessons?month=2026-10&limit=20'),
    );
    assert.equal(response.items.length, 1);
    assert.ok(JSON.stringify(response).length < 10000);
    assert.ok(!JSON.stringify(response).includes('strokes'));
    assert.equal(
      listLessons(f.s, f.user, new URL('http://localhost/api/lessons?month=2025-10')).items.length,
      0,
    );
    assert.equal(
      listLessons(f.s, f.user, new URL('http://localhost/api/lessons?month=2020-10&limit=20')).items
        .length,
      20,
    );
    const plan = f.s
      .all(
        'EXPLAIN QUERY PLAN SELECT * FROM lessons WHERE person_id=? AND date>=? AND date<?',
        f.p.id,
        '2026-10-01',
        '2026-11-01',
      )
      .map((r) => r.detail)
      .join(' ');
    assert.match(plan, /INDEX lessons_month/);
  } finally {
    await f.close();
  }
});
test('실행 중 일관 백업·격리 복원·서명 해시 검증·기존 대상 덮어쓰기 금지', async () => {
  const f = await fixture(),
    out = await mkdtemp(path.join(tmpdir(), 'dy-backup-'));
  try {
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' });
    signLesson(f.s, f.user, l.id, {
      version: 1,
      snapshot: snapshot(f.s, l.id),
      confirmed: true,
      strokes,
    });
    const before = payroll(f.s, f.p, '2026-10').net,
      file = path.join(out, 'backup.sqlite');
    await backupFile(f.s.file, file);
    const restored = await restoreFile(file, path.join(out, 'restored'));
    const db = new DatabaseSync(restored.file);
    assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM signature_payloads').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM auth_sessions').get().n, 0);
    db.close();
    assert.equal(payroll(f.s, f.p, '2026-10').net, before);
    await assert.rejects(restoreFile(file, path.join(out, 'restored')), /exists/);
    await writeFile(file + '.sha256', 'invalid');
    await assert.rejects(restoreFile(file, path.join(out, 'bad')), /checksum/);
  } finally {
    await f.close();
    await rm(out, { recursive: true, force: true });
  }
});
test('알 수 없는 이전 형식 DB를 자동 덮어쓰거나 혼합하지 않는다', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dy-legacy-'));
  try {
    const db = new DatabaseSync(path.join(dir, 'payroll.sqlite'));
    db.exec(
      "CREATE TABLE legacy_records(id TEXT PRIMARY KEY,value TEXT);INSERT INTO legacy_records VALUES('one','preserve')",
    );
    db.close();
    const { openDatabase } = await import('../lib/db.mjs');
    await assert.rejects(openDatabase(dir), /Legacy database/);
    const check = new DatabaseSync(path.join(dir, 'payroll.sqlite'));
    assert.equal(check.prepare('SELECT value FROM legacy_records').get().value, 'preserve');
    assert.equal(
      check.prepare("SELECT count(*) n FROM sqlite_master WHERE name='people'").get().n,
      0,
    );
    check.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
