const { createEnv, t, eq, ok, report } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','created_at'],
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
  Clubs: ['category','club_name','sort_order'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  Players: ['player_id','name','position','real_club','eligible'],
  Matches: ['match_id','season_id','stage','round','tie_id','leg','home_team','away_team','home_score','away_score','home_pk','away_pk','status','reported_by','created_at'],
  SeasonTeams: ['season_id','team_id','division'],
  SuperCup: ['season_id','team_a','team_b','streamed','note'],
  Config: ['key','value','note'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','expires_at'],
  Goals: ['goal_id','match_id','team_id','scorer_id','assist_id','minute'],
  TeamMatchStats: ['id','match_id','team_id','shots','shots_on_target'],
  GkStats: ['id','match_id','team_id','gk_player_id','saves'],
};

const CONFIG = {
  signup_code: 'code', signup_open: true,
  signup_club_categories: 'J1,J2',
  two_division_min_teams: 15, win_points: 3, draw_points: 1,
};

const CLUBS = [
  ['J1','鹿島アントラーズ',1], ['J1','浦和レッズ',2], ['J1','川崎フロンターレ',3],
  ['J2','ジェフユナイテッド千葉',4], ['J2','V・ファーレン長崎',5],
  ['J3','FC岐阜',6], ['J3','カターレ富山',7],
];

function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));
  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['NEW'] = 'newbie@example.com';
  e.__tokens['NEW2'] = 'second@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: '準備中' });
  CLUBS.forEach(([category, club_name, sort_order]) => {
    e.__addRow('Clubs', { category, club_name, sort_order });
  });
  return e;
}

function submit(e, token, over) {
  return e.submitSignup(token, Object.assign({
    code: 'code', display_name: '新人', team_name: '浦和レッズ', x_id: '',
  }, over || {}));
}

// ---- 選択肢 ----------------------------------------------------------------

t('J1とJ2だけが選択肢に出る', () => {
  const e = env();
  const d = e.getSignupClubs('', {}).data;
  eq(d.categories, ['J1','J2']);
  eq(d.total, 5);
});

t('J3はデータに残るが選択肢には出ない', () => {
  const e = env();
  const d = e.getSignupClubs('', {}).data;
  ok(!d.clubs.J3, 'J3 が選択肢に出ている');
  // Clubs シートには残っている
  eq(e.__rows('Clubs').length, 8);  // ヘッダー + 7
  const all = e.listClubs('ORG');
  eq(all.data.categories, ['J1','J2','J3']);
});

t('Config で J3 を許可すれば出せる', () => {
  const e = env({ signup_club_categories: 'J1,J2,J3' });
  const d = e.getSignupClubs('', {}).data;
  eq(d.categories, ['J1','J2','J3']);
  eq(d.total, 7);
});

t('sort_order の順に並ぶ', () => {
  const e = env();
  const d = e.getSignupClubs('', {}).data;
  eq(d.clubs.J1.map((c) => c.club_name), ['鹿島アントラーズ','浦和レッズ','川崎フロンターレ']);
});

t('トークンなしでも選択肢を取れる', () => {
  const e = env();
  eq(e._route('getSignupClubs', '', {}).ok, true);
});

// ---- 使用済み判定 ----------------------------------------------------------

t('登録済みチームは taken になる', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't1', name: '浦和レッズ', owner_user_id: 'u1', kind: '新規', active: true });
  const d = e.getSignupClubs('', {}).data;
  const urawa = d.clubs.J1.find((c) => c.club_name === '浦和レッズ');
  eq(urawa.taken, true);
  eq(urawa.taken_reason, '登録済み');
  eq(d.available, 4);
});

t('他人が申請中のクラブも taken になる', () => {
  const e = env();
  submit(e, 'NEW');
  const d = e.getSignupClubs('NEW2', {}).data;
  const urawa = d.clubs.J1.find((c) => c.club_name === '浦和レッズ');
  eq(urawa.taken, true);
  eq(urawa.taken_reason, '申請中');
});

t('自分が申請中のクラブは自分には taken にならない', () => {
  const e = env();
  submit(e, 'NEW');
  const d = e.getSignupClubs('NEW', {}).data;
  const urawa = d.clubs.J1.find((c) => c.club_name === '浦和レッズ');
  eq(urawa.taken, false);
});

t('却下された申請はクラブを塞がない', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.rejectSignup('ORG', { signup_id: s.data.signup_id });
  const d = e.getSignupClubs('NEW2', {}).data;
  eq(d.clubs.J1.find((c) => c.club_name === '浦和レッズ').taken, false);
});

