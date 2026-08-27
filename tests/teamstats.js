const { t, eq, ok, report } = require('./harness');
const { env, match } = require('./st-fixture');

/** ガンバ視点のスタッツ行を取り出す */
const gamba = (e, season) =>
  e.getTeamStats('ORG', { season_id: season || 's2' })
    .data.teams.filter((x) => x.team_id === 't_A')[0];

function twoMatches(e) {
  match(e, {
    id: 'm1', home: 't_A', away: 't_B', hs: 2, as: 1,
    stats: [
      { team: 't_A', possession: 60, shots: 10, sot: 5, passes: 400, ok: 340, crosses: 8 },
      { team: 't_B', possession: 40, shots: 6,  sot: 2, passes: 300, ok: 240, crosses: 4 },
    ],
    gk: [{ team: 't_A', player: 'pA_gk', saves: 1 }, { team: 't_B', player: 'pB_gk', saves: 3 }],
    goals: [
      { team: 't_A', scorer: 'pA_fw', assist: '' },
      { team: 't_A', scorer: 'pA_fw', assist: '' },
      { team: 't_B', scorer: 'pB_fw', assist: '' },
    ],
  });
  match(e, {
    id: 'm2', home: 't_B', away: 't_A', hs: 0, as: 0,
    stats: [
      { team: 't_B', possession: 45, shots: 4,  sot: 1, passes: 260, ok: 200, crosses: 2 },
      { team: 't_A', possession: 55, shots: 12, sot: 7, passes: 420, ok: 360, crosses: 10 },
    ],
    gk: [{ team: 't_B', player: 'pB_gk', saves: 7 }, { team: 't_A', player: 'pA_gk', saves: 1 }],
  });
}

// =============================================================================
// 合計
// =============================================================================

t('チームごとに合計が出る', () => {
  const e = env();
  twoMatches(e);

  const g = gamba(e);
  eq(g.matches, 2);
  eq(g.shots, 22);
  eq(g.shots_on_target, 12);
  eq(g.passes, 820);
  eq(g.passes_success, 700);
  eq(g.crosses, 18);
});

t('得点と失点も集まる', () => {
  const e = env();
  twoMatches(e);

  const g = gamba(e);
  eq(g.goals_for, 2);
  eq(g.goals_against, 1);
});

// =============================================================================
// 平均
// =============================================================================

t('1試合あたりの平均が出る', () => {
  const e = env();
  twoMatches(e);

  const g = gamba(e);
  eq(g.shots_avg, 11);
  eq(g.shots_on_target_avg, 6);
  eq(g.passes_avg, 410);
  eq(g.crosses_avg, 9);
});

t('支配率は平均だけを出す', () => {
  const e = env();
  twoMatches(e);

  const g = gamba(e);
  eq(g.possession, 57.5, '(60+55)/2');
  eq(g.possession_sum, undefined, '合計は返さない');
});

t('パス成功率とシュート精度は割合で出す', () => {
  const e = env();
  twoMatches(e);

  const g = gamba(e);
  eq(g.pass_rate, 85.4, '700/820');
  eq(g.shot_accuracy, 54.5, '12/22');
});

t('小数は1桁に丸める', () => {
  const e = env();
  match(e, {
    id: 'm1', home: 't_A', away: 't_B', hs: 1, as: 0,
    stats: [{ team: 't_A', possession: 33.333, shots: 7, sot: 3, passes: 100, ok: 33, crosses: 1 }],
  });

  const g = gamba(e);
  eq(g.possession, 33.3);
  eq(g.pass_rate, 33);
});

// =============================================================================
// 端の条件
// =============================================================================

t('試合が無ければ空で返る', () => {
  const e = env();
  const r = e.getTeamStats('ORG', { season_id: 's2' });
  eq(r.ok, true);
  eq(r.data.teams, []);
  eq(r.data.match_count, 0);
});

t('スタッツ未入力の試合でも試合数には数える', () => {
  const e = env();
  match(e, { id: 'm1', home: 't_A', away: 't_B', hs: 1, as: 0 });

  const g = gamba(e);
  eq(g.matches, 1);
  eq(g.shots, 0);
  eq(g.possession, 0, 'ゼロ割りしないこと');
  eq(g.pass_rate, 0);
});

t('承認されていない試合は数えない', () => {
  const e = env();
  twoMatches(e);
  e.__rows('Matches')[1][12] = '申請中';   // m1 を承認待ちに戻す

  const g = gamba(e);
  eq(g.matches, 1);
  eq(g.shots, 12);
});

t('シーズンが違えば混ざらない', () => {
  const e = env();
  twoMatches(e);
  match(e, {
    id: 'm9', season: 's1', home: 't_A', away: 't_B', hs: 5, as: 0,
    stats: [{ team: 't_A', possession: 70, shots: 30, sot: 20, passes: 900, ok: 800, crosses: 20 }],
  });

  eq(gamba(e, 's2').shots, 22);
  eq(gamba(e, 's1').shots, 30);
});

t('season_id が無ければ拒否する', () => {
  const e = env();
  eq(e.getTeamStats('ORG', {}).ok, false);
});

t('参加者も見られる', () => {
  const e = env();
  twoMatches(e);
  eq(e.getTeamStats('A', { season_id: 's2' }).ok, true);
});

t('支配率の高い順に並ぶ', () => {
  const e = env();
  twoMatches(e);

  const names = e.getTeamStats('ORG', { season_id: 's2' }).data.teams.map((x) => x.team_name);
  eq(names, ['ガンバ大阪', '柏レイソル']);
});

// =============================================================================
// GK の平均
// =============================================================================

t('GKのセーブに1試合あたりが付く', () => {
  const e = env();
  twoMatches(e);

  const r = e.getRankings('ORG', { season_id: 's2' }).data;
  const b = r.saves.filter((x) => x.player_id === 'pB_gk')[0];

  eq(b.saves, 10);
  eq(b.team_matches, 2);
  eq(b.saves_avg, 5);
});

t('平均のランキングは累計と別に並ぶ', () => {
  const e = env();
  twoMatches(e);

  const r = e.getRankings('ORG', { season_id: 's2' }).data;
  eq(r.saves_avg[0].player_id, 'pB_gk');
  eq(r.saves_avg[0].saves_avg, 5);
  eq(r.saves_avg[1].saves_avg, 1);
});

t('得点とアシストには平均を付けない', () => {
  const e = env();
  twoMatches(e);

  const r = e.getRankings('ORG', { season_id: 's2' }).data;
  eq(r.goals[0].goals, 2);
  eq(r.goals[0].goals_avg, undefined);
  eq(r.assists.length, 0);
});

report('teamstats.js');
