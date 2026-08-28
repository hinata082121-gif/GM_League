const { createEnv } = require('./harness');

// 試合とスタッツを扱うための環境。
// Matches / MatchTeamStats / MatchGKStats を実際のヘッダーで用意する。
const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Players: ['player_id','name','position','detail_position','age','nationality','real_club','eligible'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  Matches: ['match_id','season_id','stage','round','tie_id','leg','home_team','away_team','home_score','away_score','home_pk','away_pk','status','reported_by','created_at'],
  MatchGoals: ['goal_id','match_id','team_id','scorer_id','assist_id'],
  MatchTeamStats: ['id','match_id','team_id','possession','shots','shots_on_target','passes','passes_success','crosses'],
  MatchGKStats: ['id','match_id','team_id','gk_player_id','saves'],
  SeasonTeams: ['season_id','team_id','division','owner_memo'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Managers: ['manager_id','name','club','category','active'],
  ManagerPicks: ['pick_id','season_id','team_id','round','manager_id','status','created_at','decided_at'],
  Config: ['key','value','note'],
};

const CONFIG = {
  win_points: 3, draw_points: 1,
  min_matches_for_save_rate: 1,
  two_division_min_teams: 15,
  squad_min: 22, squad_max: 35,
};

/** A=ガンバ / B=柏 の2チーム。GKと得点者を1人ずつ置く */
function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));

  e.__tokens['ORG'] = 'org@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });

  [['A', 'ガンバ大阪'], ['B', '柏レイソル']].forEach(([k, name]) => {
    const email = k.toLowerCase() + '@example.com';
    e.__tokens[k] = email;
    e.__addRow('Users', { user_id: 'u_' + k, email, display_name: 'GM' + k, role: 'team', team_id: 't_' + k });
    e.__addRow('Teams', { team_id: 't_' + k, name, owner_user_id: 'u_' + k, kind: '継続', active: true });
  });

  e.__addRow('Seasons', { season_id: 's1', name: 'Season14', status: '終了' });
  e.__addRow('Seasons', { season_id: 's2', name: 'Season15', status: 'シーズン1' });

  // 各チームに GK と FW を1人ずつ
  [['pA_gk', 'GK', 'GK', 'A'], ['pA_fw', 'FW', 'CF', 'A'],
   ['pB_gk', 'GK', 'GK', 'B'], ['pB_fw', 'FW', 'CF', 'B']].forEach(([id, pos, detail, team]) => {
    e.__addRow('Players', { player_id: id, name: id, position: pos, detail_position: detail, age: 25, eligible: true });
    ['s1', 's2'].forEach((s) =>
      e.__addRow('Rosters', { roster_id: 'r_' + id + s, season_id: s, team_id: 't_' + team, player_id: id, status: '在籍', acquisition_type: '初期', acquired_cost: 0 }));
  });

  return e;
}

/**
 * 承認済みの試合を1つ足す。
 *
 * @param {Object} e
 * @param {Object} o { id, season, home, away, hs, as, stats:[{team,...}], gk:[{team,player,saves}], goals:[{team,scorer,assist}] }
 */
function match(e, o) {
  const id = o.id;
  e.__addRow('Matches', {
    match_id: id, season_id: o.season || 's2', stage: o.stage || 'league',
    round: o.round || '1', home_team: o.home, away_team: o.away,
    home_score: o.hs, away_score: o.as, status: '承認',
  });

  (o.goals || []).forEach((g, i) =>
    e.__addRow('MatchGoals', { goal_id: id + '_g' + i, match_id: id, team_id: g.team, scorer_id: g.scorer, assist_id: g.assist || '' }));

  (o.stats || []).forEach((s, i) =>
    e.__addRow('MatchTeamStats', {
      id: id + '_s' + i, match_id: id, team_id: s.team,
      possession: s.possession, shots: s.shots, shots_on_target: s.sot,
      passes: s.passes, passes_success: s.ok, crosses: s.crosses,
    }));

  (o.gk || []).forEach((g, i) =>
    e.__addRow('MatchGKStats', { id: id + '_k' + i, match_id: id, team_id: g.team, gk_player_id: g.player, saves: g.saves }));
}

module.exports = { env, match };
