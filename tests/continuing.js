const { createEnv, t, eq, ok, report } = require('./harness');

// 継続参加のチームは主催者が先に作ってスカッドと予算を入れてある。
// 参加者が申請したら、新しくチームを作らずそこへ結び付ける。

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
  Clubs: ['category','club_name','sort_order'],
  Players: ['player_id','name','position','detail_position','age','nationality','real_club','eligible'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Config: ['key','value','note'],
};

const CONFIG = {
  signup_code: 'ぐんまー2026',
  signup_open: true,
  signup_club_categories: 'J1,J2',
  squad_min: 22, squad_max: 35,
};

function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));

  e.__tokens['ORG'] = 'org@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Seasons', { season_id: 's1', name: 'Season15', status: '準備中' });

  // 鹿島は既にオーナーがいる（普通に登録済みのチーム）
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'GM先輩', role: 'team', team_id: 't_a' });
  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', owner_user_id: 'u_a', kind: '継続', active: true });

  e.__addRow('Players', { player_id: 'p1', name: '選手1', position: 'MF', detail_position: 'CMF', eligible: true });

  [['J1','鹿島アントラーズ',1], ['J1','浦和レッズ',2], ['J1','川崎フロンターレ',3],
   ['J2','ジェフユナイテッド千葉',4]]
    .forEach(([category, club_name, sort_order]) => e.__addRow('Clubs', { category, club_name, sort_order }));

  return e;
}

/** 主催者が先に作った、オーナー未定のチーム */
function preRegistered(e, name) {
  e.__addRow('Teams', { team_id: 't_pre', name, owner_user_id: '', kind: '継続', active: true });
  e.__addRow('Rosters', { roster_id: 'r_pre', season_id: 's1', team_id: 't_pre', player_id: 'p1', status: '在籍', acquisition_type: '初期', acquired_cost: 0 });
  e.__addRow('BudgetTx', { tx_id: 'b_pre', season_id: 's1', team_id: 't_pre', amount: 50000000, reason: '前シーズンからの繰越' });
}

function apply(e, token, email, name, club) {
  e.__tokens[token] = email;
  return e.submitSignup(token, {
    code: 'ぐんまー2026', display_name: name, team_name: club, x_id: '',
  });
}

const clubOf = (e, club, token) => {
  const d = e.getSignupClubs(token || 'ORG', {}).data;
  let hit = null;
  d.categories.forEach((c) => d.clubs[c].forEach((x) => { if (x.club_name === club) hit = x; }));
  return hit;
};

// =============================================================================
// 選択肢
// =============================================================================

t('オーナーのいないチームは選べる', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');

  const c = clubOf(e, '川崎フロンターレ');
  eq(c.taken, false, '塞がれていないこと');
  eq(c.continuing, true, '継続チームの印が付くこと');
});

t('オーナーのいるチームは塞がれる', () => {
  const e = env();
  const c = clubOf(e, '鹿島アントラーズ');
  eq(c.taken, true);
  eq(c.taken_reason, '登録済み');
  eq(c.continuing, false);
});

t('オーナーの値が入っていれば塞ぐ', () => {
  // 参照先が実在するかまでは見ない。値が入っている時点で
  // 誰かのものにする意図があったとみなすほうが、取り違えより安全
  const e = env();
  e.__addRow('Teams', { team_id: 't_ghost', name: '川崎フロンターレ', owner_user_id: 'u_消えた', kind: '継続', active: true });

  eq(clubOf(e, '川崎フロンターレ').taken, true);
});

t('他の人が申請中なら塞がれる', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');
  apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');

  e.__tokens['Y'] = 'y@example.com';
  const c = clubOf(e, '川崎フロンターレ', 'Y');
  eq(c.taken, true);
  eq(c.taken_reason, '申請中');
});

t('チームが1つも無いクラブも選べる', () => {
  const e = env();
  const c = clubOf(e, '浦和レッズ');
  eq(c.taken, false);
  eq(c.continuing, false, '継続の印は付かないこと');
});

// =============================================================================
// 承認
// =============================================================================

t('承認すると既存チームに結び付く', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');

  const s = apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');
  eq(s.ok, true, s.error);

  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(r.ok, true, r.error);
  eq(r.data.team_id, 't_pre', '新しいチームを作っていないこと');
  eq(r.data.continuing, true);
});

t('引き継いだチームはスカッドと予算を保つ', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');
  const s = apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });

  eq(e.getTeamSquad('ORG', { team_id: 't_pre', season_id: 's1' }).data.total, 1);
  eq(e.getTeamBudget('ORG', { team_id: 't_pre', season_id: 's1' }).data.balance, 50000000);
});

t('承認するとオーナーと種別が入る', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');
  const s = apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });

  const team = e.listTeams('ORG', {}).data.filter((x) => x.team_id === 't_pre')[0];
  eq(team.owner_user_id, r.data.user_id);
  eq(team.kind, '継続');
  eq(team.owner_name, 'GM太郎');
});

t('承認された本人がそのチームで見られる', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');
  const s = apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });

  const me = e.getMyTeam('X', {});
  eq(me.ok, true);
  eq(me.data.team.team_id, 't_pre');
  eq(me.data.team.name, '川崎フロンターレ');
});

t('チームが無ければ従来どおり新しく作る', () => {
  const e = env();
  const s = apply(e, 'X', 'x@example.com', 'GM太郎', '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });

  eq(r.ok, true, r.error);
  eq(r.data.continuing, false);

  const team = e.listTeams('ORG', {}).data.filter((x) => x.team_id === r.data.team_id)[0];
  eq(team.kind, '新規');
});

t('一度引き継がれたチームは他の人が選べない', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');
  const s = apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });

  const c = clubOf(e, '川崎フロンターレ');
  eq(c.taken, true);
  eq(c.taken_reason, '登録済み');
});

t('引き継ぎ後は別の人が同じクラブで申請できない', () => {
  const e = env();
  preRegistered(e, '川崎フロンターレ');
  const s1 = apply(e, 'X', 'x@example.com', 'GM太郎', '川崎フロンターレ');
  e.approveSignup('ORG', { signup_id: s1.data.signup_id });

  eq(apply(e, 'Y', 'y@example.com', 'GM次郎', '川崎フロンターレ').ok, false);
});

t('オーナーのいるクラブは申請の時点で弾く', () => {
  const e = env();
  eq(apply(e, 'X', 'x@example.com', 'GM太郎', '鹿島アントラーズ').ok, false);
});

report('continuing.js');
