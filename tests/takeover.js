const { createEnv, t, eq, ok, report } = require('./harness');

// 既にあるチームを新しい参加者が引き受けるとき。
//
//   過去の記録用チーム — 引き継げるものが無いので新規参加と同じ（初期予算が入る）
//   GM交代            — オーナーだけ外して後任を待つ。承認時に引継ぎ／新規を選ぶ
//   辞退したクラブ    — 前任のオーナーが残っていても選べる
//
// 以前は「同じ名前のチームがあれば継続」と決め打ちしていて、過去シーズンの
// 記録用に作ったチーム（川崎フロンターレなど）を選ぶと0円から始まってしまった。

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  Clubs: ['category','club_name','sort_order'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  Players: ['player_id','name','position','detail_position','age','nationality','real_club','eligible'],
  SeasonTeams: ['season_id','team_id','division','owner_memo'],
  EntryLists: ['entry_id','season_id','team_id','status','submitted_at'],
  Protections: ['protection_id','season_id','team_id','player_id','window','slot','fee'],
  Config: ['key','value','note'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
};

const CONFIG = {
  signup_code: 'ぐんまー2026',
  signup_open: true,
  signup_club_categories: 'J1,J2',
  squad_min: 22, squad_max: 35,
};

const INITIAL = 50000000;

function env() {
  const e = createEnv(SHEETS, CONFIG);

  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['OLD'] = 'old@example.com';
  e.__tokens['X'] = 'x@example.com';

  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Seasons', { season_id: 's14', name: 'Season14', status: '終了' });
  e.__addRow('Seasons', { season_id: 's15', name: 'Season15', status: '準備中' });

  ['p1', 'p2'].forEach((id) =>
    e.__addRow('Players', { player_id: id, name: id, position: 'MF', real_club: '浦和レッズ', eligible: true }));

  [['J1','鹿島アントラーズ',1], ['J1','浦和レッズ',2], ['J1','川崎フロンターレ',3], ['J2','横浜FC',4]]
    .forEach(([category, club_name, sort_order]) => e.__addRow('Clubs', { category, club_name, sort_order }));

  return e;
}

/** 前任のGMがいて、今シーズンにスカッドと予算を持っているチーム */
function owned(e, active) {
  e.__addRow('Users', { user_id: 'u_old', email: 'old@example.com', display_name: 'GM先代', role: 'team', team_id: 't_u' });
  e.__addRow('Teams', { team_id: 't_u', name: '浦和レッズ', owner_user_id: 'u_old', kind: '継続', active: active !== false });
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's15', team_id: 't_u', player_id: 'p1', status: '在籍', acquisition_type: '初期', acquired_cost: 0 });
  e.__addRow('Rosters', { roster_id: 'r2', season_id: 's15', team_id: 't_u', player_id: 'p2', status: '在籍', acquisition_type: '完全移籍', acquired_cost: 30000000 });
  e.__addRow('BudgetTx', { tx_id: 'b1', season_id: 's15', team_id: 't_u', amount: 200000000, reason: '前シーズンからの繰越' });
}

const apply = (e, club) =>
  e.submitSignup('X', { code: 'ぐんまー2026', display_name: 'GM太郎', team_name: club, x_id: '' });

const clubOf = (e, club) => {
  const d = e.getSignupClubs('ORG', {}).data;
  let hit = null;
  d.categories.forEach((c) => d.clubs[c].forEach((x) => { if (x.club_name === club) hit = x; }));
  return hit;
};

const teamOf = (e, id) => e.listTeams('ORG', {}).data.filter((x) => x.team_id === id)[0];
const balance = (e, id) => e.getTeamBudget('ORG', { team_id: id, season_id: 's15' }).data.balance;
const squad = (e, id) => e.getTeamSquad('ORG', { team_id: id, season_id: 's15' }).data.total;

// =============================================================================
// 過去シーズンの記録のためだけにあるチーム
// =============================================================================

t('記録用のチームは選べるが、継続の印は付かない', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't_k', name: '川崎フロンターレ', owner_user_id: '', kind: '継続', active: false });
  e.__addRow('SeasonTeams', { season_id: 's14', team_id: 't_k', division: 'GM1', owner_memo: 'GM先代' });

  const c = clubOf(e, '川崎フロンターレ');
  eq(c.taken, false);
  eq(c.continuing, false);
});

