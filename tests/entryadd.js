const vm = require('vm');
const { createEnv, t, eq, ok, report } = require('./harness');

// エントリー追加: 第一次移籍期間の初日だけ、自クラブのエントリー外の選手を有償で足す。
//   19歳以上 5,000万 / 18歳以下 2,500万。追加したシーズンの間は他クラブへ移籍できない。
//
// A=鹿島 在籍 k1。エントリー外: k3（25歳） y1（18歳） y2（19歳） n1（年齢なし） k7（補填で予約済み）
// B=浦和 在籍 u1
// 第一次移籍期間の開幕は 10/1 20:00（初日は 10/1 いっぱい）

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','window1_open_at','window2_open_at','claim_deadline_at'],
  Players: ['player_id','name','position','detail_position','age','nationality','real_club','eligible'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  Protections: ['protection_id','season_id','window','team_id','player_id','tier','fee','set_at'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  EntryAdds: ['add_id','season_id','team_id','player_id','age','cost','added_at','added_by'],
  Config: ['key','value','note'],
};

function env(o) {
  const opt = Object.assign({ status: '移籍市場1', now: new Date(2026, 9, 1, 21, 0, 0), budget: 100000000, squad: 1 }, o || {});
  const e = createEnv(SHEETS, { squad_min: 1, squad_max: 35, market_days: 3 });
  e.__tokens.ORG = 'org@example.com';
  e.__tokens.A = 'a@example.com';
  e.__tokens.B = 'b@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', role: 'organizer' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', role: 'team', team_id: 't_a' });
  e.__addRow('Users', { user_id: 'u_b', email: 'b@example.com', role: 'team', team_id: 't_b' });
  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', kind: '継続', active: true });
  e.__addRow('Teams', { team_id: 't_b', name: '浦和レッズ', kind: '新規', active: true });
  e.__addRow('Seasons', { season_id: 's1', name: 'S15', status: opt.status, window1_open_at: new Date(2026, 9, 1, 20, 0, 0) });

  const P = (id, age, club) => e.__addRow('Players', {
    player_id: id, name: '選手' + id, position: 'MF', detail_position: 'CMF', age, nationality: '日本',
    real_club: club || '鹿島アントラーズ', eligible: true,
  });
  P('k1', 25); P('k3', 25); P('y1', 18); P('y2', 19); P('n1', ''); P('k7', 22);
  P('u1', 24, '浦和レッズ'); P('u2', 17, '浦和レッズ');

  for (let i = 0; i < opt.squad; i++) {
    const id = i === 0 ? 'k1' : 'f' + i;
    if (i > 0) P(id, 30, 'どこか');
    e.__addRow('Rosters', { roster_id: 'r' + i, season_id: 's1', team_id: 't_a', player_id: id, status: '在籍', acquisition_type: '初期', acquired_cost: 0 });
  }
  e.__addRow('Rosters', { roster_id: 'rb', season_id: 's1', team_id: 't_b', player_id: 'u1', status: '在籍', acquisition_type: '初期', acquired_cost: 0 });
  e.__addRow('Claims', { claim_id: 'c1', season_id: 's1', team_id: 't_a', player_id: 'kx', status: '確定', choice: '入れ替え', replacement_id: 'k7' });
  e.__addRow('BudgetTx', { tx_id: 'b1', season_id: 's1', team_id: 't_a', amount: opt.budget, reason: '前シーズンからの繰越' });
  e.__addRow('BudgetTx', { tx_id: 'b2', season_id: 's1', team_id: 't_b', amount: 100000000, reason: '新規参加の初期予算' });

  vm.runInContext('now = function () { return new Date(' + opt.now.getTime() + '); };', e);
  return e;
}

const status = (e, who, team) => e.getEntryAddStatus(who || 'A', { season_id: 's1', team_id: team || 't_a' });
const add = (e, ids, who, team) => e.addEntryPlayers(who || 'A', { season_id: 's1', team_id: team || 't_a', player_ids: ids });
const balance = (e, team) => {
  const rows = e.__rows('BudgetTx'); const c = rows[0];
  return rows.slice(1).filter((r) => r[c.indexOf('team_id')] === team).reduce((s, r) => s + Number(r[c.indexOf('amount')]), 0);
};
const activeOf = (e, team) => {
  const rows = e.__rows('Rosters'); const c = rows[0];
  return rows.slice(1).filter((r) => r[c.indexOf('team_id')] === team && r[c.indexOf('status')] === '在籍')
    .map((r) => r[c.indexOf('player_id')]).sort();
};

t('候補は自クラブのエントリー外で、年齢で費用が決まる（18歳以下2,500万・19歳以上5,000万）', () => {
  const d = status(env()).data;
  const by = {};
  d.candidates.forEach((c) => { by[c.player_id] = c; });
  eq(Object.keys(by).sort(), ['k3', 'n1', 'y1', 'y2']);
  eq([by.y1.cost, by.y2.cost, by.k3.cost], [25000000, 50000000, 50000000]);
  eq(by.n1.cost, null);
  eq(d.window.open, true);
});

t('追加するとスカッドに入り、予算から費用が引かれ、獲得額として残る', () => {
  const e = env();
  const r = add(e, ['y1', 'k3']);
  eq(r.ok, true, r.error);
  eq(r.data.total, 75000000);
  eq(activeOf(e, 't_a'), ['k1', 'k3', 'y1']);
  eq(balance(e, 't_a'), 25000000);
  const rows = e.__rows('Rosters'); const c = rows[0];
  const y1 = rows.find((x) => x[c.indexOf('player_id')] === 'y1');
  eq([y1[c.indexOf('acquisition_type')], y1[c.indexOf('acquired_cost')]], ['エントリー追加', 25000000]);
});

t('新規参加のチームも使える', () => {
  const e = env();
  const r = add(e, ['u2'], 'B', 't_b');
  eq(r.ok, true, r.error);
  eq(balance(e, 't_b'), 75000000);
});

t('初日の前・2日目以降は追加できない', () => {
  [new Date(2026, 8, 30, 23, 0, 0), new Date(2026, 9, 2, 0, 0, 1)].forEach((at) => {
    const e = env({ now: at });
    eq(status(e).data.window.open, false);
    const r = add(e, ['k3']);
    eq(r.ok, false);
    ok(/初日/.test(r.error), r.error);
  });
});

t('初日は 23:59:59 まで追加できる', () => {
  const e = env({ now: new Date(2026, 9, 1, 23, 59, 59) });
  eq(add(e, ['k3']).ok, true);
});

t('第二次移籍期間・期間外は追加できない', () => {
  ['移籍市場2', 'シーズン1'].forEach((st) => {
    const e = env({ status: st });
    const r = add(e, ['k3']);
    eq(r.ok, false);
    ok(/第一次移籍期間の初日/.test(r.error), r.error);
  });
});

t('主催者は日付に関係なく代行できる', () => {
  const e = env({ now: new Date(2026, 9, 3, 12, 0, 0) });
  const r = add(e, ['k3'], 'ORG');
  eq(r.ok, true, r.error);
});

t('予算が足りなければ何も書かない', () => {
  const e = env({ budget: 60000000 });
  const r = add(e, ['k3', 'y1']);
  eq(r.ok, false);
  ok(/予算/.test(r.error), r.error);
  eq(activeOf(e, 't_a'), ['k1']);
  eq(balance(e, 't_a'), 60000000);
});

t('スカッドの上限を超えるなら断る', () => {
  const e = env({ squad: 34 });
  const r = add(e, ['k3', 'y1']);
  eq(r.ok, false);
  ok(/上限/.test(r.error), r.error);
});

t('年齢が名簿に無い選手・他クラブの選手・予約済みの選手は追加できない', () => {
  const e = env();
  ok(/年齢/.test(add(e, ['n1']).error));
  eq(add(e, ['u2']).ok, false);
  eq(add(e, ['k7']).ok, false);
});

t('追加した選手は、そのシーズンの間は他クラブへ移籍できず、獲得候補にも出ない', () => {
  const e = env();
  eq(add(e, ['k3']).ok, true);
  const r = e.requestTransfer('B', { season_id: 's1', to_team: 't_b', player_id: 'k3', method: '完全移籍', gross_fee: 10000000 });
  eq(r.ok, false);
  ok(/エントリー追加/.test(r.error), r.error);
  const targets = e._collectTransferTargets('s1', 't_b', 1, []).targets.map((x) => x.player_id);
  ok(targets.indexOf('k3') === -1, targets.join(','));
  ok(targets.indexOf('k1') !== -1, '通常の選手は候補に出る');
});

t('翌シーズンは移籍の制限が残らない', () => {
  const e = env();
  eq(add(e, ['k3']).ok, true);
  eq(e._entryAddTransferBlock('s2', 'k3'), '');
  ok(e._entryAddTransferBlock('s1', 'k3') !== '');
});

report('entryadd.js');
