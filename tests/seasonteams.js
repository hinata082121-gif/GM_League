const { t, eq, ok, report } = require('./harness');
const { env, match } = require('./st-fixture');

// 過去シーズンの参加チーム名簿。
// 順位表は「今 active なチーム」を0試合でも並べるが、過去シーズンでは
// 出ていないチームが混ざる。SeasonTeams に名簿があればそれで組む。

/** 今はいない C チーム（当時だけ参加）を足す */
function withOldTeam(e) {
  e.__addRow('Teams', { team_id: 't_C', name: '栃木シティ', owner_user_id: '', kind: '新規', active: false });
  return e;
}

const table = (e, season) =>
  e.getStandings('ORG', { season_id: season || 's1' }).data.table;

const names = (e, season) => table(e, season).map((r) => r.team_name).sort();

const roster = (e, season, list) =>
  e.importSeasonTeams('ORG', { season_id: season, teams: list });

// =============================================================================
// 名簿で順位表を組む
// =============================================================================

t('名簿が無ければ active なチームを並べる', () => {
  const e = withOldTeam(env());
  eq(names(e), ['ガンバ大阪', '柏レイソル'], '停止中の栃木は出ない');
});

t('名簿があればそのチームだけ並べる', () => {
  const e = withOldTeam(env());
  roster(e, 's1', [{ name: 'ガンバ大阪' }, { name: '栃木シティ' }]);

  eq(names(e), ['ガンバ大阪', '栃木シティ'], '名簿どおり。柏は出ない');
});

t('停止中のチームも名簿にあれば並ぶ', () => {
  const e = withOldTeam(env());
  roster(e, 's1', [{ name: '栃木シティ' }]);

  eq(names(e), ['栃木シティ']);
});

t('名簿は指定したシーズンにしか効かない', () => {
  const e = withOldTeam(env());
  roster(e, 's1', [{ name: '栃木シティ' }]);

  eq(names(e, 's2'), ['ガンバ大阪', '柏レイソル'], 's2 は従来どおり');
});

t('名簿に無いチームの試合でも集計はする', () => {
  const e = withOldTeam(env());
  roster(e, 's1', [{ name: 'ガンバ大阪' }]);
  match(e, { id: 'm1', season: 's1', home: 't_A', away: 't_B', hs: 2, as: 1 });

  // 名簿から漏れていても、試合に出ていれば表に出す。
  // 入れ忘れを黙って消すほうが危ない
  eq(names(e), ['ガンバ大阪', '柏レイソル']);
});

t('名簿があっても数字は試合から出す', () => {
  const e = env();
  roster(e, 's1', [{ name: 'ガンバ大阪' }, { name: '柏レイソル' }]);
  match(e, { id: 'm1', season: 's1', home: 't_A', away: 't_B', hs: 3, as: 0 });

  const g = table(e).filter((r) => r.team_name === 'ガンバ大阪')[0];
  eq(g.won, 1);
  eq(g.points, 3);
  eq(g.gf, 3);
});

// =============================================================================
// 当時のGM名
// =============================================================================

t('当時のGM名が順位表に乗る', () => {
  const e = env();
  roster(e, 's1', [
    { name: 'ガンバ大阪', owner_memo: 'あず' },
    { name: '柏レイソル', owner_memo: 'クリファ' },
  ]);

  const g = table(e).filter((r) => r.team_name === 'ガンバ大阪')[0];
  eq(g.owner_memo, 'あず');
});

t('GM名が無ければ空文字', () => {
  const e = env();
  roster(e, 's1', [{ name: 'ガンバ大阪' }]);
  eq(table(e)[0].owner_memo, '');
});

t('名簿が無いシーズンも空文字で返る', () => {
  const e = env();
  ok(table(e).every((r) => r.owner_memo === ''));
});

