const { t, eq, ok, report } = require('./harness');
const { env, applyOut } = require('./cl-fixture');

// 金額の丸め。
//
// 大会の最小単位は100万円。率をかける計算（補填80% / 手数料10% / 売り手受取90%）は
// そのままだと 2,640万 や 80万 のような、参加者が扱えない端数になる。
// 10万の位で四捨五入して100万円単位に揃える。
//
// 直接入力された金額（交渉額・獲得額）は丸めない。
// 入れた数字が黙って変わると、何を合意したのか追えなくなる。

const M = 1000000;

t('10万の位で四捨五入する', () => {
  const e = env();
  eq(e._roundMoney(26400000), 26000000, '2,640万 → 2,600万');
  eq(e._roundMoney(800000), 1000000, '80万 → 100万');
  eq(e._roundMoney(64000000), 64000000, '元から100万単位なら動かない');
});

t('ちょうど50万は切り上げる', () => {
  const e = env();
  eq(e._roundMoney(1500000), 2000000);
  eq(e._roundMoney(500000), 1000000);
});

t('49万以下は切り捨てる', () => {
  const e = env();
  eq(e._roundMoney(1400000), 1000000);
  eq(e._roundMoney(490000), 0);
});

t('0とマイナスも扱える', () => {
  const e = env();
  eq(e._roundMoney(0), 0);
  eq(e._roundMoney(-26400000), -26000000);
});

t('数値でないものは0', () => {
  const e = env();
  eq(e._roundMoney(''), 0);
  eq(e._roundMoney(null), 0);
});

// =============================================================================
// 補填金
// =============================================================================

/** 在籍の獲得額を変えて請求を立て直す */
function claimFor(e, cost) {
  const rows = e.__rows('Rosters');
  const col = rows[0];
  const r = rows.slice(1).find((x) => x[col.indexOf('roster_id')] === 'r3');
  r[col.indexOf('acquired_cost')] = cost;
  e.__dropCache('Rosters');

  const res = applyOut(e, 'u1');
  if (!res.ok) throw new Error(res.error);

  return e.getMyClaims('A', { season_id: 's1' }).data.claims[0];
}

t('補填金が100万円単位になる', () => {
  // 3,300万 × 80% = 2,640万 → 2,600万
  const c = claimFor(env(), 33000000);
  eq(c.base_cost, 33000000, '母数は入力どおり');
  eq(c.refund_amount, 26000000);
});

t('端数が切り上がることもある', () => {
  // 100万 × 80% = 80万 → 100万
  const c = claimFor(env(), 1000000);
  eq(c.refund_amount, 1000000, '補填が母数と同額になる場合もある');
});

t('元から100万単位なら変わらない', () => {
  // 8,000万 × 80% = 6,400万
  const c = claimFor(env(), 80000000);
  eq(c.refund_amount, 64000000);
});

// =============================================================================
// 獲得額の訂正から引き直す
// =============================================================================

t('訂正で引き直した額も100万円単位', () => {
  const e = env();
  claimFor(e, 1000000);

  e.setRosterAcquisition('ORG', {
    season_id: 's1',
    players: [{ name: '浦和1', acquired_cost: 33000000 }],
  });

  const c = e.getMyClaims('A', { season_id: 's1' }).data.claims[0];
  eq(c.base_cost, 33000000);
  eq(c.refund_amount, 26000000);
});

// =============================================================================
// 直接入れた金額は丸めない
// =============================================================================

t('獲得額そのものは丸めない', () => {
  const e = env();
  e.setRosterAcquisition('ORG', {
    season_id: 's1',
    players: [{ name: '浦和1', acquired_cost: 1234567 }],
  });

  const rows = e.__rows('Rosters');
  const col = rows[0];
  const r = rows.slice(1).find((x) => x[col.indexOf('roster_id')] === 'r3');
  eq(Number(r[col.indexOf('acquired_cost')]), 1234567, '入れた数字は変えない');
});

report('money.js');
