const { createEnv, t, eq, ok, report } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Managers: ['manager_id','name','club','category','active'],
  ManagerPicks: ['pick_id','season_id','team_id','round','manager_id','status','created_at','decided_at'],
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

const CONFIG = {
  manager_round: 0,
  free_protect_count: 2, paid_protect_count: 3,
  protect_free_start_before_days: 6,
  protect_free_before_days: 3, protect_paid_before_days: 1,
  protect_paid_start: '23:00', market_days: 3,
  two_division_min_teams: 15, win_points: 3, draw_points: 1,
};

/** 今日から days 日後の日時文字列 */
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(12, 0, 0, 0);
  return d;
}

function env(opts) {
  opts = opts || {};
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, opts.config || {}));

  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['A'] = 'a@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'GM太郎', role: 'team', team_id: 't_a' });
  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', owner_user_id: 'u_a', kind: '継続', active: true });

  e.__addRow('Seasons', {
    season_id: 's1', name: '2026シーズン',
    status: opts.status || '準備中',
    // 移籍市場の開幕は遠い未来にしておく（プロテクト期間に入らないように）
    window1_open_at: opts.w1 || daysFromNow(60),
    window2_open_at: opts.w2 || daysFromNow(120),
    claim_deadline_at: opts.deadline || '',
  });

  return e;
}

const tabs = (e, token) => e.getUiState(token || 'A', { season_id: 's1' }).data.tabs;

// ---- 主催者 ----------------------------------------------------------------

t('主催者にはすべて開いて見える', () => {
  const e = env();
  const d = e.getUiState('ORG', { season_id: 's1' }).data;
  eq(d.always_open, true);
  ['entry','transfer','protect','manager','claims'].forEach((k) => {
    eq(d.tabs[k].open, true, k);
  });
});

t('参加者は準備中だと期間ものが全部閉じている', () => {
  const e = env();
  const d = tabs(e);
  ['entry','transfer','protect','manager','claims'].forEach((k) => {
    eq(d[k].open, false, k);
  });
});

t('閉じている理由が返る', () => {
  const e = env();
  ok(tabs(e).transfer.reason.includes('移籍市場'), tabs(e).transfer.reason);
});

// ---- エントリー ------------------------------------------------------------

t('エントリー受付中だけエントリーが開く', () => {
  const open = env({ status: 'エントリー受付' });
  eq(tabs(open).entry.open, true);

  const closed = env({ status: 'シーズン1' });
  eq(tabs(closed).entry.open, false);
});

// ---- 移籍 ------------------------------------------------------------------

t('移籍市場1で移籍が開く', () => {
  const e = env({ status: '移籍市場1' });
  eq(tabs(e).transfer.open, true);
  ok(tabs(e).transfer.reason.includes('第1次'), tabs(e).transfer.reason);
});

t('移籍市場2でも開く', () => {
  const e = env({ status: '移籍市場2' });
  eq(tabs(e).transfer.open, true);
  ok(tabs(e).transfer.reason.includes('第2次'), tabs(e).transfer.reason);
});

t('シーズン中は移籍が閉じる', () => {
  const e = env({ status: 'シーズン1' });
  eq(tabs(e).transfer.open, false);
});

t('トーナメント中も移籍は閉じる', () => {
  const e = env({ status: 'トーナメント' });
  eq(tabs(e).transfer.open, false);
});

// ---- プロテクト ------------------------------------------------------------

t('無料プロテクト期間なら開く', () => {
  // 市場開幕を5日後にすると、開始（6日前）は過ぎ、締切（3日前）はまだ先
  const e = env({ status: '準備中', w1: daysFromNow(5) });
  const d = tabs(e).protect;
  eq(d.open, true);
  ok(d.reason.includes('無料'), d.reason);
});

t('無料期の開始前はプロテクトも閉じている', () => {
  // 無料プロテクトには開始日がある（開幕の6日前）。
  // 市場がずっと先なら、まだ設定できないのでタブも出さない
  const e = env({ status: '準備中', w1: daysFromNow(60), w2: daysFromNow(120) });
  eq(tabs(e).protect.open, false);
});

t('無料と有料の間の空白期間は閉じる', () => {
  // 実行時刻でぶれないよう、サーバー時刻を固定して判定させる
  const open = new Date(2026, 5, 11, 12, 0, 0);       // 開幕 6/11

  const e = env({ status: '準備中', w1: open, w2: new Date(2026, 8, 1) });
  e.now = () => new Date(2026, 5, 9, 12, 0, 0);       // 無料締切（6/8）の翌日

  eq(tabs(e).protect.open, false);
});

t('有料期に入れば開く', () => {
  const open = new Date(2026, 5, 11, 12, 0, 0);

  const e = env({ status: '準備中', w1: open, w2: new Date(2026, 8, 1) });
  e.now = () => new Date(2026, 5, 10, 23, 30, 0);     // 有料開始（前日23:00）の後

  const d = tabs(e).protect;
  eq(d.open, true);
  ok(d.reason.includes('有料'), d.reason);
});