// ---- 申請時の検証 ----------------------------------------------------------

t('一覧にあるクラブなら申請できる', () => {
  const e = env();
  eq(submit(e, 'NEW', { team_name: 'ジェフユナイテッド千葉' }).ok, true);
});

t('自由記入のチーム名は拒否される', () => {
  const e = env();
  const r = submit(e, 'NEW', { team_name: 'あ' });
  eq(r.ok, false);
  ok(r.error.includes('一覧から選んで'), r.error);
});

t('J3のクラブは申請できない', () => {
  const e = env();
  const r = submit(e, 'NEW', { team_name: 'FC岐阜' });
  eq(r.ok, false);
  ok(r.error.includes('一覧から選んで'), r.error);
});

t('他人が申請中のクラブは申請できない', () => {
  const e = env();
  submit(e, 'NEW', { team_name: '鹿島アントラーズ' });
  const r = submit(e, 'NEW2', { team_name: '鹿島アントラーズ' });
  eq(r.ok, false);
  ok(r.error.includes('申請中'), r.error);
});

t('登録済みのクラブは申請できない', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't1', name: '川崎フロンターレ', owner_user_id: 'u1', kind: '新規', active: true });
  const r = submit(e, 'NEW', { team_name: '川崎フロンターレ' });
  eq(r.ok, false);
  ok(r.error.includes('登録済み'), r.error);
});

t('自分の申請を同じクラブで出し直せる', () => {
  const e = env();
  submit(e, 'NEW', { team_name: '浦和レッズ' });
  const r = submit(e, 'NEW', { team_name: '浦和レッズ', display_name: '改名' });
  eq(r.ok, true);
  eq(e.__rows('Signups').length, 2);
});

t('自分の申請を別のクラブに変えられる', () => {
  const e = env();
  submit(e, 'NEW', { team_name: '浦和レッズ' });
  const r = submit(e, 'NEW', { team_name: '鹿島アントラーズ' });
  eq(r.ok, true);
  eq(e.__rows('Signups')[1][3], '鹿島アントラーズ');
});

t('チーム未選択は拒否', () => {
  const e = env();
  const r = submit(e, 'NEW', { team_name: '' });
  eq(r.ok, false);
  ok(r.error.includes('選んで'), r.error);
});

// ---- 承認時の検証 ----------------------------------------------------------

t('承認するとクラブ名でチームが作られる', () => {
  const e = env();
  const s = submit(e, 'NEW', { team_name: 'V・ファーレン長崎' });
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(r.ok, true);
  eq(r.data.team_name, 'V・ファーレン長崎');
  eq(e.__rows('Teams')[1][1], 'V・ファーレン長崎');
});

t('主催者は別の空きクラブに差し替えられる', () => {
  const e = env();
  const s = submit(e, 'NEW', { team_name: '浦和レッズ' });
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, team_name: '鹿島アントラーズ' });
  eq(r.ok, true);
  eq(e.__rows('Teams')[1][1], '鹿島アントラーズ');
});

t('主催者でも一覧にない名前は付けられない', () => {
  const e = env();
  const s = submit(e, 'NEW', { team_name: '浦和レッズ' });
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, team_name: '主催者の好きな名前' });
  eq(r.ok, false);
  eq(e.__rows('Teams').length, 1);
});

t('主催者でも使用済みクラブには差し替えられない', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't1', name: '鹿島アントラーズ', owner_user_id: 'u1', kind: '新規', active: true });
  const s = submit(e, 'NEW', { team_name: '浦和レッズ' });
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, team_name: '鹿島アントラーズ' });
  eq(r.ok, false);
  ok(r.error.includes('登録済み'), r.error);
});

t('2人を別々のクラブで承認できる', () => {
  const e = env();
  const a = submit(e, 'NEW', { team_name: '浦和レッズ' });
  const b = submit(e, 'NEW2', { team_name: '鹿島アントラーズ' });
  eq(e.approveSignup('ORG', { signup_id: a.data.signup_id }).ok, true);
  eq(e.approveSignup('ORG', { signup_id: b.data.signup_id }).ok, true);
  eq(e.__rows('Teams').length, 3);
});

t('承認後そのクラブは選択肢から消える', () => {
  const e = env();
  const s = submit(e, 'NEW', { team_name: '浦和レッズ' });
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  const d = e.getSignupClubs('NEW2', {}).data;
  eq(d.clubs.J1.find((c) => c.club_name === '浦和レッズ').taken, true);
  eq(d.available, 4);
});

report('clubs.js');
