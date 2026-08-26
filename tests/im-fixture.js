const { createEnv } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Players: ['player_id','name','position','detail_position','real_club','eligible'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Config: ['key','value','note'],
};

const CONFIG = { squad_min: 22, squad_max: 35 };

function env() {
  const e = createEnv(SHEETS, CONFIG);

  e.__tokens['ORG'] = 'org@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });

  ['A', 'B'].forEach((k) => {
    const email = k.toLowerCase() + '@example.com';
    e.__tokens[k] = email;
    e.__addRow('Users', { user_id: 'u_' + k, email, display_name: 'GM' + k, role: 'team', team_id: 't_' + k });
    e.__addRow('Teams', { team_id: 't_' + k, name: 'チーム' + k, owner_user_id: 'u_' + k, kind: '継続', active: true });
  });

  e.__addRow('Seasons', { season_id: 's1', name: 'Season13', status: '終了' });
  e.__addRow('Seasons', { season_id: 's2', name: 'Season14', status: '準備中' });

  return e;
}

/** n人ぶんのダミー名簿 */
function squad(n, prefix) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ name: (prefix || '選手') + i, position: 'MF', real_club: 'ガンバ大阪' });
  }
  return out;
}

const rosters = (e) => e.__rows('Rosters').slice(1);
const players = (e) => e.__rows('Players').slice(1);

module.exports = { env, squad, rosters, players };
