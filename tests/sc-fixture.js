const { createEnv } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
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

const CONFIG = { two_division_min_teams: 15, win_points: 3, draw_points: 1 };

// ひな型: 開幕(0)を基準に、開幕14日前から
const TEMPLATE = [
  [-14, 'エントリー変更締切', ''],
  [-13, 'スポンサー申告締切日', ''],
  [-13, '無料プロテクト締切', ''],
  [-8,  '移籍期間［終］', ''],
  [-7,  '（空き日）', '予備日'],
  [0,   'リーグ戦開幕', ''],
];

function env(opts) {
  opts = opts || {};
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, opts.config || {}));
  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['A'] = 'a@example.com';

  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'GM太郎', role: 'team', team_id: 't_a' });
  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', owner_user_id: 'u_a', kind: '継続', active: true });
  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: '準備中' });

  if (opts.template !== false) {
    TEMPLATE.forEach(([day_offset, label, note], i) => {
      e.__addRow('ScheduleTemplate', { sort_order: i + 1, day_offset, label, note });
    });
  }

  return e;
}

const scheduleRows = (e) => e.__rows('SeasonSchedule').slice(1);

/** 生成された日程を「ラベル → YYYY-MM-DD」で引けるようにする */
function dateOf(e, label) {
  const row = scheduleRows(e).find((r) => r[3] === label);
  if (!row) return null;
  const d = row[2] instanceof Date ? row[2] : new Date(row[2]);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

module.exports = { env, scheduleRows, dateOf, TEMPLATE };
