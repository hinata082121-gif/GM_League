const { t, eq, ok, report } = require('./harness');
const { env } = require('./pf-fixture');

/**
 * ガンバ（t_a）と柏（t_b）の2チーム。
 * ガンバの現実クラブの選手を6人置き、一部だけエントリーに入れる。
 */
function world(over) {
  const e = env(over);

  e.__addRow('Users', { user_id: 'u_b', email: 'b@example.com', display_name: 'GM次郎', role: 'team', team_id: 't_b' });
  e.__addRow('Teams', { team_id: 't_b', name: '柏レイソル', owner_user_id: 'u_b', kind: '継続', active: true });
  e.__tokens['B'] = 'b@example.com';

  const P = [
    // name,           detail, age, 国籍,        現実クラブ
    ['宇佐美 貴史',    'OMF',  34, '',           'ガンバ大阪'],
    ['半田 陸',        'RSB',  24, '',           'ガンバ大阪'],
    ['フアンぺ',       'CMF',  30, 'スペイン',   'ガンバ大阪'],
    ['一森 純',        'GK',   35, '',           'ガンバ大阪'],
    ['ネタ ラヴィ',    'DMF',  30, 'イスラエル', 'ガンバ大阪'],
    ['山下 諒也',      'RWG',  29, '',           'ガンバ大阪'],
    ['小屋松 知哉',    'LWG',  30, '',           '柏レイソル'],
    ['細谷 真大',      'CF',   24, '',           '柏レイソル'],
  ];

  P.forEach(([name, detail, age, nat, club]) =>
    e.upsertPlayer('ORG', { name, detail_position: detail, age, nationality: nat, real_club: club }));

  return e;
}

const idOf = (e, name) =>
  e.listPlayers('ORG', {}).data.filter((p) => p.name === name)[0].player_id;

/** チームにエントリーを組ませる */
function enter(e, teamId, names) {
  e.importRoster('ORG', {
    season_id: 's2',
    team_id: teamId,
    players: names.map((n) => {
      const p = e.listPlayers('ORG', {}).data.filter((x) => x.name === n)[0];
      return { name: p.name, position: p.detail_position };
    }),
  });
}

// =============================================================================
// エントリーリストとエントリー外
// =============================================================================

t('エントリーとエントリー外が分かれて返る', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史', '半田 陸', '一森 純']);

  const r = e.getTeamRoster('A', { team_id: 't_a', season_id: 's2' });
  eq(r.ok, true);
  eq(r.data.entry.total, 3);
  eq(r.data.outside_total, 3, 'ガンバの残り3人');
  eq(r.data.outside.map((o) => o.name).sort(), ['ネタ ラヴィ', 'フアンぺ', '山下 諒也'].sort());
});

t('他クラブの選手はエントリー外に混ざらない', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);

  const names = e.getTeamRoster('A', { team_id: 't_a', season_id: 's2' }).data.outside.map((o) => o.name);
  ok(names.indexOf('細谷 真大') === -1, '柏の選手が出ていないこと');
});

t('他チームが保有していれば保有チーム名が付く', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);
  enter(e, 't_b', ['フアンぺ']);   // 柏がガンバの選手を保有

  const r = e.getTeamRoster('A', { team_id: 't_a', season_id: 's2' });
  const juanpe = r.data.outside.filter((o) => o.name === 'フアンぺ')[0];

  eq(juanpe.hold_status, '他チーム保有');
  eq(juanpe.held_by_name, '柏レイソル');
});

t('未保有と保有済みの人数を数える', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史', '半田 陸']);
  enter(e, 't_b', ['フアンぺ']);

  const d = e.getTeamRoster('A', { team_id: 't_a', season_id: 's2' }).data;
  eq(d.outside_total, 4);
  eq(d.outside_held, 1);
  eq(d.outside_free, 3);
});

t('エントリー外にも年齢と国籍が乗る', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);

  const juanpe = e.getTeamRoster('A', { team_id: 't_a', season_id: 's2' })
    .data.outside.filter((o) => o.name === 'フアンぺ')[0];

  eq(juanpe.age, 30);
  eq(juanpe.foreign, true);
  eq(juanpe.detail_position, 'CMF');
});

