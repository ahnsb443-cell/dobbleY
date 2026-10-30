import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, strokes } from './helpers.mjs';
import {
  addLesson,
  snapshot,
  signLesson,
  signatureState,
  changeLesson,
  addPerson,
} from '../lib/domain.mjs';
test('서명은 날짜와 회차를 구분하고 원본·서버 시각을 보관', async () => {
  const f = await fixture();
  try {
    f.s.run('UPDATE contracts SET carry_used=4 WHERE id=?', f.c.id);
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' }),
      snap = snapshot(f.s, l.id);
    assert.equal(snap.ordinal, 5);
    assert.equal(snap.remaining, 45);
    const sig = signLesson(f.s, f.user, l.id, {
      version: l.version,
      snapshot: snap,
      confirmed: true,
      strokes,
    });
    assert.ok(sig.signed_at);
    assert.equal(signatureState(f.s, l.id).state, 'signed');
    assert.throws(
      () => f.s.run('UPDATE signatures SET signed_at=? WHERE id=?', '2000-01-01', sig.id),
      /immutable/,
    );
    assert.throws(
      () => f.s.run('DELETE FROM signature_payloads WHERE signature_id=?', sig.id),
      /immutable/,
    );
  } finally {
    await f.close();
  }
});
test('빈 서명·다른 직원·스냅샷 위조·중복 서명 거부', async () => {
  const f = await fixture();
  try {
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' }),
      snap = snapshot(f.s, l.id),
      b = { version: 1, snapshot: snap, confirmed: true, strokes };
    assert.throws(
      () => signLesson(f.s, f.user, l.id, { ...b, strokes: [] }),
      (e) => e.status === 400,
    );
    assert.throws(
      () => signLesson(f.s, { role: 'employee', person_id: 'other' }, l.id, b),
      (e) => e.status === 403,
    );
    assert.throws(
      () => signLesson(f.s, f.user, l.id, { ...b, snapshot: { ...snap, ordinal: 99 } }),
      (e) => e.status === 409,
    );
    signLesson(f.s, f.user, l.id, b);
    assert.throws(
      () => signLesson(f.s, f.user, l.id, b),
      (e) => e.status === 409,
    );
  } finally {
    await f.close();
  }
});
test('정정·과거 수업 추가는 재서명, 뒤 수업 추가는 유지', async () => {
  const f = await fixture();
  try {
    const l = addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-07', time: '10:00' });
    signLesson(f.s, f.user, l.id, {
      version: 1,
      snapshot: snapshot(f.s, l.id),
      confirmed: true,
      strokes,
    });
    addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-08', time: '10:00' });
    assert.equal(signatureState(f.s, l.id).state, 'signed');
    addLesson(f.s, f.user, { contractId: f.c.id, date: '2026-10-06', time: '10:00' });
    assert.equal(signatureState(f.s, l.id).state, 'stale');
    const old = f.s.one('SELECT snapshot FROM signatures WHERE lesson_id=?', l.id);
    changeLesson(f.s, f.user, l.id, {
      version: 1,
      date: '2026-10-09',
      time: '10:00',
      reason: '가상 날짜 정정',
    });
    assert.equal(JSON.parse(old.snapshot).date, '2026-10-07');
    assert.throws(
      () => changeLesson(f.s, f.user, l.id, { version: 2, void: true, reason: '가상 취소' }),
      (e) => e.status === 403,
    );
  } finally {
    await f.close();
  }
});
