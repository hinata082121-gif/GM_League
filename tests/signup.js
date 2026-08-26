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
  Config: ['key','value','note'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','expires_at'],
  Goals: ['goal_id','match_id','team_id','scorer_id','assist_id','minute'],
  TeamMatchStats: ['id','match_id','team_id','shots','shots_on_target'],
  GkStats: ['id','match_id','team_id','gk_player_id','saves'],
};

const CONFIG = {
  signup_code: 'ぐんまー2026',
  signup_open: true,
  signup_club_categories: 'J1,J2',
  two_division_min_teams: 15,
  win_points: 3, draw_points: 1,
};

function env(configOverride) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, configOverride || {}));
  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['NEW'] = 'newbie@example.com';
  e.__tokens['NEW2'] = 'second@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Seasons', { season_id: 's1', name: '2026シーズン', status: '準備中' });

  [['J1','鹿島アントラーズ',1], ['J1','浦和レッズ',2], ['J1','川崎フロンターレ',3],
   ['J2','ジェフユナイテッド千葉',4], ['J3','FC岐阜',5]]
    .forEach(([category, club_name, sort_order]) => {
      e.__addRow('Clubs', { category, club_name, sort_order });
    });

  return e;
}

// ---- 合言葉 ----------------------------------------------------------------

t('合言葉が合えば通る', () => {
  const e = env();
  eq(e.verifySignupCode({ code: 'ぐんまー2026' }).ok, true);
});

t('合言葉が違えば弾く', () => {
  const e = env();
  const r = e.verifySignupCode({ code: 'ちがう' });
  eq(r.ok, false);
  ok(r.error.includes('合言葉が違います'));
});

t('空白と大文字小文字は無視する', () => {
  const e = env({ signup_code: 'GM League 2026' });
  eq(e.verifySignupCode({ code: 'gmleague2026' }).ok, true);
  eq(e.verifySignupCode({ code: '  GM　LEAGUE　2026 ' }).ok, true);
});

t('受付を閉じていれば正しい合言葉でも拒否', () => {
  const e = env({ signup_open: false });
  const r = e.verifySignupCode({ code: 'ぐんまー2026' });
  eq(r.ok, false);
  ok(r.error.includes('受け付けていません'));
});

t('合言葉が未設定なら受付は閉じている', () => {
  const e = env({ signup_code: '' });
  eq(e.getSignupInfo().data.open, false);
});

t('getSignupInfo は合言葉そのものを返さない', () => {
  const e = env();
  const json = JSON.stringify(e.getSignupInfo());
  ok(!json.includes('ぐんまー'), '合言葉が漏れている: ' + json);
});

// ---- X ID の正規化 ---------------------------------------------------------

t('X ID: @ を落とす', () => {
  const e = env();
  eq(e.normalizeXId('@gm_league'), 'gm_league');
});

t('X ID: URL から取り出す', () => {
  const e = env();
  eq(e.normalizeXId('https://x.com/gm_league'), 'gm_league');
  eq(e.normalizeXId('https://twitter.com/gm_league?s=20'), 'gm_league');
  eq(e.normalizeXId('www.x.com/gm_league/'), 'gm_league');
});

t('X ID: 不正な文字は空にする', () => {
  const e = env();
  eq(e.normalizeXId('gm league'), '');
  eq(e.normalizeXId('日本語'), '');
  eq(e.normalizeXId('a'.repeat(16)), '');
});

t('X ID: 15文字ちょうどは通る', () => {
  const e = env();
  eq(e.normalizeXId('a'.repeat(15)), 'a'.repeat(15));
});

t('X ID: 空文字は空文字', () => {
  const e = env();
  eq(e.normalizeXId(''), '');
  eq(e.normalizeXId(undefined), '');
});

// ---- 申請 ------------------------------------------------------------------

function submit(e, token, over) {
  return e.submitSignup(token, Object.assign({
    code: 'ぐんまー2026', display_name: '新人', team_name: '浦和レッズ', x_id: '@newbie',
  }, over || {}));
}

t('申請が Signups に積まれる', () => {
  const e = env();
  const r = submit(e, 'NEW');
  eq(r.ok, true);
  eq(r.data.status, '申請中');
  eq(e.__rows('Signups').length, 2);
});