t('エントリー外はポジション順に並ぶ', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);

  const d = e.getTeamRoster('A', { team_id: 't_a', season_id: 's2' }).data.outside;
  eq(d.map((o) => o.detail_position), ['GK', 'RSB', 'DMF', 'CMF', 'RWG']);
});

t('team_id が無ければ拒否する', () => {
  const e = world();
  eq(e.getTeamRoster('A', {}).ok, false);
});

t('シーズンを省くと最新シーズンで見る', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);

  const r = e.getTeamRoster('A', { team_id: 't_a' });
  eq(r.data.season_id, 's2');
  eq(r.data.entry.total, 1);
});

// =============================================================================
// 検索 — 条件ひとつ
// =============================================================================

t('条件なしなら全員返る', () => {
  const e = world();
  const r = e.searchPlayers('A', {});
  eq(r.ok, true);
  eq(r.data.total, 8);
});

t('名前の部分一致で探せる', () => {
  const e = world();
  const r = e.searchPlayers('A', { name: '宇佐美' });
  eq(r.data.total, 1);
  eq(r.data.players[0].name, '宇佐美 貴史');
});

t('名前は空白の有無を問わない', () => {
  const e = world();
  eq(e.searchPlayers('A', { name: '宇佐美貴史' }).data.total, 1);
});

t('名前はヴとブの違いを吸収する', () => {
  const e = world();
  eq(e.searchPlayers('A', { name: 'ラビ' }).data.total, 1);
});

t('大分類のポジションで探せる', () => {
  const e = world();
  const r = e.searchPlayers('A', { position: 'MF' });
  eq(r.data.total, 3, 'OMF/CMF/DMF');
});

t('詳細ポジションで探せる', () => {
  const e = world();
  eq(e.searchPlayers('A', { detail_position: 'CMF' }).data.total, 1);
});

t('年齢の下限だけでも探せる', () => {
  const e = world();
  const r = e.searchPlayers('A', { age_min: 30 });
  eq(r.data.players.map((p) => p.name).sort(),
    ['宇佐美 貴史', 'ネタ ラヴィ', 'フアンぺ', '一森 純', '小屋松 知哉'].sort());
});

t('年齢の上限だけでも探せる', () => {
  const e = world();
  const r = e.searchPlayers('A', { age_max: 24 });
  eq(r.data.players.map((p) => p.name).sort(), ['半田 陸', '細谷 真大'].sort());
});

t('現実クラブで探せる', () => {
  const e = world();
  eq(e.searchPlayers('A', { real_club: '柏レイソル' }).data.total, 2);
});

t('外国籍だけを探せる', () => {
  const e = world();
  const r = e.searchPlayers('A', { foreign: '1' });
  eq(r.data.players.map((p) => p.name).sort(), ['ネタ ラヴィ', 'フアンぺ'].sort());
});

t('日本国籍だけを探せる', () => {
  const e = world();
  eq(e.searchPlayers('A', { foreign: '0' }).data.total, 6);
});

// =============================================================================
// 検索 — 保有状況
// =============================================================================

t('未保有だけを探せる', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史', '半田 陸']);

  const r = e.searchPlayers('A', { hold_status: '未保有' });
  eq(r.data.total, 6);
});

t('自チームだけを探せる', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史', '半田 陸']);

  const r = e.searchPlayers('A', { hold_status: '自チーム' });
  eq(r.data.players.map((p) => p.name).sort(), ['半田 陸', '宇佐美 貴史'].sort());
});

t('他チーム保有だけを探せる', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);
  enter(e, 't_b', ['フアンぺ']);

  const r = e.searchPlayers('A', { hold_status: '他チーム保有' });
  eq(r.data.players.map((p) => p.name), ['フアンぺ']);
  eq(r.data.players[0].held_by_name, '柏レイソル');
});

t('見る人が変われば自チームの中身も変わる', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史']);
  enter(e, 't_b', ['フアンぺ']);

  eq(e.searchPlayers('A', { hold_status: '自チーム' }).data.players.map((p) => p.name), ['宇佐美 貴史']);
  eq(e.searchPlayers('B', { hold_status: '自チーム' }).data.players.map((p) => p.name), ['フアンぺ']);
});

