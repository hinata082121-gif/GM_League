const { t, eq, ok, report } = require('./harness');
const { env, squad, rosters } = require('./im-fixture');

t('シーズンを指定しないと最新シーズンだけ返る', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(5) });
  e.importRoster('ORG', { season_id: 's2', team_id: 't_A', players: squad(3) });

  // s2 が最新（Seasons の最終行）
  const all = e.getTeamSquad('ORG', { team_id: 't_A' });
  eq(all.ok, true);
  eq(all.data.squad.length, 3);
});

t('シーズンを指定すればそのシーズンが返る', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(5) });
  e.importRoster('ORG', { season_id: 's2', team_id: 't_A', players: squad(3) });

  eq(e.getTeamSquad('ORG', { team_id: 't_A', season_id: 's1' }).data.squad.length, 5);
  eq(e.getTeamSquad('ORG', { team_id: 't_A', season_id: 's2' }).data.squad.length, 3);
});

t('同じ選手が2度並ばない', () => {
  const e = env();
  // 同じ名簿を2シーズンに入れる（継続チームの引継ぎと同じ状態）
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(4) });
  e.importRoster('ORG', { season_id: 's2', team_id: 't_A', players: squad(4) });

  const sq = e.getTeamSquad('ORG', { team_id: 't_A' }).data.squad;
  const names = sq.map((x) => x.name);
  eq(names.length, new Set(names).size);
});

t('自チーム画面もシーズンが混ざらない', () => {
  const e = env();
  e.importRoster('ORG', { season_id: 's1', team_id: 't_A', players: squad(4) });
  e.importRoster('ORG', { season_id: 's2', team_id: 't_A', players: squad(4) });

  const d = e.getMyTeam('A', {}).data;
  eq(d.squad.squad.length, 4);
});

t('シーズンが1つも無くても落ちない', () => {
  const e = env();
  e.__rows('Seasons').length = 1;   // ヘッダーだけ残す
  const r = e.getTeamSquad('ORG', { team_id: 't_A' });
  eq(r.ok, true);
  eq(r.data.squad.length, 0);
});

report('squad.js');
