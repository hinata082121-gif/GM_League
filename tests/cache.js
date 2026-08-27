const { t, eq, ok, report } = require('./harness');
const { env } = require('./st-fixture');
const { env: pfEnv } = require('./pf-fixture');

// 読み取りキャッシュは1リクエストのあいだだけ効く。
// 書き込みは必ず getSheet() を通るので、そこでキャッシュを捨てている。
// ここで確かめたいのは「速くなったか」ではなく「古い値を掴まないか」。

t('追加した行がすぐ読める', () => {
  const e = pfEnv();
  eq(e.listPlayers('ORG', {}).data.length, 0);

  e.upsertPlayer('ORG', { name: '宇佐美 貴史', detail_position: 'OMF' });

  eq(e.listPlayers('ORG', {}).data.length, 1, '追加が見えないならキャッシュが残っている');
});

t('更新した値がすぐ読める', () => {
  const e = pfEnv();
  e.upsertPlayer('ORG', { name: '宇佐美 貴史', detail_position: 'OMF', age: 30 });
  const id = e.listPlayers('ORG', {}).data[0].player_id;

  e.upsertPlayer('ORG', { player_id: id, name: '宇佐美 貴史', detail_position: 'OMF', age: 34 });

  eq(e.listPlayers('ORG', {}).data[0].age, 34);
});

t('削除した行がすぐ消える', () => {
  const e = pfEnv();
  e.upsertPlayer('ORG', { name: '消される人', detail_position: 'CB' });
  const id = e.listPlayers('ORG', {}).data[0].player_id;

  e.deletePlayer('ORG', { player_id: id });

  eq(e.listPlayers('ORG', {}).data.length, 0);
});

t('1つの呼び出しの中で書いてから読む処理が正しい', () => {
  // importRoster は Players に足しながら Rosters を作る。
  // 途中で古い Players を読むと、作ったばかりの選手を見失う
  const e = pfEnv();
  const r = e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [
      { name: '新人A', position: 'CB' },
      { name: '新人B', position: 'CF' },
      { name: '新人C', position: 'GK' },
    ],
  });

  eq(r.ok, true, r.error);
  eq(r.data.added, 3);
  eq(r.data.created_players.length, 3);
  eq(e.getTeamSquad('ORG', { team_id: 't_a', season_id: 's2' }).data.total, 3);
});

t('予算は書き込みのたびに読み直される', () => {
  const e = pfEnv();

  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_a', amount: 1000, reason: '予算調整' });
  const a = e.getTeamBudget('ORG', { team_id: 't_a', season_id: 's2' }).data.balance;

  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_a', amount: 500, reason: '予算調整' });
  const b = e.getTeamBudget('ORG', { team_id: 't_a', season_id: 's2' }).data.balance;

  eq(a, 1000);
  eq(b, 1500, '2回目が反映されていないならキャッシュが残っている');
});

t('adjustBudget が返す残高も最新', () => {
  const e = pfEnv();
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_a', amount: 700, reason: '予算調整' });
  const r = e.adjustBudget('ORG', { season_id: 's2', team_id: 't_a', amount: 300, reason: '予算調整' });

  eq(r.data.balance, 1000);
});

t('試合を承認すると集計にすぐ出る', () => {
  const e = env();
  const mid = e.submitMatchResult('A', {
    season_id: 's2', stage: 'league', round: '1',
    home_team: 't_A', away_team: 't_B', home_score: 1, away_score: 0,
    goals: [{ team_id: 't_A', scorer_id: 'pA_fw', assist_id: '' }],
    team_stats: [{ team_id: 't_A', possession: 55, shots: 9, shots_on_target: 3, passes: 300, passes_success: 250, crosses: 5 }],
    gk_stats: [],
  }).data.match_id;

  eq(e.getTeamStats('ORG', { season_id: 's2' }).data.match_count, 0);

  e.approveMatch('ORG', { match_id: mid });

  eq(e.getTeamStats('ORG', { season_id: 's2' }).data.match_count, 1, '承認が見えていない');
});

t('訂正した内容がすぐ読める', () => {
  const e = env();
  const base = {
    season_id: 's2', stage: 'league', round: '1',
    home_team: 't_A', away_team: 't_B', home_score: 1, away_score: 0,
    goals: [{ team_id: 't_A', scorer_id: 'pA_fw', assist_id: '' }],
    team_stats: [{ team_id: 't_A', possession: 55, shots: 9, shots_on_target: 3, passes: 300, passes_success: 250, crosses: 5 }],
    gk_stats: [],
  };
  const mid = e.submitMatchResult('A', base).data.match_id;
  e.approveMatch('ORG', { match_id: mid });

  e.correctMatch('ORG', Object.assign({ match_id: mid }, base, {
    team_stats: [{ team_id: 't_A', possession: 61, shots: 20, shots_on_target: 9, passes: 500, passes_success: 450, crosses: 12 }],
  }));

  const s = e.getMatchDetail('ORG', { match_id: mid }).data.team_stats[0];
  eq(s.shots, 20);
  eq(s.passes, 500);
});

t('並べ替えても次に読む人に影響しない', () => {
  // 配列を複製して返しているので、呼び出し側の sort が漏れない
  const e = pfEnv();
  ['C', 'A', 'B'].forEach((n) => e.upsertPlayer('ORG', { name: n, detail_position: 'CB' }));

  const first = e.listPlayers('ORG', {}).data;
  first.sort((x, y) => (x.name < y.name ? 1 : -1));   // 逆順に並べ替える

  const second = e.listPlayers('ORG', {}).data;
  eq(second.map((p) => p.name), ['A', 'B', 'C'], '並びが持ち越されている');
});

report('cache.js');
