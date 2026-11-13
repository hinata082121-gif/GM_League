const { t, eq, ok, report } = require('./harness');
const { env } = require('./st-fixture');

// 試合入力の選手一覧（_seasonPlayersOf）。同じ選手に「離脱」と「在籍」の
// 2行があると、最初の行だけで current を決めていたため、在籍に戻した
// エリキ リマが離脱扱いのまま一覧から消えていた。

function firstTeam(e) {
  const rows = e.__rows('Teams'); const c = rows[0];
  return rows[1][c.indexOf('team_id')];
}

t('離脱のあと在籍に戻した選手は current（一覧に出る）', () => {
  const e = env();
  const team = firstTeam(e);
  e.__addRow('Players', { player_id: 'p_back', name: '戻した選手', position: 'FW' });
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's_x', team_id: team, player_id: 'p_back', status: '離脱' });
  e.__addRow('Rosters', { roster_id: 'r2', season_id: 's_x', team_id: team, player_id: 'p_back', status: '在籍' });
  const list = e._seasonPlayersOf('s_x', team).filter((p) => p.player_id === 'p_back');
  eq(list.length, 1, '1人として返す');
  ok(list[0].current, '在籍の行があるので current');
});

t('離脱の行しか無い選手は current にならない', () => {
  const e = env();
  const team = firstTeam(e);
  e.__addRow('Players', { player_id: 'p_gone', name: '出た選手', position: 'DF' });
  e.__addRow('Rosters', { roster_id: 'r3', season_id: 's_x', team_id: team, player_id: 'p_gone', status: '離脱' });
  const p = e._seasonPlayersOf('s_x', team).find((x) => x.player_id === 'p_gone');
  ok(p && !p.current, '離脱のみなら current ではない');
});

report('matchroster.js');