t('主催者は基準チームを指定できる', () => {
  const e = world();
  enter(e, 't_b', ['フアンぺ']);

  eq(e.searchPlayers('ORG', { hold_status: '自チーム' }).data.total, 0, 'チームが無いので0');
  eq(e.searchPlayers('ORG', { team_id: 't_b', hold_status: '自チーム' }).data.players.map((p) => p.name),
    ['フアンぺ']);
});

// =============================================================================
// 検索 — 条件の組み合わせ
// =============================================================================

t('複数の条件は AND でつながる', () => {
  const e = world();
  const r = e.searchPlayers('A', { position: 'MF', age_min: 30, foreign: '1' });
  eq(r.data.players.map((p) => p.name).sort(), ['ネタ ラヴィ', 'フアンぺ'].sort());
});

t('年齢の上下限をまとめて指定できる', () => {
  const e = world();
  const r = e.searchPlayers('A', { age_min: 29, age_max: 30 });
  eq(r.data.players.map((p) => p.name).sort(), ['ネタ ラヴィ', 'フアンぺ', '小屋松 知哉', '山下 諒也'].sort());
});

t('該当が無ければ空で返る', () => {
  const e = world();
  const r = e.searchPlayers('A', { position: 'GK', age_max: 20 });
  eq(r.ok, true);
  eq(r.data.total, 0);
  eq(r.data.players, []);
});

t('クラブと保有状況を重ねられる', () => {
  const e = world();
  enter(e, 't_a', ['宇佐美 貴史', '半田 陸']);

  const r = e.searchPlayers('A', { real_club: 'ガンバ大阪', hold_status: '未保有' });
  eq(r.data.total, 4);
});

// =============================================================================
// 検索 — 年齢未入力の扱い
// =============================================================================

t('年齢が未入力の選手は年齢条件から外れる', () => {
  const e = world();
  e.upsertPlayer('ORG', { name: '年齢不明', detail_position: 'CB', real_club: 'ガンバ大阪' });

  eq(e.searchPlayers('A', {}).data.total, 9, '条件なしなら出る');
  ok(e.searchPlayers('A', { age_min: 0 }).data.players.every((p) => p.name !== '年齢不明'),
    '下限を付けると外れる');
  ok(e.searchPlayers('A', { age_max: 60 }).data.players.every((p) => p.name !== '年齢不明'),
    '上限を付けると外れる');
});

// =============================================================================
// 検索 — 検証
// =============================================================================

t('下限が上限を超えていれば拒否する', () => {
  const e = world();
  const r = e.searchPlayers('A', { age_min: 30, age_max: 20 });
  eq(r.ok, false);
  ok(r.error.indexOf('下限') !== -1, r.error);
});

t('不正なポジションは拒否する', () => {
  const e = world();
  eq(e.searchPlayers('A', { position: 'ZZ' }).ok, false);
  eq(e.searchPlayers('A', { detail_position: 'ZZ' }).ok, false);
});

t('大分類と詳細が食い違えば拒否する', () => {
  const e = world();
  eq(e.searchPlayers('A', { position: 'DF', detail_position: 'CMF' }).ok, false);
});

t('大分類と詳細が揃っていれば通る', () => {
  const e = world();
  eq(e.searchPlayers('A', { position: 'MF', detail_position: 'CMF' }).data.total, 1);
});

t('不正な保有状況は拒否する', () => {
  const e = world();
  eq(e.searchPlayers('A', { hold_status: 'よくわからない' }).ok, false);
});

t('ログインしていなければ使えない', () => {
  const e = world();
  eq(e.searchPlayers('unknown', {}).ok, false);
  eq(e.getTeamRoster('unknown', { team_id: 't_a' }).ok, false);
});

// =============================================================================
// 検索 — 件数の上限
// =============================================================================

t('上限を超えたら切り詰めて知らせる', () => {
  const e = world();
  const r = e.searchPlayers('A', { limit: 3 });

  eq(r.data.total, 8, '総数は絞る前の数');
  eq(r.data.shown, 3);
  eq(r.data.truncated, true);
});

t('上限に収まっていれば切り詰めない', () => {
  const e = world();
  const r = e.searchPlayers('A', {});
  eq(r.data.truncated, false);
  eq(r.data.shown, r.data.total);
});

report('search.js');
