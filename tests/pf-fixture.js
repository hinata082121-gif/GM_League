const { createEnv } = require('./harness');

// 年齢・国籍つきの Players を持つ環境。
// 他のフィクスチャは古いヘッダーのままにしてあり、
// 「カラムが無いシートでも壊れない」ことはそちらで確かめている。
const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Players: ['player_id','name','position','detail_position','age','nationality','real_club','eligible'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  Protections: ['protection_id','season_id','window','team_id','player_id','tier','fee','set_at'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Clubs: ['category','club_name','sort_order'],
  Config: ['key','value','note'],
};

const CONFIG = {
  squad_min: 22, squad_max: 35,
  claim_rate_real_transfer: 0.8,
  claim_rate_withdrawal: 0.9,
  claim_default_choice: '払い戻し',
};

function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));

  e.__tokens['ORG'] = 'org@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });

  e.__tokens['A'] = 'a@example.com';
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'GM太郎', role: 'team', team_id: 't_a' });
  e.__addRow('Teams', { team_id: 't_a', name: 'ガンバ大阪', owner_user_id: 'u_a', kind: '継続', active: true });

  e.__addRow('Seasons', { season_id: 's1', name: 'Season14', status: '終了' });
  e.__addRow('Seasons', { season_id: 's2', name: 'Season15', status: '準備中' });

  return e;
}

const players = (e) => e.__rows('Players').slice(1);

module.exports = { env, players };
