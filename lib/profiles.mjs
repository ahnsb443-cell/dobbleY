export const profiles = {
  morning: {
    name: '오전파트',
    base: 500000,
    tax: 330,
    tiers: [
      [0, 35],
      [4000000, 40],
      [5000000, 50],
    ],
    bonus: false,
  },
  standard: {
    name: '일반 트레이너',
    base: 1000000,
    tax: 330,
    tiers: [
      [0, 30],
      [4000000, 40],
      [6000000, 45],
      [8000000, 50],
    ],
    bonus: true,
  },
  mixed: {
    name: 'PT·필라테스 강사',
    base: 1000000,
    tax: 330,
    tiers: [
      [0, 30],
      [4000000, 40],
      [6000000, 45],
      [8000000, 50],
    ],
    bonus: true,
  },
  lead: {
    name: 'PT팀장',
    base: 1200000,
    tax: 330,
    tiers: [
      [0, 45],
      [6000000, 50],
    ],
    bonus: false,
  },
  manager: { name: '총괄매니저', base: 3000000, tax: 330, tiers: [[0, 50]], bonus: false },
  fc: { name: 'FC팀장', base: 2500000, tax: 330, tiers: [[0, 0]], bonus: false },
  staff: { name: '직원', base: 0, tax: 0, tiers: [[0, 0]], bonus: false },
  group: { name: '그룹 시간강사', base: 0, tax: 330, tiers: [[0, 0]], bonus: false },
  daily: { name: '일급 알바', base: 0, tax: 0, tiers: [[0, 0]], bonus: false },
  part: { name: '시급 알바', base: 0, tax: 0, tiers: [[0, 0]], bonus: false },
};
export const trainer = (p) => !['fc', 'staff', 'part', 'daily', 'group'].includes(p.profile);
export const rate = (tiers, amount) =>
  [...tiers].sort((a, b) => b[0] - a[0]).find((t) => Math.max(0, amount) >= t[0])?.[1] || 0;

export const groupInstructor = (p) => p.profile === 'group' || trainer(p);
