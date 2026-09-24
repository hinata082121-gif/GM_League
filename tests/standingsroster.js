const { t, eq, ok, report } = require('./harness');
const { env } = require('./st-fixture');

// シーズン名簿（SeasonTeams）が無いシーズンの順位表に誰を並べるか。
// active なチームで代用していたため、Season15 から参加した横浜F・マリノスが
// Season14 の順位表に 0試合 で並んでいた。

const names = (e, sid) =>
  e.getStandings('ORG', { season_id: sid }).data.table.map((r) => r.team_name).sort();

function teamsOf(e) {
  const rows = e.__rows('Teams'); const c = rows[0];
  return rows.slice(1).map((r) => ({ id: r[c.indexOf('team_id')], name: r[c.indexOf('name')] }));
}

t('名簿が無いシーズンは、そのシーズンに在籍記録があるチームだけを並べる', () => {
  const e = env();
  const teams = teamsOf(e);
  ok(teams.length >= 2, 'チームが足りない');
  e.__addRow('Seasons', { season_id: 's_old', name: '過去', status: '終了' });
  e.__addRow('Rosters', { roster_id: 'x1', season_id: 's_old', team_id: teams[0].id, player_id: 'p', status: '在籍' });
  e.__dropCache('Seasons');
  eq(names(e, 's_old'), [teams[0].name]);
});

t('在籍記録も無いシーズンは、これまでどおり active なチームで代用する', () => {
  const e = env();
  e.__addRow('Seasons', { season_id: 's_new', name: '新', status: '準備中' });
  const n = names(e, 's_new');
  ok(n.length >= 2, n.join(','));
});

report('standingsroster.js');
