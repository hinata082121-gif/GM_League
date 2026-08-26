const { t, eq, ok, report } = require('./harness');
const { env, squad, rosters, players } = require('./im-fixture');

// ---- 取り込み --------------------------------------------------------------

t('名簿から在籍を作れる', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(24) });

  eq(r.ok, true);
  eq(r.data.added, 24);
  eq(r.data.warnings, []);
  eq(rosters(e).length, 24);
  eq(rosters(e)[0][4], '在籍');
});

t('選手マスタに無ければ作る', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(3) });

  eq(players(e).length, 3);
  eq(players(e)[0][1], '選手1');
  eq(players(e)[0][2], 'MF');
  eq(players(e)[0][3], '');      // 詳細ポジションは未指定
  eq(players(e)[0][4], 'ガンバ大阪');
  eq(players(e)[0][5], true);    // eligible
});

t('既にいる選手は作り直さない', () => {
  const e = env();
  e.__addRow('Players', { player_id: 'p_1', name: '選手1', position: 'MF', real_club: 'ガンバ大阪', eligible: true });

  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(3) });
  eq(r.data.created_players, ['選手2', '選手3']);
  eq(players(e).length, 3);
  eq(rosters(e).find((x) => x[3] === 'p_1') !== undefined, true);
});

t('名前が同じでもポジションが違えば別人', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '田中', position: 'GK' },
    { name: '田中', position: 'FW' },
  ]});
  eq(r.ok, true);
  eq(players(e).length, 2);
});

t('獲得種別と金額を記録できる', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '尾谷', position: 'FW', real_club: 'FC東京', acquisition_type: '完全移籍', acquired_cost: 18000000 },
    { name: '蓮川', position: 'DF', real_club: '清水エスパルス', acquisition_type: '半期期限付き', acquired_cost: 17000000, expires_season: 's1' },
  ]});

  const rs = rosters(e);
  eq(rs[0][5], '完全移籍');
  eq(Number(rs[0][6]), 18000000);
  eq(rs[1][5], '半期期限付き');
  eq(rs[1][8], 's1');
});

t('種別を省くと初期になる', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(1) });
  eq(rosters(e)[0][5], '初期');
});

// ---- 検証 ------------------------------------------------------------------

t('主催者以外は取り込めない', () => {
  const e = env();
  eq(e.importRoster('A', { season_id: 's1', team_id: 't_A', players: squad(3) }).ok, false);
});

t('空の名簿は拒否する', () => {
  const e = env();
  eq(e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [] }).ok, false);
});

t('存在しないシーズンとチームは拒否する', () => {
  const e = env();
  eq(e.importRoster('ORG', { season_id: 'x', team_id: 't_A', players: squad(1) }).ok, false);
  eq(e.importRoster('ORG', { season_id: 's1', team_id: 'x', players: squad(1) }).ok, false);
});

t('ポジションが不正なら何行目か分かる', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'GK' },
    { name: 'B', position: 'SS' },
  ]});
  eq(r.ok, false);
  ok(r.error.indexOf('2人目') === 0, r.error);
  ok(r.error.indexOf('B') !== -1, r.error);
});

// ---- 詳細ポジション --------------------------------------------------------

t('詳細ポジションで指定できる', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '長友', position: 'LSB' },
    { name: '昌子', position: 'CB' },
    { name: '小泉', position: 'OMF' },
    { name: '細谷', position: 'CF' },
  ]});
  eq(r.ok, true);

  const p = players(e);
  eq(p.map((x) => x[2]), ['DF', 'DF', 'MF', 'FW']);
  eq(p.map((x) => x[3]), ['LSB', 'CB', 'OMF', 'CF']);
});

t('大分類と詳細の両方を渡せる', () => {
  const e = env();
  eq(e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'DF', detail_position: 'RSB' },
  ]}).ok, true);
  eq(players(e)[0][2], 'DF');
  eq(players(e)[0][3], 'RSB');
});

t('大分類と詳細が食い違えば拒否する', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'MF', detail_position: 'CB' },
  ]});
  eq(r.ok, false);
  ok(r.error.indexOf('CB') !== -1, r.error);
});

t('GKは詳細も自動で埋まる', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '守田', position: 'GK' },
  ]});
  eq(players(e)[0][3], 'GK');
});

t('小文字でも通る', () => {
  const e = env();
  eq(e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'lwg' },
  ]}).ok, true);
  eq(players(e)[0][2], 'FW');
  eq(players(e)[0][3], 'LWG');
});