t('市場が終わっていればプロテクトは閉じる', () => {
  const e = env({ status: 'シーズン1', w1: daysFromNow(-30), w2: daysFromNow(-20) });
  eq(tabs(e).protect.open, false);
});

t('プロテクトはシーズン状態ではなく日時で決まる', () => {
  // 状態は「シーズン1」でも、第2次の無料期に入っていれば開く
  const e = env({ status: 'シーズン1', w1: daysFromNow(-60), w2: daysFromNow(5) });
  eq(tabs(e).protect.open, true);
});

// ---- 使用監督 --------------------------------------------------------------

t('受付停止中は監督タブが閉じる', () => {
  const e = env({ config: { manager_round: 0 } });
  eq(tabs(e).manager.open, false);
});

t('第一次受付中は開く', () => {
  const e = env({ config: { manager_round: 1 } });
  const d = tabs(e).manager;
  eq(d.open, true);
  ok(d.reason.includes('第一次'), d.reason);
});

t('第二次受付中も開く', () => {
  const e = env({ config: { manager_round: 2 } });
  const d = tabs(e).manager;
  eq(d.open, true);
  ok(d.reason.includes('第二次'), d.reason);
});

// ---- 補填 ------------------------------------------------------------------

function withClaim(e, status) {
  e.__addRow('Claims', {
    claim_id: 'cl1', season_id: 's1', team_id: 't_a', player_id: 'p1',
    reason: '大会外移籍', base_cost: 100000000, rate: 0.8,
    refund_amount: 80000000, choice: '未選択', status: status || '選択待ち',
  });
}

t('請求が無ければ補填タブは出ない', () => {
  const e = env();
  const d = tabs(e).claims;
  eq(d.open, false);
  ok(d.reason.includes('対象はありません'), d.reason);
});

t('未精算の請求があれば開く', () => {
  const e = env();
  withClaim(e);
  const d = tabs(e).claims;
  eq(d.open, true);
  eq(d.count, 1);
});

t('精算済みだけなら出ない', () => {
  const e = env();
  withClaim(e, '精算済');
  eq(tabs(e).claims.open, false);
});

t('無効になった請求も出ない', () => {
  const e = env();
  withClaim(e, '無効');
  eq(tabs(e).claims.open, false);
});

t('選択期限を過ぎたら閉じる', () => {
  const e = env({ deadline: daysFromNow(-1) });
  withClaim(e);
  const d = tabs(e).claims;
  eq(d.open, false);
  ok(d.reason.includes('期限'), d.reason);
});

t('期限内なら開く', () => {
  const e = env({ deadline: daysFromNow(3) });
  withClaim(e);
  eq(tabs(e).claims.open, true);
});

t('他チームの請求では開かない', () => {
  const e = env();
  e.__addRow('Claims', {
    claim_id: 'cl2', season_id: 's1', team_id: 't_other', player_id: 'p1',
    reason: '辞退', base_cost: 1, rate: 0.9, refund_amount: 1,
    choice: '未選択', status: '選択待ち',
  });
  eq(tabs(e).claims.open, false);
});

t('期限を過ぎても主催者には見える', () => {
  const e = env({ deadline: daysFromNow(-1) });
  withClaim(e);
  eq(e.getUiState('ORG', { season_id: 's1' }).data.tabs.claims.open, true);
});

// ---- その他 ----------------------------------------------------------------

t('未ログインでは取得できない', () => {
  const e = env();
  eq(e._route('getUiState', '', { season_id: 's1' }).ok, false);
});

t('シーズン未指定なら最新を使う', () => {
  const e = env({ status: 'エントリー受付' });
  const d = e.getUiState('A', {}).data;
  eq(d.season_id, 's1');
  eq(d.tabs.entry.open, true);
});

t('シーズンが1つも無くても落ちない', () => {
  const e = createEnv(SHEETS, CONFIG);
  e.__tokens['A'] = 'a@example.com';
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'GM太郎', role: 'team', team_id: 't_a' });
  const r = e.getUiState('A', {});
  eq(r.ok, true);
  eq(r.data.tabs.entry.open, false);
});

t('タブを隠しても書き込みは別途拒否される', () => {
  // 移籍タブが閉じている状態でも、API は独自に期間を検証している
  const e = env({ status: 'シーズン1' });
  eq(tabs(e).transfer.open, false);

  e.__addRow('Players', { player_id: 'p1', name: '選手', position: 'FW', real_club: '鹿島アントラーズ', eligible: true });
  const r = e.requestTransfer('A', {
    season_id: 's1', to_team: 't_a', player_id: 'p1',
    method: '完全移籍', gross_fee: 10000000,
  });
  eq(r.ok, false);
  ok(r.error.includes('移籍市場'), r.error);
});

report('ui.js');