t('GM名はシーズンごとに別々に持てる', () => {
  const e = env();
  roster(e, 's1', [{ name: 'ガンバ大阪', owner_memo: 'あず' }]);
  roster(e, 's2', [{ name: 'ガンバ大阪', owner_memo: 'ごむちっぷ' }]);

  eq(table(e, 's1')[0].owner_memo, 'あず');
  eq(table(e, 's2')[0].owner_memo, 'ごむちっぷ');
});

t('ディビジョンを割り当て直してもGM名は残る', () => {
  const e = env();
  roster(e, 's1', [
    { name: 'ガンバ大阪', owner_memo: 'あず' },
    { name: '柏レイソル', owner_memo: 'クリファ' },
  ]);

  e.setSeasonDivisions('ORG', {
    season_id: 's1',
    assignments: [{ team_id: 't_A', division: 'GM1' }, { team_id: 't_B', division: 'GM1' }],
  });

  eq(table(e).filter((r) => r.team_name === 'ガンバ大阪')[0].owner_memo, 'あず');
});

// =============================================================================
// 取り込みの検証
// =============================================================================

t('入れ直すと前の名簿は消える', () => {
  const e = withOldTeam(env());
  roster(e, 's1', [{ name: 'ガンバ大阪' }, { name: '柏レイソル' }]);

  const r = roster(e, 's1', [{ name: '栃木シティ' }]);
  eq(r.data.removed, 2);
  eq(r.data.added, 1);
  eq(names(e), ['栃木シティ']);
});

t('team_id でも指定できる', () => {
  const e = env();
  eq(roster(e, 's1', [{ team_id: 't_A' }]).ok, true);
  eq(names(e), ['ガンバ大阪']);
});

t('知らないチーム名は全体を拒否する', () => {
  const e = env();
  const r = roster(e, 's1', [{ name: 'ガンバ大阪' }, { name: '存在しないFC' }]);

  eq(r.ok, false);
  ok(r.error.indexOf('存在しないFC') !== -1, r.error);
  eq(names(e), ['ガンバ大阪', '柏レイソル'], '1件も入っていないこと');
});

t('同じチームが2度出たら拒否する', () => {
  const e = env();
  eq(roster(e, 's1', [{ name: 'ガンバ大阪' }, { name: 'ガンバ大阪' }]).ok, false);
});

t('name も team_id も無ければ拒否する', () => {
  const e = env();
  eq(roster(e, 's1', [{ owner_memo: 'あず' }]).ok, false);
});

t('division が不正なら拒否する', () => {
  const e = env();
  eq(roster(e, 's1', [{ name: 'ガンバ大阪', division: 'GM3' }]).ok, false);
});

t('チームが空なら拒否する', () => {
  const e = env();
  eq(roster(e, 's1', []).ok, false);
});

t('存在しないシーズンは拒否する', () => {
  const e = env();
  eq(roster(e, 's_none', [{ name: 'ガンバ大阪' }]).ok, false);
});

t('参加者は取り込めない', () => {
  const e = env();
  eq(e.importSeasonTeams('A', { season_id: 's1', teams: [{ name: 'ガンバ大阪' }] }).ok, false);
});

// =============================================================================
// 二部制
// =============================================================================

t('GM2 を指定すると二部制になる', () => {
  const e = env();
  roster(e, 's1', [
    { name: 'ガンバ大阪', division: 'GM1' },
    { name: '柏レイソル', division: 'GM2' },
  ]);

  const d = e.getStandings('ORG', { season_id: 's1' }).data;
  eq(d.two_division, true);
});

t('ディビジョンで絞ると片方だけ出る', () => {
  const e = env();
  roster(e, 's1', [
    { name: 'ガンバ大阪', division: 'GM1' },
    { name: '柏レイソル', division: 'GM2' },
  ]);

  eq(names(e).length, 2);
  eq(e.getStandings('ORG', { season_id: 's1', division: 'GM2' }).data.table
    .map((r) => r.team_name), ['柏レイソル']);
});

report('seasonteams.js');