t('申請では Users も Teams も増えない', () => {
  const e = env();
  submit(e, 'NEW');
  eq(e.__rows('Users').length, 2);  // ヘッダー + 主催者
  eq(e.__rows('Teams').length, 1);  // ヘッダーのみ
});

t('申請は email をトークンから取る（payload の email は無視）', () => {
  const e = env();
  submit(e, 'NEW', { email: 'attacker@example.com' });
  const row = e.__rows('Signups')[1];
  eq(row[1], 'newbie@example.com');
});

t('合言葉なしの申請は通らない', () => {
  const e = env();
  const r = submit(e, 'NEW', { code: 'にせもの' });
  eq(r.ok, false);
  eq(e.__rows('Signups').length, 1);
});

t('未ログインの申請は invalid_token', () => {
  const e = env();
  const r = submit(e, 'UNKNOWN');
  eq(r.ok, false);
  eq(r.error, 'invalid_token');
});

t('表示名とチームは必須', () => {
  const e = env();
  eq(submit(e, 'NEW', { display_name: '' }).ok, false);
  eq(submit(e, 'NEW', { team_name: '  ' }).ok, false);
});

t('X ID が不正なら申請を弾く', () => {
  const e = env();
  const r = submit(e, 'NEW', { x_id: '日本語ID' });
  eq(r.ok, false);
  ok(r.error.includes('X の ID'));
});

t('X ID は省略できる', () => {
  const e = env();
  eq(submit(e, 'NEW', { x_id: '' }).ok, true);
});

t('登録済みユーザーは申請できない', () => {
  const e = env();
  e.__tokens['MEMBER'] = 'member@example.com';
  e.__addRow('Users', { user_id: 'u_m', email: 'member@example.com', display_name: '既存', role: 'team', team_id: 't1' });
  const r = submit(e, 'MEMBER');
  eq(r.ok, false);
  ok(r.error.includes('既に登録済み'));
});

t('申請中の再提出は上書きになる（行は増えない）', () => {
  const e = env();
  submit(e, 'NEW');
  const r = submit(e, 'NEW', { team_name: '鹿島アントラーズ' });
  eq(r.ok, true);
  eq(r.data.updated, true);
  eq(e.__rows('Signups').length, 2);
  eq(e.__rows('Signups')[1][3], '鹿島アントラーズ');
});

// ---- 承認 ------------------------------------------------------------------

t('承認で Users と Teams が作られる', () => {
  const e = env();
  const s = submit(e, 'NEW');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(r.ok, true);

  const users = e.__rows('Users');
  const teams = e.__rows('Teams');
  eq(users.length, 3);
  eq(teams.length, 2);

  const u = users[2];
  eq(u[1], 'newbie@example.com');
  eq(u[3], 'team');
  eq(u[4], r.data.team_id);
  eq(u[5], 'newbie');           // x_id が引き継がれる

  const tm = teams[1];
  eq(tm[1], '浦和レッズ');
  eq(tm[2], r.data.user_id);    // owner_user_id
  eq(tm[4], true);              // active
});

t('承認後はそのアカウントでログインできる', () => {
  const e = env();
  const s = submit(e, 'NEW');
  eq(e.whoami('NEW').ok, false);            // 承認前は入れない
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  const who = e.whoami('NEW');
  eq(who.ok, true);
  eq(who.data.role, 'team');
  eq(who.data.x_id, 'newbie');
});

t('承認は主催者だけ', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.__tokens['TEAM'] = 'team@example.com';
  e.__addRow('Users', { user_id: 'u_t', email: 'team@example.com', display_name: 'T', role: 'team', team_id: 't1' });
  const r = e.approveSignup('TEAM', { signup_id: s.data.signup_id });
  eq(r.ok, false);
});

t('二重承認は拒否される', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(r.ok, false);
  ok(r.error.includes('既に'));
  eq(e.__rows('Teams').length, 2);
});

t('申請後にクラブが埋まった場合は承認できない', () => {
  const e = env();
  const s = submit(e, 'NEW');
  // 申請と承認の間に、主催者が同じクラブを別途登録してしまったケース
  e.__addRow('Teams', { team_id: 't_x', name: '浦和レッズ', owner_user_id: 'u_x', kind: '新規', active: true });
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(r.ok, false);
  ok(r.error.includes('登録済み'), r.error);
  eq(e.__rows('Users').length, 2);
});