t('既にいる選手の詳細が空なら埋める', () => {
  const e = env();
  e.__addRow('Players', {
    player_id: 'p_1', name: '田中', position: 'MF',
    detail_position: '', real_club: '', eligible: true,
  });

  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '田中', position: 'CMF' },
  ]});
  eq(players(e).length, 1);
  eq(players(e)[0][3], 'CMF');
});

t('小文字のポジションでも通る', () => {
  const e = env();
  eq(e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'gk' },
  ]}).ok, true);
  eq(players(e)[0][2], 'GK');
});

t('名簿の中で重複していたら拒否する', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '田中', position: 'MF' },
    { name: '田中', position: 'MF' },
  ]});
  eq(r.ok, false);
  ok(r.error.indexOf('重複') !== -1, r.error);
});

t('検証で落ちたら1行も書かない', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'GK' },
    { name: 'B', position: 'XX' },
  ]});
  eq(players(e).length, 0);
  eq(rosters(e).length, 0);
});

t('獲得種別が不正なら拒否する', () => {
  const e = env();
  eq(e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: 'A', position: 'GK', acquisition_type: 'レンタル' },
  ]}).ok, false);
});

// ---- 重複所有 --------------------------------------------------------------

t('他チームが持っている選手は取り込めない', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [{ name: '田中', position: 'MF' }] });

  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_B', players: [{ name: '田中', position: 'MF' }] });
  eq(r.ok, false);
  ok(r.error.indexOf('田中') !== -1, r.error);
  ok(r.error.indexOf('チームA') !== -1, r.error);
});

t('別のシーズンなら同じ選手を取り込める', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [{ name: '田中', position: 'MF' }] });
  eq(e.importRoster('ORG', { season_id: 's2', team_id: 't_B', players: [{ name: '田中', position: 'MF' }] }).ok, true);
});

t('自分が既に持っている選手は飛ばす', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [{ name: '田中', position: 'MF' }] });

  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: [
    { name: '田中', position: 'MF' },
    { name: '佐藤', position: 'FW' },
  ]});
  eq(r.ok, true);
  eq(r.data.added, 1);
  eq(r.data.skipped, ['田中']);
  eq(rosters(e).length, 2);
});

t('入れ替えなら既存を消してから入れる', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(5) });

  const r = e.importRoster('ORG', {
    season_id: 's1', team_id: 't_A', replace: true, players: squad(3),
  });
  eq(r.data.removed, 5);
  eq(r.data.added, 3);
  eq(rosters(e).length, 3);
});

t('入れ替えても他シーズンは残る', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(3) });
  e.importRoster('ORG', { season_id: 's2', team_id: 't_A', players: squad(3) });

  e.importRoster('ORG', { season_id: 's2', team_id: 't_A', replace: true, players: squad(2) });
  eq(rosters(e).filter((r) => r[1] === 's1').length, 3);
  eq(rosters(e).filter((r) => r[1] === 's2').length, 2);
});

// ---- 人数の警告 ------------------------------------------------------------

t('人数が少なければ警告する（エラーにはしない）', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(10) });
  eq(r.ok, true);
  eq(r.data.warnings.length, 1);
  ok(r.data.warnings[0].indexOf('下回') !== -1, r.data.warnings[0]);
});

t('人数が多すぎても警告だけ', () => {
  const e = env();
  const r = e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(40) });
  eq(r.ok, true);
  eq(r.data.added, 40);
  ok(r.data.warnings[0].indexOf('超え') !== -1, r.data.warnings[0]);
});

// ---- 予算の調整 ------------------------------------------------------------

t('予算を足せる', () => {
  const e = env();
  const r = e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 26100000 });
  eq(r.ok, true);
  eq(r.data.balance, 26100000);
  eq(e.__rows('BudgetTx')[1][4], '予算調整');
});

t('理由を付けられる', () => {
  const e = env();
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 100, reason: '前季からの繰越' });
  eq(e.__rows('BudgetTx')[1][4], '前季からの繰越');
});

t('マイナスも入れられる', () => {
  const e = env();
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 1000 });
  const r = e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: -300 });
  eq(r.data.balance, 700);
  eq(e.__rows('BudgetTx').length - 1, 2);   // 行は消さずに足す
});

t('0円は拒否する', () => {
  const e = env();
  eq(e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 0 }).ok, false);
});

t('予算の調整は主催者のみ', () => {
  const e = env();
  eq(e.adjustBudget('A', { season_id: 's2', team_id: 't_A', amount: 100 }).ok, false);
});

t('残高はシーズンごとに分かれる', () => {
  const e = env();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 5000 });
  const r = e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 100 });
  eq(r.data.balance, 100);
});

report('import.js');
