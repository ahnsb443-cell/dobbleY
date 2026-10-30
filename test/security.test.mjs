import test from 'node:test';
import assert from 'node:assert/strict';
import { password, encode, verify } from '../lib/security.mjs';
import { preparePassword } from '../firebase/auth.mjs';
test('4자리 숫자와 기존 6자 이상만 허용하고 앞자리 0을 유지', () => {
  for (const value of ['0427', '0000', '123456', 'abc123', '긴비밀번호123'])
    assert.equal(password(value), value);
  for (const value of ['123', '12345', 'abcd', 'ab123', 427, null, '1'.repeat(129)])
    assert.throws(() => password(value));
  assert.ok(verify('0427', encode('0427')));
  assert.equal(verify('427', encode('0427')), false);
});
test('Firebase에는 PIN 원문을 전달하지 않으며 계정별 다른 무작위 키 사용', () => {
  const first = preparePassword('0427'),
    second = preparePassword('0427');
  assert.match(first.pinKey, /^[a-f0-9]{64}$/);
  assert.notEqual(first.pinKey, second.pinKey);
  assert.notEqual(first.authPassword, second.authPassword);
  assert.ok(first.authPassword.length >= 6);
  assert.notEqual(first.authPassword, '0427');
  assert.deepEqual(preparePassword('normal123'), { pinKey: null, authPassword: 'normal123' });
});
