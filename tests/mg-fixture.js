const { createEnv } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Managers: ['manager_id','name','club','category','active'],
  ManagerPicks: ['pick_id','season_id','team_id','round','manager_id','status','created_at','decided_at'],
  ScheduleTemplate: ['sort_order','day_offset','label','note'],
  SeasonSchedule: ['schedule_id','season_id','date','label','note','sort_order','done'],
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  Clubs: ['category','club_name','sort_order'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  Players: ['player_id','name','position','real_club','eligible'],
  Matches: ['match_id','season_id','stage','round','tie_id','leg','home_team','away_team','home_score','away_score','home_pk','away_pk','status','reported_by','created_at'],
  MatchGoals: ['goal_id','match_id','team_id','scorer_id','assist_id'],
  MatchTeamStats: ['id','match_id','team_id','shots','shots_on_target'],
  MatchGKStats: ['id','match_id','team_id','gk_player_id','saves'],
  SeasonTeams: ['season_id','team_id','division'],
  SuperCup: ['season_id','team_a','team_b','streamed','note'],
  EntryLists: ['entry_id','season_id','team_id','status','submitted_at'],
  Protections: ['protection_id','season_id','team_id','player_id','window','slot','fee'],
  Config: ['key','value','note'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
};

const CONFIG = { manager_round: 0, two_division_min_teams: 15, win_points: 3, draw_points: 1 };

// 監督は4人（J1が3人、J2が1人）。うち1人は名前未入力
const MANAGERS = [
  ['mg_1', '監督A', '鹿島アントラーズ', 'J1', true],
  ['mg_2', '監督B', '浦和レッズ', 'J1', true],
  ['mg_3', '監督C', '川崎フロンターレ', 'J1', true],
  ['mg_4', '監督D', 'V・ファーレン長崎', 'J2', true],
  ['mg_5', '', 'FC町田ゼルビア', 'J1', true],       // 名前未入力
  ['mg_6', '監督F', '横浜FM', 'J1', false],          // 非アクティブ
];

function env(opts) {
  opts = opts || {};
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, opts.config || {}));

  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__tokens['ORG'] = 'org@example.com';

  ['A', 'B', 'C', 'D', 'E'].forEach((k) => {
    const email = k.toLowerCase() + '@example.com';
    e.__tokens[k] = email;
    e.__addRow('Users', { user_id: 'u_' + k, email, display_name: 'GM' + k, role: 'team', team_id: 't_' + k });
    e.__addRow('Teams', { team_id: 't_' + k, name: 'チーム' + k, owner_user_id: 'u_' + k, kind: '継続', active: true });
  });

  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: '準備中' });

  MANAGERS.forEach(([manager_id, name, club, category, active]) => {
    e.__addRow('Managers', { manager_id, name, club, category, active });
  });

  return e;
}

/** Config を書き換えてラウンドを切り替える（setManagerRound はテスト対象なので直接も用意） */
function setRound(e, round, maxTeams) {
  e.__addRow('Config', { key: 'manager_round', value: round });

  // harness の getConfig はスナップショットなので差し替える
  const max = maxTeams === undefined ? 3 : maxTeams;
  e.getConfig = (key, def) => {
    if (key === 'manager_round') return round;
    if (key === 'manager_max_teams') return max;
    return def !== undefined ? def : '';
  };
  e.getConfigNum = (key, def) => Number(e.getConfig(key, def)) || 0;
}

const picks = (e) => e.__rows('ManagerPicks').slice(1);
const pickOf = (e, teamId) => picks(e).find((p) => p[2] === teamId);

module.exports = { env, setRound, picks, pickOf };
