const { t, eq, ok, report } = require('./harness');
const { env, match } = require('./st-fixture');

/** s1（終了済み）に試合と予算を入れる */
function past(e) {
  match(e, {
    id: 'm1', season: 's1', home: 't_A', away: 't_B', hs: 2, as: 1,
    stats: [
      { team: 't_A', possession: 60, shots: 10, sot: 5, passes: 400, ok: 340, crosses: 8 },
      { team: 't_B', possession: 40, shots: 6, sot: 2, passes: 300, ok: 240, crosses: 4 },
    ],
    gk: [{ team: 't_A', player: 'pA_gk', saves: 1 }, { team: 't_B', player: 'pB_gk', saves: 3 }],
    goals: [
      { team: 't_A', scorer: 'pA_fw', assist: 'pA_gk' },
      { team: 't_A', scorer: 'pA_fw', assist: '' },
      { team: 't_B', scorer: 'pB_fw', assist: '' },
    ],
  });

  e.__addRow('BudgetTx', { tx_id: 'b1', season_id: 's1', team_id: 't_A', amount: 100000000, reason: '順位賞金' });
  e.__addRow('BudgetTx', { tx_id: 'b2', season_id: 's1', team_id: 't_A', amount: -10000000, reason: 'シーズン終了手数料' });
  e.__addRow('BudgetTx', { tx_id: 'b3', season_id: 's1', team_id: 't_B', amount: 50000000, reason: '順位賞金' });
}

const teamOf = (d, id) => d.teams.filter((x) => x.team_id === id)[0];

// =============================================================================
// 一覧
// =============================================================================

t('終了したシーズンだけ並ぶ', () => {
  const e = env();
  const r = e.listArchivedSeasons('ORG');

  eq(r.ok, true);
  eq(r.data.map((s) => s.name), ['Season14']);
});

t('参加者も一覧を見られる', () => {
  const e = env();
  eq(e.listArchivedSeasons('A').ok, true);
});

t('ログインしていなければ見られない', () => {
  const e = env();
  eq(e.listArchivedSeasons('unknown').ok, false);
});

// =============================================================================
// 中身
// =============================================================================

t('順位表・ランキング・チームスタッツが揃って返る', () => {
  const e = env();
  past(e);

  const r = e.getSeasonArchive('ORG', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.name, 'Season14');
  eq(r.data.status, '終了');

  ok(r.data.standings, '順位表');
  ok(r.data.rankings, 'ランキング');
  ok(r.data.team_stats, 'チームスタッツ');
  eq(r.data.rankings.goals[0].goals, 2);
  eq(teamOf(r.data.team_stats, 't_A').shots, 10);
});

t('チームごとの終了時スカッドが入る', () => {
  const e = env();
  past(e);

  const a = teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A');
  eq(a.team_name, 'ガンバ大阪');
  eq(a.total, 2);
  eq(a.squad.map((p) => p.player_id), ['pA_gk', 'pA_fw']);
  eq(a.position_counts.GK, 1);
  eq(a.position_counts.FW, 1);
});

t('チームごとの終了時予算が入る', () => {
  const e = env();
  past(e);

  const a = teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A');
  eq(a.budget_total, 90000000);
  eq(a.budget_breakdown.length, 2);
  eq(a.budget_breakdown.filter((b) => b.reason === 'シーズン終了手数料')[0].amount, -10000000);
});

t('スカッドはポジション順に並ぶ', () => {
  const e = env();
  past(e);

  const a = teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A');
  eq(a.squad[0].position, 'GK');
  eq(a.squad[1].position, 'FW');
});

t('使用監督が確定していれば載る', () => {
  const e = env();
  past(e);
  e.__addRow('Managers', { manager_id: 'mg1', name: '黒田 剛', club: 'FC町田ゼルビア', category: 'J1', active: true });
  e.__addRow('ManagerPicks', { pick_id: 'p1', season_id: 's1', team_id: 't_A', round: 1, manager_id: 'mg1', status: '確定' });

  eq(teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A').manager, '黒田 剛');
});

t('監督が未設定でも落ちない', () => {
  const e = env();
  past(e);
  eq(teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A').manager, '');
});

// =============================================================================
// 混ざらないこと
// =============================================================================

t('別シーズンの在籍は混ざらない', () => {
  const e = env();
  past(e);
  // s2 だけに1人足す
  e.__addRow('Players', { player_id: 'pX', name: '新加入', position: 'MF', detail_position: 'CMF', eligible: true });
  e.__addRow('Rosters', { roster_id: 'rX', season_id: 's2', team_id: 't_A', player_id: 'pX', status: '在籍' });

  eq(teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A').total, 2);
});

t('離脱した選手は入らない', () => {
  const e = env();
  past(e);
  e.__rows('Rosters')[1][4] = '離脱';   // pA_gk の s1 を離脱に

  eq(teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A').total, 1);
});

t('別シーズンの予算は混ざらない', () => {
  const e = env();
  past(e);
  e.__addRow('BudgetTx', { tx_id: 'b9', season_id: 's2', team_id: 't_A', amount: 999, reason: '前シーズンからの繰越' });

  eq(teamOf(e.getSeasonArchive('ORG', { season_id: 's1' }).data, 't_A').budget_total, 90000000);
});

// =============================================================================
// 検証
// =============================================================================

t('season_id が無ければ拒否する', () => {
  const e = env();
  eq(e.getSeasonArchive('ORG', {}).ok, false);
});

t('存在しないシーズンは拒否する', () => {
  const e = env();
  eq(e.getSeasonArchive('ORG', { season_id: 's_none' }).ok, false);
});

t('終了していないシーズンでも中身は返す', () => {
  const e = env();
  past(e);

  const r = e.getSeasonArchive('ORG', { season_id: 's2' });
  eq(r.ok, true, '進行中でも参照できること');
  eq(r.data.status, 'シーズン1');
});

report('archive.js');
