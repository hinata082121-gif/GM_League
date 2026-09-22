const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 対戦表。試合結果の報告画面で「節を選んだら相手が入る」ための下敷き。
//
// Matches（実際に行われた試合）とは別の表にしている。
// 1つにまとめて status で分けると、未実施の行が順位表に混ざる。

const base = (over) => env(over);

/** シーズン名簿に登録する。ここが参加チームの正 */
function roster(e, assignments) {
  Object.keys(assignments).forEach((tid) => {
    e.__addRow('SeasonTeams', { season_id: 's1', team_id: tid, division: assignments[tid], owner_memo: '' });
  });
  e.__dropCache('SeasonTeams');
  return e;
}

/** 追加のチームを足す（A〜D は fixture 側で作られている） */
function addTeams(e, keys) {
  keys.forEach((k) => {
    e.__addRow('Teams', { team_id: 't_' + k, name: 'チーム' + k, owner_user_id: '', kind: '継続', active: true });
  });
  e.__dropCache('Teams');
  return e;
}

const gen = (e, payload) =>
  e.generateFixtures('ORG', Object.assign({ season_id: 's1' }, payload || {}));

const list = (e, who, payload) =>
  e.getFixtures(who || 'A', Object.assign({ season_id: 's1' }, payload || {}));

/** 節ごとの対戦数を数える */
function byRound(rows) {
  const m = {};
  rows.forEach((r) => { m[r.round] = (m[r.round] || 0) + 1; });
  return m;
}

// =============================================================================
// 生成
// =============================================================================

t('4チームなら1巡3節・各節2試合', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  const r = gen(e, { legs: 1 });

  eq(r.ok, true, r.error);
  eq(r.data.rounds, 3);
  eq(r.data.added, 6, '4チームの総当たりは6試合');

  const counts = byRound(list(e).data.fixtures);
  eq(Object.keys(counts).length, 3);
  eq(counts['第1節'], 2);
});

t('全チームが総当たりで1回ずつ当たる', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  gen(e, { legs: 1 });

  const seen = {};
  list(e).data.fixtures.forEach((f) => {
    const key = [f.home_team, f.away_team].sort().join('|');
    seen[key] = (seen[key] || 0) + 1;
  });

  eq(Object.keys(seen).length, 6);
  ok(Object.keys(seen).every((k) => seen[k] === 1), '同じ組み合わせが2回出ている');
});

t('2巡ならホームとアウェイが入れ替わる', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  const r = gen(e, { legs: 2 });

  eq(r.data.rounds, 6);
  eq(r.data.added, 12);

  const rows = list(e).data.fixtures;
  const home = rows.filter((f) => f.home_team === 't_A').length;
  const away = rows.filter((f) => f.away_team === 't_A').length;
  eq(home, away, 'ホームとアウェイが同数にならない');
});

t('奇数チームは毎節1つ休みが出る', () => {
  const e = roster(addTeams(base(), ['E']),
    { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1', t_E: 'GM1' });
  const r = gen(e, { legs: 1 });

  eq(r.data.rounds, 5, '5チームは1巡5節');
  eq(r.data.added, 10, '5チームの総当たりは10試合');

  const counts = byRound(list(e).data.fixtures);
  Object.keys(counts).forEach((k) => eq(counts[k], 2, k + ' が2試合でない'));
});

t('ディビジョンをまたぐ対戦は作らない', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM2', t_D: 'GM2' });
  const r = gen(e, { legs: 1 });

  eq(r.data.divisions, 2);

  const rows = list(e).data.fixtures;
  const div = { t_A: 'GM1', t_B: 'GM1', t_C: 'GM2', t_D: 'GM2' };
  ok(rows.every((f) => div[f.home_team] === div[f.away_team]), 'またいだ対戦がある');
  ok(rows.every((f) => f.division === div[f.home_team]), 'division が入っていない');
});

t('一部制ならディビジョンは空で入る', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  gen(e, { legs: 1 });
  ok(list(e).data.fixtures.every((f) => f.division === ''), 'GM2 がいないなら区別は要らない');
});

t('leg_enabled から巡回数を決める', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  const rows = e.__rows('Seasons');
  const col = rows[0];
  rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's1')[col.indexOf('leg_enabled')] = true;
  e.__dropCache('Seasons');

  eq(gen(e).data.legs, 2);
});

t('名簿が無ければ active なチームで組む', () => {
  const e = base();
  const r = gen(e, { legs: 1 });
  eq(r.ok, true, r.error);
  eq(r.data.added, 6, 'A〜D の4チーム');
});

t('節は数字で並ぶ', () => {
  // "第10節" を文字列で並べると "第2節" の前に来る
  const e = roster(addTeams(base(), ['E','F','G','H','I','J']),
    { t_A:'GM1',t_B:'GM1',t_C:'GM1',t_D:'GM1',t_E:'GM1',t_F:'GM1',t_G:'GM1',t_H:'GM1',t_I:'GM1',t_J:'GM1' });
  gen(e, { legs: 2 });

  const rounds = list(e).data.rounds.map((r) => r.round);
  eq(rounds[1], '第2節');
  eq(rounds[9], '第10節');
});

// =============================================================================
// 上書き
// =============================================================================

t('既にあるなら上書きを求める', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  gen(e, { legs: 1 });

  const r = gen(e, { legs: 1 });
  eq(r.ok, false);
  ok(r.error.indexOf('上書き') !== -1, r.error);
});

