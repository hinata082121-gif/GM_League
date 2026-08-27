const { t, eq, ok, report } = require('./harness');
const { env } = require('./st-fixture');

/** 申請に使う既定の payload。上書きしたい項目だけ渡す */
function payload(over) {
  return Object.assign({
    season_id: 's2', stage: 'league', round: '1',
    home_team: 't_A', away_team: 't_B', home_score: 1, away_score: 0,
    goals: [{ team_id: 't_A', scorer_id: 'pA_fw', assist_id: '' }],
    team_stats: [
      { team_id: 't_A', possession: 55, shots: 10, shots_on_target: 4, passes: 400, passes_success: 340, crosses: 8 },
      { team_id: 't_B', possession: 45, shots: 6, shots_on_target: 2, passes: 300, passes_success: 240, crosses: 4 },
    ],
    gk_stats: [
      { team_id: 't_A', gk_player_id: 'pA_gk', saves: 2 },
      { team_id: 't_B', gk_player_id: 'pB_gk', saves: 4 },
    ],
  }, over);
}

const statOf = (e, mid, tid) =>
  e.getMatchDetail('ORG', { match_id: mid }).data.team_stats.filter((s) => s.team_id === tid)[0];

// =============================================================================
// 保存と読み出し
// =============================================================================

t('6項目すべてが保存される', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload());
  eq(r.ok, true, r.error);

  const s = statOf(e, r.data.match_id, 't_A');
  eq(s.possession, 55);
  eq(s.shots, 10);
  eq(s.shots_on_target, 4);
  eq(s.passes, 400);
  eq(s.passes_success, 340);
  eq(s.crosses, 8);
});

t('支配率は小数第1位まで残る', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload({
    team_stats: [{ team_id: 't_A', possession: 51.7, shots: 1, shots_on_target: 0, passes: 10, passes_success: 5, crosses: 0 }],
  }));

  eq(statOf(e, r.data.match_id, 't_A').possession, 51.7);
});

t('未入力の項目は0で入る', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload({
    team_stats: [{ team_id: 't_A', shots: 5, shots_on_target: 2 }],
  }));

  const s = statOf(e, r.data.match_id, 't_A');
  eq(s.passes, 0);
  eq(s.crosses, 0);
  eq(s.possession, 0);
});

t('チームスタッツを省いても申請できる', () => {
  const e = env();
  eq(e.submitMatchResult('A', payload({ team_stats: [] })).ok, true);
});

// =============================================================================
// 検証
// =============================================================================

t('パス成功数がパス数を超えたら拒否する', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload({
    team_stats: [{ team_id: 't_A', shots: 1, shots_on_target: 0, passes: 100, passes_success: 101, crosses: 0 }],
  }));

  eq(r.ok, false);
  ok(r.error.indexOf('パス成功') !== -1, r.error);
});

t('枠内シュートがシュート数を超えたら拒否する', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload({
    team_stats: [{ team_id: 't_A', shots: 3, shots_on_target: 4 }],
  }));

  eq(r.ok, false);
  ok(r.error.indexOf('枠内') !== -1, r.error);
});

t('支配率が100を超えたら拒否する', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload({
    team_stats: [{ team_id: 't_A', possession: 101, shots: 1, shots_on_target: 0 }],
  }));

  eq(r.ok, false);
  ok(r.error.indexOf('支配率') !== -1, r.error);
});

t('負の数は拒否する', () => {
  const e = env();
  ['passes', 'crosses', 'possession'].forEach((key) => {
    const s = { team_id: 't_A', shots: 1, shots_on_target: 0, passes: 10, passes_success: 5, crosses: 1 };
    s[key] = -1;
    const r = e.submitMatchResult('A', payload({ team_stats: [s] }));
    eq(r.ok, false, key + ' が負でも通ってしまう');
  });
});

t('支配率の合計が100でなくても通る', () => {
  const e = env();
  // eFootball の表示は丸めで 49/50 のようにずれることがある
  const r = e.submitMatchResult('A', payload({
    team_stats: [
      { team_id: 't_A', possession: 49, shots: 1, shots_on_target: 0 },
      { team_id: 't_B', possession: 50, shots: 1, shots_on_target: 0 },
    ],
  }));

  eq(r.ok, true, r.error);
  eq(statOf(e, r.data.match_id, 't_A').possession, 49);
});

t('対戦チーム以外の team_id は拒否する', () => {
  const e = env();
  const r = e.submitMatchResult('A', payload({
    team_stats: [{ team_id: 't_X', shots: 1, shots_on_target: 0 }],
  }));

  eq(r.ok, false);
});

// =============================================================================
// 訂正
// =============================================================================

t('訂正すると6項目とも入れ替わる', () => {
  const e = env();
  const mid = e.submitMatchResult('A', payload()).data.match_id;
  e.approveMatch('ORG', { match_id: mid });

  const r = e.correctMatch('ORG', Object.assign({ match_id: mid }, payload({
    team_stats: [{ team_id: 't_A', possession: 61, shots: 20, shots_on_target: 9, passes: 500, passes_success: 450, crosses: 12 }],
  })));
  eq(r.ok, true, r.error);

  const s = statOf(e, mid, 't_A');
  eq(s.possession, 61);
  eq(s.passes, 500);
  eq(s.crosses, 12);
});

t('訂正で古い行が残らない', () => {
  const e = env();
  const mid = e.submitMatchResult('A', payload()).data.match_id;
  e.approveMatch('ORG', { match_id: mid });

  e.correctMatch('ORG', Object.assign({ match_id: mid }, payload({
    team_stats: [{ team_id: 't_A', shots: 1, shots_on_target: 0 }],
  })));

  eq(e.getMatchDetail('ORG', { match_id: mid }).data.team_stats.length, 1);
});

// =============================================================================
// 集計へのつながり
// =============================================================================

t('承認するとチームスタッツに反映される', () => {
  const e = env();
  const mid = e.submitMatchResult('A', payload()).data.match_id;

  eq(e.getTeamStats('ORG', { season_id: 's2' }).data.teams.length, 0, '承認前は集計しない');

  e.approveMatch('ORG', { match_id: mid });

  const g = e.getTeamStats('ORG', { season_id: 's2' }).data.teams.filter((x) => x.team_id === 't_A')[0];
  eq(g.passes, 400);
  eq(g.possession, 55);
});

report('matchstats.js');