t('登録済みクラブでは申請の段階で弾かれる', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't_x', name: '浦和レッズ', owner_user_id: 'u_x', kind: '新規', active: true });
  const r = submit(e, 'NEW');
  eq(r.ok, false);
  ok(r.error.includes('登録済み'), r.error);
});

t('承認時にクラブを差し替えられる', () => {
  const e = env();
  const s = submit(e, 'NEW');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, team_name: '川崎フロンターレ' });
  eq(r.ok, true);
  eq(r.data.team_name, '川崎フロンターレ');
  eq(e.__rows('Teams')[1][1], '川崎フロンターレ');
});

t('却下すると Users は作られない', () => {
  const e = env();
  const s = submit(e, 'NEW');
  const r = e.rejectSignup('ORG', { signup_id: s.data.signup_id, note: '定員のため' });
  eq(r.ok, true);
  eq(e.__rows('Users').length, 2);
  eq(e.whoami('NEW').ok, false);
});

t('却下された人は再申請できる', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.rejectSignup('ORG', { signup_id: s.data.signup_id });
  const again = submit(e, 'NEW', { team_name: 'ジェフユナイテッド千葉' });
  eq(again.ok, true);
  eq(e.__rows('Signups').length, 2);
  eq(e.__rows('Signups')[1][6], '申請中');
});

t('却下した申請は承認できない', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.rejectSignup('ORG', { signup_id: s.data.signup_id });
  // 再申請していない状態に戻して確認
  e.__rows('Signups')[1][6] = '却下';
  eq(e.approveSignup('ORG', { signup_id: s.data.signup_id }).ok, false);
});

t('自分の申請状況を確認できる', () => {
  const e = env();
  submit(e, 'NEW');
  const r = e.getMySignup('NEW');
  eq(r.ok, true);
  eq(r.data.status, '申請中');
  eq(r.data.team_name, '浦和レッズ');
});

t('未申請なら status は空', () => {
  const e = env();
  const r = e.getMySignup('NEW');
  eq(r.data.registered, false);
  eq(r.data.status, '');
});

t('申請一覧は主催者のみ・申請中が先頭', () => {
  const e = env();
  submit(e, 'NEW');
  const s2 = submit(e, 'NEW2', { display_name: '二人目', team_name: '鹿島アントラーズ' });
  e.approveSignup('ORG', { signup_id: s2.data.signup_id });

  eq(e.listSignups('NEW', {}).ok, false);
  const r = e.listSignups('ORG', {});
  eq(r.ok, true);
  eq(r.data.length, 2);
  eq(r.data[0].status, '申請中');
});

t('申請一覧は status で絞れる', () => {
  const e = env();
  submit(e, 'NEW');
  const s2 = submit(e, 'NEW2', { team_name: '鹿島アントラーズ' });
  e.approveSignup('ORG', { signup_id: s2.data.signup_id });
  eq(e.listSignups('ORG', { status: '申請中' }).data.length, 1);
});

// ---- 自己プロフィール ------------------------------------------------------

t('本人が自分の X ID を更新できる', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  const r = e.updateMyProfile('NEW', { x_id: 'https://x.com/renamed' });
  eq(r.ok, true);
  eq(r.data.x_id, 'renamed');
  eq(e.whoami('NEW').data.x_id, 'renamed');
});

t('プロフィール更新では role を変えられない', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  e.updateMyProfile('NEW', { role: 'organizer', team_id: 't_org', x_id: 'x1' });
  const who = e.whoami('NEW');
  eq(who.data.role, 'team');
});

t('X ID を空にして消せる', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  const r = e.updateMyProfile('NEW', { x_id: '' });
  eq(r.ok, true);
  eq(e.whoami('NEW').data.x_id, '');
});

t('不正な X ID は更新を拒否', () => {
  const e = env();
  const s = submit(e, 'NEW');
  e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(e.updateMyProfile('NEW', { x_id: 'とんでもID' }).ok, false);
});

t('未登録ユーザーはプロフィールを更新できない', () => {
  const e = env();
  eq(e.updateMyProfile('NEW', { x_id: 'abc' }).ok, false);
});

report('signup.js');