t('上書きを指定すれば作り直す', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  gen(e, { legs: 1 });

  const r = gen(e, { legs: 1, replace: true });
  eq(r.ok, true, r.error);
  eq(r.data.removed, 6);
  eq(list(e).data.fixtures.length, 6, '古い行が残っている');
});

t('別の大会は消さない', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  gen(e, { legs: 1 });
  gen(e, { legs: 1, stage: 'tournament' });

  gen(e, { legs: 1, replace: true });
  eq(list(e, 'A', { stage: 'tournament' }).data.fixtures.length, 6);
});

// =============================================================================
// 編集
// =============================================================================

t('1件足せる', () => {
  const e = base();
  const r = e.upsertFixture('ORG', {
    season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B',
  });

  eq(r.ok, true, r.error);
  eq(list(e).data.fixtures.length, 1);
  eq(list(e).data.fixtures[0].home_team_name, 'チームA');
});

t('節から数字を取って並び順にする', () => {
  const e = base();
  e.upsertFixture('ORG', { season_id: 's1', round: '第12節', home_team: 't_A', away_team: 't_B' });
  eq(list(e).data.fixtures[0].sort_order, 12);
});

t('同じ節に同じチームは2回置けない', () => {
  const e = base();
  e.upsertFixture('ORG', { season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B' });

  const r = e.upsertFixture('ORG', { season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_C' });
  eq(r.ok, false);
  ok(r.error.indexOf('1節に1試合') !== -1, r.error);
});

t('節が違えば同じチームを置ける', () => {
  const e = base();
  e.upsertFixture('ORG', { season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B' });
  const r = e.upsertFixture('ORG', { season_id: 's1', round: '第2節', home_team: 't_A', away_team: 't_C' });
  eq(r.ok, true, r.error);
});

t('ホームとアウェイを入れ替えられる', () => {
  const e = base();
  const id = e.upsertFixture('ORG', {
    season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B',
  }).data.fixture_id;

  const r = e.swapFixtureSides('ORG', { fixture_id: id });
  eq(r.ok, true, r.error);

  const f = list(e).data.fixtures[0];
  eq(f.home_team, 't_B');
  eq(f.away_team, 't_A');
});

t('削除できる', () => {
  const e = base();
  const id = e.upsertFixture('ORG', {
    season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B',
  }).data.fixture_id;

  eq(e.deleteFixture('ORG', { fixture_id: id }).ok, true);
  eq(list(e).data.fixtures.length, 0);
});

t('同じチーム同士は組めない', () => {
  const e = base();
  const r = e.upsertFixture('ORG', {
    season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_A',
  });
  eq(r.ok, false);
});

// =============================================================================
// 権限
// =============================================================================

t('参加者は生成できない', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  eq(e.generateFixtures('A', { season_id: 's1' }).ok, false);
});

t('参加者は編集できない', () => {
  const e = base();
  eq(e.upsertFixture('A', { season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B' }).ok, false);
});

t('参加者も閲覧はできる', () => {
  const e = roster(base(), { t_A: 'GM1', t_B: 'GM1', t_C: 'GM1', t_D: 'GM1' });
  gen(e, { legs: 1 });

  const r = list(e, 'B');
  eq(r.ok, true, r.error);
  eq(r.data.my_team, 't_B', '自チームを返して画面が自動入力に使う');
});

t('ログインしていなければ見られない', () => {
  const e = base();
  eq(e.getFixtures('', { season_id: 's1' }).ok, false);
});

// =============================================================================
// 報告済みの印
// =============================================================================

/** 試合を1件登録する */
function addMatch(e, over) {
  e.__addRow('Matches', Object.assign({
    match_id: 'm_' + Math.random().toString(36).slice(2, 8),
    season_id: 's1', stage: 'league', round: '第1節', tie_id: '', leg: '',
    home_team: 't_A', away_team: 't_B', home_score: 2, away_score: 1,
    home_pk: '', away_pk: '', status: '承認', reported_by: 'u_org',
  }, over || {}));
  e.__dropCache('Matches');
  return e;
}

const one = (e) => {
  e.upsertFixture('ORG', { season_id: 's1', round: '第1節', home_team: 't_A', away_team: 't_B' });
  return e;
};

t('報告済みなら印が付く', () => {
  const e = addMatch(one(base()));
  const f = list(e).data.fixtures[0];

  eq(f.reported, true);
  eq(f.match_status, '承認');
  eq(f.score, '2 - 1');
});

t('報告がなければ印は付かない', () => {
  const f = list(one(base())).data.fixtures[0];
  eq(f.reported, false);
  eq(f.score, '');
});

t('ホームとアウェイが逆でも報告済みとみなす', () => {
  // 対戦表と逆の向きで報告されることがある
  const e = addMatch(one(base()), { home_team: 't_B', away_team: 't_A' });
  eq(list(e).data.fixtures[0].reported, true);
});

t('申請中でも報告済みとみなす', () => {
  const e = addMatch(one(base()), { status: '申請中' });
  const f = list(e).data.fixtures[0];
  eq(f.reported, true, '二重申請を防ぐため承認前でも埋まっている扱いにする');
  eq(f.match_status, '申請中');
});

t('差戻は報告済みにしない', () => {
  const e = addMatch(one(base()), { status: '差戻' });
  eq(list(e).data.fixtures[0].reported, false, '出し直せなくなる');
});

t('別の節の試合は結び付けない', () => {
  const e = addMatch(one(base()), { round: '第2節' });
  eq(list(e).data.fixtures[0].reported, false);
});

report('fixture.js');
