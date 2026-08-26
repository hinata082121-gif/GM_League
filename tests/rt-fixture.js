const { createEnv } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
  Clubs: ['category','club_name','sort_order'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
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

const CONFIG = {
  claim_rate_real_transfer: 0.8,
  claim_rate_withdrawal: 0.9,
  claim_default_choice: '払い戻し',
  compensation_rate_transfer: 0.8,
  compensation_rate_withdrawal: 0.9,
  season_end_fee_rate: 0.10,
  squad_min: 22, squad_max: 35,
  two_division_min_teams: 15, win_points: 3, draw_points: 1,
};

function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));
  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['A'] = 'a@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'オーナーA', role: 'team', team_id: 't_a' });

  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', owner_user_id: 'u_a', kind: '継続', active: true });
  e.__addRow('Teams', { team_id: 't_b', name: '浦和レッズ', owner_user_id: 'u_b', kind: '継続', active: true });

  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: 'トーナメント' });
  e.__addRow('Seasons', { season_id: 's2', name: '2027シーズン', status: '準備中' });

  [['p1','エース','FW','川崎F'], ['p2','守護神','GK','浦和'],
   ['p3','控え','MF','鹿島'], ['p4','無所属','DF','横浜FM']]
    .forEach(([player_id, name, position, real_club]) => {
      e.__addRow('Players', { player_id, name, position, real_club, eligible: true });
    });

  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's1', team_id: 't_a', player_id: 'p1', status: '在籍', acquisition_type: '完全移籍', acquired_cost: 100000000 });
  e.__addRow('Rosters', { roster_id: 'r2', season_id: 's1', team_id: 't_a', player_id: 'p2', status: '在籍', acquisition_type: 'オークション', acquired_cost: 50000000 });
  e.__addRow('Rosters', { roster_id: 'r3', season_id: 's1', team_id: 't_a', player_id: 'p3', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });

  return e;
}

const balance = (e, teamId) => {
  let sum = 0;
  e.__rows('BudgetTx').slice(1).forEach((r) => {
    if (r[2] === teamId) sum += Number(r[3]) || 0;
  });
  return sum;
};

const eligibleOf = (e, pid) =>
  e.__rows('Players').slice(1).find((r) => r[0] === pid)[4];

const claimsOf = (e) => e.__rows('Claims').slice(1);

module.exports = { env, balance, eligibleOf, claimsOf };
