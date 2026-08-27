const { t, eq, ok, report } = require('./harness');
const { env } = require('./st-fixture');

// 過去シーズンの対戦表を一括で取り込む。移行専用。
// 順位表は試合から導出するので、表の数字だけを保存する逃げ道は作らない。

const M = (over) => Object.assign({
  round: '1', home: 'ガンバ大阪', away: '柏レイソル', home_score: 2, away_score: 1,
}, over);

const stand = (e, season) =>
  e.getStandings('ORG', { season_id: season || 's1', division: 'GM1' }).data;

// =============================================================================
// 取り込み
// =============================================================================

t('チーム名で取り込める', () => {
  const e = env();
  const r = e.importMatches('ORG', { season_id: 's1', matches: [M()] });

  eq(r.ok, true, r.error);
  eq(r.data.added, 1);
  eq(stand(e).match_count, 1);
});

t('終了したシーズンにも入れられる', () => {
  const e = env();
  // s1 は 終了 状態。通常の申請は通らないが取り込みは通す
  eq(e.importMatches('ORG', { season_id: 's1', matches: [M()] }).ok, true);
});

t('得点者が無くても入る', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', matches: [M({ home_score: 5, away_score: 0 })] });

  const row = stand(e).table.filter((x) => x.team_name === 'ガンバ大阪')[0];
  eq(row.gf, 5);
  eq(row.ga, 0);
});

t('承認済みで入るので順位表にすぐ出る', () => {
  const e = env();
  e.importMatches('ORG', {
    season_id: 's1',
    matches: [M(), M({ round: '2', home: '柏レイソル', away: 'ガンバ大阪', home_score: 0, away_score: 0 })],
  });

  const t1 = stand(e).table.filter((x) => x.team_name === 'ガンバ大阪')[0];
  eq(t1.played, 2);
  eq(t1.won, 1);
  eq(t1.drawn, 1);
  eq(t1.points, 4);
});

t('まとめて入れても件数が合う', () => {
  const e = env();
  const list = [];
  for (let i = 1; i <= 20; i++) {
    list.push(M({ round: String(i), home_score: i % 3, away_score: i % 2 }));
  }
  const r = e.importMatches('ORG', { season_id: 's1', matches: list });

  eq(r.data.added, 20);
  eq(stand(e).match_count, 20);
});

// =============================================================================
// 入れ直し
// =============================================================================

t('replace で入れ直せる', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', matches: [M(), M({ round: '2' })] });

  const r = e.importMatches('ORG', { season_id: 's1', replace: true, matches: [M({ round: '9' })] });

  eq(r.data.removed, 2);
  eq(r.data.added, 1);
  eq(stand(e).match_count, 1);
});

t('replace は他のシーズンを消さない', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', matches: [M()] });
  e.importMatches('ORG', { season_id: 's2', matches: [M(), M({ round: '2' })] });

  e.importMatches('ORG', { season_id: 's1', replace: true, matches: [M({ round: '9' })] });

  eq(stand(e, 's1').match_count, 1);
  eq(stand(e, 's2').match_count, 2);
});

t('replace しなければ足される', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', matches: [M()] });
  e.importMatches('ORG', { season_id: 's1', matches: [M({ round: '2' })] });

  eq(stand(e).match_count, 2);
});

// =============================================================================
// 検証
// =============================================================================

t('知らないチーム名は全体を拒否する', () => {
  const e = env();
  const r = e.importMatches('ORG', {
    season_id: 's1',
    matches: [M(), M({ round: '2', away: '存在しないFC' })],
  });

  eq(r.ok, false);
  ok(r.error.indexOf('存在しないFC') !== -1, r.error);
  eq(stand(e).match_count, 0, '1件も入っていないこと');
});

t('同じチーム同士は拒否する', () => {
  const e = env();
  const r = e.importMatches('ORG', { season_id: 's1', matches: [M({ away: 'ガンバ大阪' })] });
  eq(r.ok, false);
});

t('負のスコアは拒否する', () => {
  const e = env();
  eq(e.importMatches('ORG', { season_id: 's1', matches: [M({ home_score: -1 })] }).ok, false);
});

t('チーム名が空なら拒否する', () => {
  const e = env();
  eq(e.importMatches('ORG', { season_id: 's1', matches: [M({ home: '' })] }).ok, false);
});

t('試合が空なら拒否する', () => {
  const e = env();
  eq(e.importMatches('ORG', { season_id: 's1', matches: [] }).ok, false);
});

t('存在しないシーズンは拒否する', () => {
  const e = env();
  eq(e.importMatches('ORG', { season_id: 's_none', matches: [M()] }).ok, false);
});

t('stage が不正なら拒否する', () => {
  const e = env();
  eq(e.importMatches('ORG', { season_id: 's1', stage: 'よくわからない', matches: [M()] }).ok, false);
});

t('参加者は取り込めない', () => {
  const e = env();
  eq(e.importMatches('A', { season_id: 's1', matches: [M()] }).ok, false);
});

// =============================================================================
// 他の集計とのつながり
// =============================================================================

t('チームスタッツにも試合数が出る', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', matches: [M(), M({ round: '2' })] });

  const g = e.getTeamStats('ORG', { season_id: 's1' }).data.teams
    .filter((x) => x.team_name === 'ガンバ大阪')[0];
  eq(g.matches, 2);
  eq(g.goals_for, 4);
  eq(g.shots, 0, 'スタッツは未入力');
});

t('得点ランキングは空のまま', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', matches: [M()] });

  const r = e.getRankings('ORG', { season_id: 's1' }).data;
  eq(r.match_count, 1);
  eq(r.goals, []);
});

t('リーグ杯として取り込める', () => {
  const e = env();
  e.importMatches('ORG', { season_id: 's1', stage: 'tournament', matches: [M()] });

  eq(stand(e).match_count, 0, 'リーグ順位表には出ない');
  eq(e.getRankings('ORG', { season_id: 's1', competition: 'GMリーグ杯' }).data.match_count, 1);
});

report('importmatch.js');