t('記録用のチームを選んだ新規参加者にも初期予算が入る', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't_k', name: '川崎フロンターレ', owner_user_id: '', kind: '継続', active: false });

  const s = apply(e, '川崎フロンターレ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });

  eq(r.ok, true, r.error);
  eq(r.data.team_id, 't_k', '同じ名前のチームを2つ作らない');
  eq(r.data.continuing, false);
  eq(r.data.start_mode, '新規');
  eq(r.data.initial_budget, { season_id: 's15', amount: INITIAL });
  eq(balance(e, 't_k'), INITIAL);

  const team = teamOf(e, 't_k');
  eq(team.kind, '新規');
  eq(team.active, true);
});

t('引き継げるものが無いチームは、引継ぎを指定しても初期予算が入る', () => {
  const e = env();
  e.__addRow('Teams', { team_id: 't_k', name: '川崎フロンターレ', owner_user_id: '', kind: '継続', active: false });

  const s = apply(e, '川崎フロンターレ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, start_mode: '引継ぎ' });

  eq(r.data.start_mode, '新規');
  eq(balance(e, 't_k'), INITIAL);
});

// =============================================================================
// GM交代
// =============================================================================

t('参加中でオーナーのいるチームは選べない', () => {
  const e = env();
  owned(e);
  eq(clubOf(e, '浦和レッズ').taken, true);
});

t('GM交代でオーナーが外れ、後任が選べるようになる', () => {
  const e = env();
  owned(e);

  const r = e.releaseTeamOwner('ORG', { team_id: 't_u' });
  eq(r.ok, true, r.error);
  eq(r.data.unlinked_users, 1);

  const c = clubOf(e, '浦和レッズ');
  eq(c.taken, false);
  eq(c.continuing, true, 'スカッドと予算が残っているので継続の印が付く');
});

t('GM交代ではスカッドも予算も動かさず、チームは参加中のまま', () => {
  const e = env();
  owned(e);
  e.releaseTeamOwner('ORG', { team_id: 't_u' });

  eq(squad(e, 't_u'), 2);
  eq(balance(e, 't_u'), 200000000);
  eq(teamOf(e, 't_u').active, true);
  eq(teamOf(e, 't_u').owner_user_id, '');
});

t('GM交代のあと、前任はそのチームを操作できない', () => {
  const e = env();
  owned(e);
  eq(e.getMyTeam('OLD', {}).data.team.team_id, 't_u');

  e.releaseTeamOwner('ORG', { team_id: 't_u' });
  eq(e.getMyTeam('OLD', {}).data.team, null);
});

t('GM交代は主催者だけ', () => {
  const e = env();
  owned(e);
  eq(e.releaseTeamOwner('OLD', { team_id: 't_u' }).ok, false);
  eq(teamOf(e, 't_u').owner_user_id, 'u_old');
});

t('大会から外れているチームは GM交代にできない', () => {
  const e = env();
  owned(e, false);
  eq(e.releaseTeamOwner('ORG', { team_id: 't_u' }).ok, false);
});

// =============================================================================
// 承認時の始め方
// =============================================================================

t('引継ぎ：スカッドと予算をそのまま受け取る', () => {
  const e = env();
  owned(e);
  e.releaseTeamOwner('ORG', { team_id: 't_u' });

  const s = apply(e, '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, start_mode: '引継ぎ' });

  eq(r.ok, true, r.error);
  eq(r.data.continuing, true);
  eq(r.data.initial_budget, null);
  eq(squad(e, 't_u'), 2);
  eq(balance(e, 't_u'), 200000000);
  eq(teamOf(e, 't_u').kind, '継続');
  eq(e.getMyTeam('X', {}).data.team.team_id, 't_u');
});

t('何も指定しなければ引継ぎ（継続参加の従来どおり）', () => {
  const e = env();
  owned(e);
  e.releaseTeamOwner('ORG', { team_id: 't_u' });

  const s = apply(e, '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });
  eq(r.data.start_mode, '引継ぎ');
  eq(squad(e, 't_u'), 2);
});

t('新規：スカッドを解散し、予算を初期値にそろえる', () => {
  const e = env();
  owned(e);
  e.releaseTeamOwner('ORG', { team_id: 't_u' });

  const s = apply(e, '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, start_mode: '新規' });

  eq(r.ok, true, r.error);
  eq(r.data.continuing, false);
  eq(r.data.released, 2);
  eq(r.data.reset.budget_before, 200000000);
  eq(r.data.reset.budget_after, INITIAL);
  eq(squad(e, 't_u'), 0);
  eq(balance(e, 't_u'), INITIAL);
  eq(teamOf(e, 't_u').kind, '新規');

  // 履歴は消さず、差額の取引を1行足す
  const tx = e.__rows('BudgetTx').slice(1).filter((x) => x[2] === 't_u');
  eq(tx.length, 2);
  eq(tx[1][3], INITIAL - 200000000);
  eq(tx[1][4], '新規参加リセット');
});

t('新規で始めると、前任のプロテクトとエントリーも残らない', () => {
  const e = env();
  owned(e);
  e.__addRow('Protections', { protection_id: 'pr1', season_id: 's15', team_id: 't_u', player_id: 'p1', window: 1, slot: 1, fee: 0 });
  e.__addRow('EntryLists', { entry_id: 'en1', season_id: 's15', team_id: 't_u', status: '承認' });
  e.releaseTeamOwner('ORG', { team_id: 't_u' });

  const s = apply(e, '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, start_mode: '新規' });

  eq(r.data.reset.protections, 1);
  eq(r.data.reset.entries, 1);
});

t('知らない start_mode は弾く', () => {
  const e = env();
  owned(e);
  e.releaseTeamOwner('ORG', { team_id: 't_u' });
  const s = apply(e, '浦和レッズ');

  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id, start_mode: 'おまかせ' });
  eq(r.ok, false);
  eq(teamOf(e, 't_u').owner_user_id, '', '何も書き込まれていない');
});

// =============================================================================
// 辞退したクラブ
// =============================================================================

/** 前シーズンに辞退したチーム。オーナーは残り、予算は前シーズンに置かれたまま */
function withdrawn(e) {
  e.__addRow('Users', { user_id: 'u_old', email: 'old@example.com', display_name: 'GM先代', role: 'team', team_id: 't_u' });
  e.__addRow('Teams', { team_id: 't_u', name: '浦和レッズ', owner_user_id: 'u_old', kind: '継続', active: false });
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's14', team_id: 't_u', player_id: 'p1', status: '離脱', acquisition_type: '初期', acquired_cost: 0 });
  e.__addRow('BudgetTx', { tx_id: 'b1', season_id: 's14', team_id: 't_u', amount: 200000000, reason: '順位賞金' });
}

t('辞退したクラブは、前任のオーナーが残っていても選べる', () => {
  const e = env();
  withdrawn(e);

  const c = clubOf(e, '浦和レッズ');
  eq(c.taken, false);
  eq(c.continuing, false, '今シーズンに引き継げるものは無い');
});

t('辞退したクラブに来た参加者は、初期予算ちょうどから始まる', () => {
  const e = env();
  withdrawn(e);

  const s = apply(e, '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });

  eq(r.ok, true, r.error);
  eq(r.data.team_id, 't_u');
  eq(r.data.start_mode, '新規');
  // 前シーズンに残った2億を差し引いてマイナスから始めさせない
  eq(balance(e, 't_u'), INITIAL);
  eq(teamOf(e, 't_u').active, true);
  eq(teamOf(e, 't_u').kind, '新規');
});

t('辞退したクラブを引き受けると、前任のログインが外れる', () => {
  const e = env();
  withdrawn(e);

  const s = apply(e, '浦和レッズ');
  const r = e.approveSignup('ORG', { signup_id: s.data.signup_id });

  eq(r.data.unlinked_users, 1);
  eq(e.getMyTeam('OLD', {}).data.team, null);
  eq(e.getMyTeam('X', {}).data.team.team_id, 't_u');
  eq(teamOf(e, 't_u').owner_user_id, r.data.user_id);
});

report('takeover.js');
