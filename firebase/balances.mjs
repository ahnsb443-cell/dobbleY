import { id, day, integer, text, digest, fail } from '../lib/utils.mjs';
import { admin, trainer, required, guard, now } from './domain.mjs';

// Opening balances are not new sales. Unknown historical dates remain unknown.
export async function importBalances(s, a, b) {
  admin(a);
  const asOf = day(b.asOf),
    batch = text(b.batch, '이관 식별자', 80);
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 40)
    fail(400, '기초잔여 이관은 1~40행으로 입력하세요.');
  const people = await s.query('people');
  let members = 0,
    contracts = 0,
    duplicates = 0;
  const seen = new Set();
  for (const row of b.rows) {
    const rowNumber = integer(row.row, '원본 행 번호', 1, 10000);
    if (seen.has(rowNumber)) fail(400, '원본 행 번호가 중복됩니다.');
    seen.add(rowNumber);
    const name = text(row.name, '회원명'),
      personName = text(row.instructor, '담당자');
    const owners = people.filter((p) => p.name === personName);
    if (
      owners.length !== 1 ||
      !trainer(owners[0]) ||
      owners[0].hire_month > asOf.slice(0, 7) ||
      (owners[0].end_date && owners[0].end_date < asOf)
    )
      fail(400, '담당자를 확인하세요.');
    const p = owners[0];
    if (!['pt', 'pilates'].includes(row.category)) fail(400, '종목을 확인하세요.');
    const quantity = integer(row.quantity, '전체 횟수', 1, 10000);
    const remaining = integer(row.remaining, '잔여 횟수', 0, quantity);
    const fixedFee = row.fixedFee == null ? null : integer(row.fixedFee, '고정 수업료', 1, 1000000);
    const gross = row.gross == null ? null : integer(row.gross, '부가세 포함 결제액');
    if (gross === null && fixedFee === null)
      fail(400, '금액 미제공 회원권은 고정 수업료가 필요합니다.');
    const amount = gross === null ? 0 : Math.round(gross / 1.1);
    const fingerprint = digest(
      JSON.stringify({
        name,
        personId: p.id,
        category: row.category,
        quantity,
        remaining,
        gross,
        fixedFee,
        asOf,
        product: row.product || '',
      }),
    );
    const contractRef = batch + ':row:' + rowNumber;
    const unique = await s.get('unique_keys', digest('contract:' + contractRef));
    if (unique) {
      const old = await required(s, 'contracts', unique.target);
      if (old.migration_fingerprint !== fingerprint) fail(409, '이미 이관한 행의 내용이 다릅니다.');
      duplicates++;
      continue;
    }
    await guard(s, asOf.slice(0, 7), p.id, true);
    const memberRef = batch + ':member:' + digest(p.id + ':' + name);
    const memberKey = await s.get('unique_keys', digest('member:' + memberRef));
    let member;
    if (memberKey) member = await required(s, 'members', memberKey.target);
    else {
      const existing = await s.query('members', [
        ['person_id', '==', p.id],
        ['name', '==', name],
      ]);
      if (existing.length) fail(409, '동일 이름의 기존 회원을 먼저 대조하세요.');
      member = {
        id: id(),
        name,
        person_id: p.id,
        external_ref: memberRef,
        active: 1,
        version: 1,
        created_at: now(),
      };
      await s.unique('member', memberRef, member.id);
      await s.put('members', member.id, member, { create: true });
      const assignment = {
        id: id(),
        member_id: member.id,
        person_id: p.id,
        effective_date: asOf,
        created_at: now(),
      };
      await s.put('member_assignments', assignment.id, assignment, { create: true });
      await s.audit(a, 'balance-member', 'member', member.id, '사용자 제공 회원표 이관', {
        batch,
        asOf,
      });
      members++;
    }
    const c = {
      id: id(),
      member_id: member.id,
      person_id: p.id,
      category: row.category,
      sale_type: 'migration',
      paid_date: '',
      start_date: asOf,
      carry_date: asOf,
      quantity,
      carry_used: quantity - remaining,
      amount,
      gross_amount: gross,
      vat_amount: gross === null ? null : gross - amount,
      amount_basis: gross === null ? 'unknown' : 'vat-included',
      amount_unknown: gross === null,
      fixed_fee: fixedFee,
      external_ref: contractRef,
      active: 1,
      version: 1,
      migration_baseline: true,
      source_batch: batch,
      source_row: rowNumber,
      source_product: row.product || '1:1 PT',
      migration_fingerprint: fingerprint,
      created_at: now(),
    };
    await s.unique('contract', contractRef, c.id);
    await s.put('contracts', c.id, c, { create: true });
    await s.audit(
      a,
      'balance-contract',
      'contract',
      c.id,
      '11월 2일 기준 기초잔여 이관 · 신규 매출 생성 없음',
      {
        batch,
        asOf,
        quantity,
        remaining,
        carryUsed: c.carry_used,
        grossAmount: gross,
        supplyAmount: amount,
        fixedFee,
      },
    );
    contracts++;
  }
  return { members, contracts, duplicates };
}
