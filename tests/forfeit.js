const { t, eq, ok, report } = require('./harness');
const st = require('./st-fixture');

// 不戦勝・不戦敗・両者不戦敗。
//   - 不戦勝は 3-0 扱い（得失点・総得点に入る）
//   - 両者不戦敗は 0-0 だが両チームとも負け・勝点0
//   - 主催者だけが登録でき、登録した時点で承認済み
//   - チームスタッツと個人成績には一切入れない

const forfeit = (e, who, kind, extra) =>
  e.submitMatchResult(who, Object.assign({
    season_id: 's2', stage: 'league', round: '第1節', home_team: 't_A', away_team: 't_B',
    forfeit: kind,
    // 画面から何が来てもサーバーで捨てることを確かめるため、わざと値を入れる
    home_score: 9, away_score: 9,
    goals: [{ team_id: 't_A', scorer_id: 'pA_fw', assist_id: '' }],
    team_stats: [{ team_id: 't_A', possession: 60, shots: 10, shots_on_target: 5, passes: 300, passes_success: 250, crosses: 5 }],
    gk_stats: [{ team_id: 't_B', gk_player_id: 'pB_gk', saves: 4 }],
  }, extra || {}));

const row = (e, name) => e.getStandings('ORG', { season_id: 's2' }).data.table.find((r) => r.team_name === name);

t('ホームの不戦勝は 3-0 で承認済みになり、得点者・スタッツ・GK は残らない', () => {
  const e = st.env();
  const r = forfeit(e, 'ORG', 'home_win');
  eq(r.ok, true, r.error);
  eq(r.data.status, '承認');
  const d = e.getMatchDetail('ORG', { match_id: r.data.match_id }).data;
  eq([d.match.home_score, d.match.away_score], [3, 0]);
  eq(d.match.forfeit, 'home_win');
  eq(d.match.forfeit_label, 'ホームの不戦勝');
  eq([d.goals.length, d.team_stats.length, d.gk_stats.length], [0, 0, 0]);
});

t('不戦勝は順位表で勝ち・勝点3・得失点+3', () => {
  const e = st.env();
  forfeit(e, 'ORG', 'away_win');
  const a = row(e, 'ガンバ大阪');
  const b = row(e, '柏レイソル');
  eq([b.played, b.won, b.points, b.gf, b.ga, b.gd], [1, 1, 3, 3, 0, 3]);
  eq([a.played, a.lost, a.points, a.gd], [1, 1, 0, -3]);
});

t('不戦勝のスコアは Config の forfeit_score で変えられる', () => {
  const e = st.env();
  e.__addRow('Config', { key: 'forfeit_score', value: 2, note: '' });
  e.clearConfigCache();
  const r = forfeit(e, 'ORG', 'home_win');
  const d = e.getMatchDetail('ORG', { match_id: r.data.match_id }).data;
  eq([d.match.home_score, d.match.away_score], [2, 0]);
});

t('両者不戦敗は両チームとも負け・勝点0で、引き分けにならない', () => {
  const e = st.env();
  forfeit(e, 'ORG', 'both_loss');
  [row(e, 'ガンバ大阪'), row(e, '柏レイソル')].forEach((r) => {
    eq([r.played, r.won, r.drawn, r.lost, r.points, r.gf, r.ga], [1, 0, 0, 1, 0, 0, 0]);
  });
});

t('参加者は不戦を登録できない', () => {
  const e = st.env();
  const r = forfeit(e, 'A', 'home_win');
  eq(r.ok, false);
  ok(/主催者/.test(r.error), r.error);
});

t('スーパーカップは不戦で登録できない', () => {
  const e = st.env();
  const r = forfeit(e, 'ORG', 'home_win', { stage: 'supercup' });
  eq(r.ok, false);
});

t('不戦の種類が不正なら断る', () => {
  const e = st.env();
  const r = forfeit(e, 'ORG', 'draw');
  eq(r.ok, false);
});

t('Matches に forfeit 列が無ければ、setupAll を促して止まる', () => {
  const e = st.env();
  const head = e.__rows('Matches')[0];
  head.splice(head.indexOf('forfeit'), 1);
  e.__dropCache('Matches');
  const r = forfeit(e, 'ORG', 'home_win');
  eq(r.ok, false);
  ok(/setupAll/.test(r.error), r.error);
});

t('不戦の試合はチームスタッツの試合数・得点に入らない', () => {
  const e = st.env();
  st.match(e, {
    id: 'm1', home: 't_A', away: 't_B', hs: 1, as: 0,
    goals: [{ team: 't_A', scorer: 'pA_fw' }],
    stats: [{ team: 't_A', possession: 60, shots: 10, sot: 5, passes: 300, ok: 250, crosses: 4 },
            { team: 't_B', possession: 40, shots: 4, sot: 2, passes: 200, ok: 150, crosses: 2 }],
  });
  forfeit(e, 'ORG', 'home_win', { round: '第2節' });
  const a = e.getTeamStats('ORG', { season_id: 's2' }).data.teams.find((x) => x.team_id === 't_A');
  eq([a.matches, a.goals_for, a.possession, a.shots_avg], [1, 1, 60, 10]);
});

t('不戦の試合は GK の1試合あたりセーブ数の分母に入らない', () => {
  const e = st.env();
  st.match(e, { id: 'm1', home: 't_A', away: 't_B', hs: 0, as: 0, gk: [{ team: 't_B', player: 'pB_gk', saves: 4 }] });
  forfeit(e, 'ORG', 'home_win', { round: '第2節' });
  const s = e.getRankings('ORG', { season_id: 's2' }).data.saves_avg.find((x) => x.player_id === 'pB_gk');
  eq([s.team_matches, s.saves_avg], [1, 4]);
});

t('不戦に訂正すると得点者・スタッツが消えて承認済みになる', () => {
  const e = st.env();
  const sub = e.submitMatchResult('A', {
    season_id: 's2', stage: 'league', round: '第1節', home_team: 't_A', away_team: 't_B',
    home_score: 1, away_score: 0, goals: [{ team_id: 't_A', scorer_id: 'pA_fw', assist_id: '' }],
    team_stats: [], gk_stats: [],
  });
  eq(sub.ok, true, sub.error);
  const r = e.correctMatch('ORG', {
    match_id: sub.data.match_id, season_id: 's2', stage: 'league', round: '第1節',
    home_team: 't_A', away_team: 't_B', forfeit: 'away_win', goals: [], team_stats: [], gk_stats: [],
  });
  eq(r.ok, true, r.error);
  eq(r.data.status, '承認');
  const d = e.getMatchDetail('ORG', { match_id: sub.data.match_id }).data;
  eq([d.match.home_score, d.match.away_score, d.goals.length, d.match.forfeit], [0, 3, 0, 'away_win']);
  eq(e.getRankings('ORG', { season_id: 's2' }).data.goals.length, 0);
});

report('forfeit.js');
