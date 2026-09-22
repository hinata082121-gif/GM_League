const { t, eq, ok, report } = require('./harness');
const { env } = require('./cl-fixture');

// 在籍している選手の獲得額だけを直す。
//
// importRoster の上書きは在籍行をまるごと作り直すので、1人の金額を直すために
// スカッド全員を渡し直すことになり、渡し漏れれば他の選手が消える。
// 金額の訂正は頻度が低いわりに影響が大きいので、専用の入口に分けてある。
//
// 補填請求の base_cost は請求を立てた時点で固定されるため、
// 在籍の金額だけ直しても既存の請求は動かない。ここで一緒に引き直す。

const call = (e, players, who) =>
  e.setRosterAcquisition(who || 'ORG', { season_id: 's1', players });

/** 在籍行を読む */
const rosterOf = (e, pid) => {
  const rows = e.__rows('Rosters');
  const col = rows[0];
  const r = rows.slice(1).find((x) => x[col.indexOf('player_id')] === pid
    && x[col.indexOf('season_id')] === 's1'
    && x[col.indexOf('status')] === '在籍');
  return r && {
    type: r[col.indexOf('acquisition_type')],
    cost: Number(r[col.indexOf('acquired_cost')]),
  };
};

/** 請求を読む */
const claimOf = (e, pid) => {
  const rows = e.__rows('Claims');
  const col = rows[0];
  const r = rows.slice(1).find((x) => x[col.indexOf('player_id')] === pid);
  return r && {
    base: Number(r[col.indexOf('base_cost')]),
    refund: Number(r[col.indexOf('refund_amount')]),
    status: r[col.indexOf('status')],
  };
};

/** 請求を1件立てる */
function addClaim(e, pid, status, base) {
  e.__addRow('Claims', {
    claim_id: 'cl_' + pid, season_id: 's1', team_id: 't_a', player_id: pid,
    reason: '大会外移籍', base_cost: base === undefined ? 0 : base, rate: 0.8,
    refund_amount: base === undefined ? 0 : Math.round(base * 0.8),
    choice: '未選択', replacement_id: '', status: status || '選択待ち',
    created_at: new Date(), chosen_at: '', chosen_by: '', settled_at: '',
  });
  e.__dropCache('Claims');
  return e;
}

// =============================================================================
// 在籍の訂正
// =============================================================================

t('獲得額を直せる', () => {
  const e = env();
  const r = call(e, [{ name: '浦和1', acquisition_type: '完全移籍', acquired_cost: 80000000 }]);

  eq(r.ok, true, r.error);
  eq(r.data.updated.length, 1);
  eq(r.data.updated[0].before, 100000000, '元の額も返す');
  eq(r.data.updated[0].after, 80000000);

  const rs = rosterOf(e, 'u1');
  eq(rs.type, '完全移籍');
  eq(rs.cost, 80000000);
});

t('種別を省くと今の種別のまま', () => {
  const e = env();
  call(e, [{ name: '浦和1', acquired_cost: 1000000 }]);

  const rs = rosterOf(e, 'u1');
  eq(rs.cost, 1000000);
  eq(rs.type, '完全移籍', '元の種別を保つ');
});

t('player_id でも指定できる', () => {
  const e = env();
  const r = call(e, [{ player_id: 'u1', acquired_cost: 500 }]);
  eq(r.ok, true, r.error);
  eq(rosterOf(e, 'u1').cost, 500);
});

t('まとめて直せる', () => {
  const e = env();
  const r = call(e, [
    { name: '浦和1', acquired_cost: 100 },
    { name: '鹿島1', acquired_cost: 200 },
  ]);
  eq(r.ok, true, r.error);
  eq(r.data.updated.length, 2);
});

t('他の選手の在籍は動かさない', () => {
  const e = env();
  const before = e.__rows('Rosters').length;
  call(e, [{ name: '浦和1', acquired_cost: 1 }]);
  eq(e.__rows('Rosters').length, before, '行を作り直さない');
});

// =============================================================================
// 請求の引き直し
// =============================================================================

t('選択待ちの請求の母数を直す', () => {
  const e = addClaim(env(), 'u1', '選択待ち');
  const r = call(e, [{ name: '浦和1', acquired_cost: 80000000 }]);

  eq(r.data.claims.length, 1);
  eq(r.data.claims[0].after, 64000000, '8000万の80%');

  const c = claimOf(e, 'u1');
  eq(c.base, 80000000);
  eq(c.refund, 64000000);
});

t('確定済みの請求も直す', () => {
  const e = addClaim(env(), 'u1', '確定');
  call(e, [{ name: '浦和1', acquired_cost: 33000000 }]);

  const c = claimOf(e, 'u1');
  eq(c.base, 33000000);
  eq(c.refund, 26000000, '3,300万×80%=2,640万 → 2,600万');
});

t('精算済みの請求は触らない', () => {
  const e = addClaim(env(), 'u1', '精算済', 5000000);
  const r = call(e, [{ name: '浦和1', acquired_cost: 80000000 }]);

  eq(r.data.claims.length, 0);
  const c = claimOf(e, 'u1');
  eq(c.base, 5000000, '予算に反映済みなので動かしてはいけない');
  eq(c.refund, 4000000);
});

t('無効の請求は触らない', () => {
  const e = addClaim(env(), 'u1', '無効', 5000000);
  call(e, [{ name: '浦和1', acquired_cost: 80000000 }]);
  eq(claimOf(e, 'u1').base, 5000000);
});

t('請求が無くても在籍は直る', () => {
  const e = env();
  const r = call(e, [{ name: '浦和1', acquired_cost: 300 }]);
  eq(r.ok, true, r.error);
  eq(r.data.claims.length, 0);
  eq(rosterOf(e, 'u1').cost, 300);
});

// =============================================================================
// 弾く
// =============================================================================

t('在籍していない選手は拒否する', () => {
  const e = env();
  const r = call(e, [{ name: 'いない人', acquired_cost: 100 }]);
  eq(r.ok, false);
  ok(r.error.indexOf('選手が見つかりません') !== -1, r.error);
});

t('チーム違いは拒否する', () => {
  const e = env();
  const r = call(e, [{ name: '浦和1', team_id: 't_b', acquired_cost: 100 }]);
  eq(r.ok, false);
  ok(r.error.indexOf('在籍していません') !== -1, r.error);
});

t('負の額は拒否する', () => {
  const e = env();
  eq(call(e, [{ name: '浦和1', acquired_cost: -1 }]).ok, false);
});

t('知らない種別は拒否する', () => {
  const e = env();
  eq(call(e, [{ name: '浦和1', acquisition_type: 'タダ', acquired_cost: 1 }]).ok, false);
});

t('1件でも駄目なら何も書かない', () => {
  const e = env();
  const r = call(e, [
    { name: '浦和1', acquired_cost: 999 },
    { name: 'いない人', acquired_cost: 100 },
  ]);

  eq(r.ok, false);
  eq(rosterOf(e, 'u1').cost, 100000000, '先頭も変えてはいけない');
});

t('選手が空なら拒否する', () => {
  const e = env();
  eq(call(e, []).ok, false);
});

t('参加者は実行できない', () => {
  const e = env();
  eq(call(e, [{ name: '浦和1', acquired_cost: 1 }], 'A').ok, false);
});

report('setcost.js');
