const { createEnv } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
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

const CONFIG = {
  claim_rate_real_transfer: 0.8,
  claim_rate_withdrawal: 0.9,
  claim_default_choice: '払い戻し',
  new_team_initial_budget: 0,
  signup_club_categories: 'J1,J2',
  season_end_fee_rate: 0.10,
  squad_min: 22, squad_max: 35, new_team_entry_count: 3,
  two_division_min_teams: 15, win_points: 3, draw_points: 1,
};

// A=鹿島 / B=浦和 の2チーム。各クラブに実在選手を4人ずつ置く
function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));
  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['A'] = 'a@example.com';
  e.__tokens['B'] = 'b@example.com';

  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'オーナーA', role: 'team', team_id: 't_a' });
  e.__addRow('Users', { user_id: 'u_b', email: 'b@example.com', display_name: 'オーナーB', role: 'team', team_id: 't_b' });

  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', owner_user_id: 'u_a', kind: '継続', active: true });
  e.__addRow('Teams', { team_id: 't_b', name: '浦和レッズ', owner_user_id: 'u_b', kind: '継続', active: true });

  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: 'トーナメント' });
  e.__addRow('Seasons', { season_id: 's2', name: '2027シーズン', status: '準備中' });

  [['J1','鹿島アントラーズ',1], ['J1','浦和レッズ',2], ['J1','川崎フロンターレ',3], ['J2','V・ファーレン長崎',4]]
    .forEach(([category, club_name, sort_order]) => e.__addRow('Clubs', { category, club_name, sort_order }));

  // 鹿島の選手 k1..k4 / 浦和の選手 u1..u4
  ['k1','k2','k3','k4'].forEach((id, i) =>
    e.__addRow('Players', { player_id: id, name: '鹿島' + (i + 1), position: 'MF', real_club: '鹿島アントラーズ', eligible: true }));
  ['u1','u2','u3','u4'].forEach((id, i) =>
    e.__addRow('Players', { player_id: id, name: '浦和' + (i + 1), position: 'FW', real_club: '浦和レッズ', eligible: true }));

  // A は自クラブ k1,k2 と、B から買った u1（1億）を保有
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's1', team_id: 't_a', player_id: 'k1', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });
  e.__addRow('Rosters', { roster_id: 'r2', season_id: 's1', team_id: 't_a', player_id: 'k2', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });
  e.__addRow('Rosters', { roster_id: 'r3', season_id: 's1', team_id: 't_a', player_id: 'u1', status: '在籍', acquisition_type: '完全移籍', acquired_cost: 100000000 });

  // B は自クラブ u2,u3 を保有
  e.__addRow('Rosters', { roster_id: 'r4', season_id: 's1', team_id: 't_b', player_id: 'u2', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });
  e.__addRow('Rosters', { roster_id: 'r5', season_id: 's1', team_id: 't_b', player_id: 'u3', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });

  return e;
}

const balance = (e, teamId) => {
  let sum = 0;
  e.__rows('BudgetTx').slice(1).forEach((r) => { if (r[2] === teamId) sum += Number(r[3]) || 0; });
  return sum;
};

const claimsOf = (e) => e.__rows('Claims').slice(1);

const rostersOf = (e, seasonId, teamId) =>
  e.__rows('Rosters').slice(1).filter((r) => r[1] === seasonId && r[2] === teamId && r[4] === '在籍');

const setDeadline = (e, iso) => { e.__rows('Seasons')[1][6] = iso; };

module.exports = { env, balance, claimsOf, rostersOf, setDeadline };
