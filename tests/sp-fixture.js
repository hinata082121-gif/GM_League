const { createEnv } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Sponsors: ['sponsor_id','season_id','name','contract_fee','quota_type','quota_value','quota_type2','quota_value2','penalty','unlock_type','unlock_season_id','unlock_value','unlock_teams','unlock_note','note','active'],
  TeamSponsors: ['contract_id','season_id','team_id','sponsor_id','contract_fee','chosen_at','result','penalty_paid','settled_at'],
  Managers: ['manager_id','name','club','category','active'],
  ManagerPicks: ['pick_id','season_id','team_id','round','manager_id','status','created_at','decided_at'],
  ScheduleTemplate: ['sort_order','day_offset','label','note'],
  SeasonSchedule: ['schedule_id','season_id','date','label','note','sort_order','done'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  Clubs: ['category','club_name','sort_order'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  Players: ['player_id','name','position','detail_position','real_club','eligible'],
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
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
};

const CONFIG = {
  sponsor_open: true,
  season_end_fee_rate: 0,          // 手数料は0にして罰金の額だけを見る
  two_division_min_teams: 15, win_points: 3, draw_points: 1,
  squad_min: 22, squad_max: 35,
  claim_default_choice: '払い戻し',
  manager_round: 0,
};

function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));

  e.__tokens['ORG'] = 'org@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });

  ['A', 'B', 'C', 'D'].forEach((k) => {
    const email = k.toLowerCase() + '@example.com';
    e.__tokens[k] = email;
    e.__addRow('Users', { user_id: 'u_' + k, email, display_name: 'GM' + k, role: 'team', team_id: 't_' + k });
    e.__addRow('Teams', { team_id: 't_' + k, name: 'チーム' + k, owner_user_id: 'u_' + k, kind: '継続', active: true });
  });

  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: 'トーナメント' });
  e.__addRow('Seasons', { season_id: 's2', name: '2027シーズン', status: '準備中' });

  return e;
}

/** スポンサーを1件足して sponsor_id を返す */
function addSponsor(e, over) {
  const r = e.upsertSponsor('ORG', Object.assign({
    season_id: 's1', name: '大型スポンサー',
    contract_fee: 300000000, quota_type: 'リーグ順位', quota_value: '3',
    penalty: 200000000,
  }, over || {}));
  if (!r.ok) throw new Error(r.error);
  return r.data.sponsor_id;
}

const balance = (e, teamId) => {
  let sum = 0;
  e.__rows('BudgetTx').slice(1).forEach((r) => { if (r[2] === teamId) sum += Number(r[3]) || 0; });
  return sum;
};

const contracts = (e) => e.__rows('TeamSponsors').slice(1);

/** リーグ戦を仕込む（A>B>C>D の順になるようにする） */
function seedLeague(e) {
  const add = (home, away, hs, as, round) => {
    e.__addRow('Matches', {
      match_id: 'm' + Math.random().toString(36).slice(2, 8),
      season_id: 's1', stage: 'league', round, tie_id: '', leg: '',
      home_team: home, away_team: away, home_score: hs, away_score: as,
      home_pk: '', away_pk: '', status: '承認', reported_by: 'u_org',
      created_at: new Date(),
    });
  };
  // A: 3勝 / B: 2勝1敗 / C: 1勝2敗 / D: 3敗
  add('t_A', 't_B', 2, 0, '第1節');
  add('t_A', 't_C', 2, 0, '第2節');
  add('t_A', 't_D', 2, 0, '第3節');
  add('t_B', 't_C', 2, 0, '第4節');
  add('t_B', 't_D', 2, 0, '第5節');
  add('t_C', 't_D', 2, 0, '第6節');
}

/** リーグ杯を仕込む（準決勝2試合＋決勝1試合） */
function seedCup(e, finalWinnerHome) {
  const add = (tie, round, home, away, hs, as) => {
    e.__addRow('Matches', {
      match_id: 'c' + Math.random().toString(36).slice(2, 8),
      season_id: 's1', stage: 'tournament', round, tie_id: tie, leg: '',
      home_team: home, away_team: away, home_score: hs, away_score: as,
      home_pk: '', away_pk: '', status: '承認', reported_by: 'u_org',
      created_at: new Date(),
    });
  };
  add('sf1', '準決勝', 't_A', 't_C', 1, 0);   // A が勝ち上がり
  add('sf2', '準決勝', 't_B', 't_D', 1, 0);   // B が勝ち上がり
  add('f1', '決勝', 't_A', 't_B', finalWinnerHome ? 1 : 0, finalWinnerHome ? 0 : 1);
}

module.exports = { env, addSponsor, balance, contracts, seedLeague, seedCup };
