const { createEnv, t, eq, ok, report } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','claim_deadline_at','created_at'],
  Protections: ['protection_id','season_id','team_id','player_id','window','slot','fee'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  Players: ['player_id','name','position','real_club','eligible'],
  Config: ['key','value','note'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Managers: ['manager_id','name','club','category','active'],
  ManagerPicks: ['pick_id','season_id','team_id','round','manager_id','status','created_at','decided_at'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  ScheduleTemplate: ['sort_order','day_offset','label','note'],
  SeasonSchedule: ['schedule_id','season_id','date','label','note','sort_order','done'],
  Clubs: ['category','club_name','sort_order'],
  Transfers: ['transfer_id','season_id','window','player_id','from_team','to_team','method','gross_fee','cost_to_buyer','payout_to_seller','registered_at','status'],
  Matches: ['match_id','season_id','stage','round','tie_id','leg','home_team','away_team','home_score','away_score','home_pk','away_pk','status','reported_by','created_at'],
  MatchGoals: ['goal_id'], MatchTeamStats: ['id'], MatchGKStats: ['id'],
  SeasonTeams: ['season_id','team_id','division'],
  SuperCup: ['season_id','team_a','team_b','streamed','note'],
  EntryLists: ['entry_id','season_id','team_id','status','submitted_at'],
  Signups: ['signup_id'],
};

// 昨季と同じ設定：移籍市場開幕 5/22
const CONFIG = {
  protect_free_start_before_days: 6,   // 5/16 から
  protect_free_before_days: 3,         // 5/19 まで
  protect_paid_before_days: 1,         // 5/21 23:00 から
  protect_paid_start: '23:00',
  market_days: 3,                      // 5/24 いっぱいまで
  free_protect_count: 2, paid_protect_count: 3,
  manager_round: 0,
};

/** 移籍市場開幕を 2026-05-22 12:00 にしたシーズン */
function env() {
  const e = createEnv(SHEETS, CONFIG);
  e.__tokens['ORG'] = 'org@example.com';
  e.__tokens['A'] = 'a@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: 'GM太郎', role: 'team', team_id: 't_a' });
  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', owner_user_id: 'u_a', kind: '継続', active: true });
  e.__addRow('Seasons', {
    season_id: 's1', name: '2026シーズン', status: 'エントリー受付',
    window1_open_at: new Date(2026, 4, 22, 12, 0, 0),
    window2_open_at: new Date(2026, 9, 1, 12, 0, 0),
  });
  return e;
}

/** 指定日時でのフェーズを返す */
function phaseAt(e, y, m, d, hh, mm) {
  const season = e.findRow('Seasons', 'season_id', 's1');
  return e._currentProtectionPhase(season, new Date(y, m - 1, d, hh || 12, mm || 0, 0));
}

const iso = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');

// ---- 昨季の日程どおりに区切られるか ----------------------------------------

t('期間が昨季の日程と一致する', () => {
  const e = env();
  const season = e.findRow('Seasons', 'season_id', 's1');
  const p = e._protectionPeriods(season, 1);

  eq(iso(p.freeStart), '2026-5-16');   // 無料プロテクト開始
  eq(iso(p.freeEnd), '2026-5-19');     // 無料プロテクト締切
  eq(iso(p.paidStart), '2026-5-21');   // 有料は開幕前日23:00から
  eq(iso(p.paidEnd), '2026-5-24');     // 市場最終日いっぱい
});

t('5/15はまだ開いていない', () => {
  eq(phaseAt(env(), 2026, 5, 15).phase, '受付外');
});

t('5/16から無料期に入る', () => {
  eq(phaseAt(env(), 2026, 5, 16, 0, 0).phase, '無料');
});

t('5/17・5/18も無料期', () => {
  eq(phaseAt(env(), 2026, 5, 17).phase, '無料');
  eq(phaseAt(env(), 2026, 5, 18).phase, '無料');
});

t('5/19いっぱいまで無料期', () => {
  eq(phaseAt(env(), 2026, 5, 19, 23, 59).phase, '無料');
});

t('5/20は空白期間', () => {
  eq(phaseAt(env(), 2026, 5, 20).phase, '受付外');
});

t('5/21の22:59はまだ空白', () => {
  eq(phaseAt(env(), 2026, 5, 21, 22, 59).phase, '受付外');
});

t('5/21の23:00から有料期', () => {
  eq(phaseAt(env(), 2026, 5, 21, 23, 0).phase, '有料');
});

t('市場最終日5/24まで有料期', () => {
  eq(phaseAt(env(), 2026, 5, 24, 23, 0).phase, '有料');
});

t('5/25は第2次の判定に移り、まだ開いていない', () => {
  const r = phaseAt(env(), 2026, 5, 25);
  eq(r.phase, '受付外');
  eq(r.window, 2);
});

// ---- 開始日を設けた効果 ----------------------------------------------------

t('シーズン開始直後にはプロテクトできない', () => {
  const e = env();
  // 4/1 は開幕の50日以上前
  eq(phaseAt(e, 2026, 4, 1).phase, '受付外');
});

t('タブも開始前は出ない', () => {
  const e = env();
  e.now = () => new Date(2026, 4, 15, 12, 0, 0);   // 5/15
  eq(e.getUiState('A', { season_id: 's1' }).data.tabs.protect.open, false);
});

t('開始日を過ぎればタブが出る', () => {
  const e = env();
  e.now = () => new Date(2026, 4, 16, 9, 0, 0);    // 5/16
  const d = e.getUiState('A', { season_id: 's1' }).data.tabs.protect;
  eq(d.open, true);
  ok(d.reason.includes('無料'), d.reason);
});

t('締切後はタブが消える', () => {
  const e = env();
  e.now = () => new Date(2026, 4, 20, 12, 0, 0);   // 5/20
  eq(e.getUiState('A', { season_id: 's1' }).data.tabs.protect.open, false);
});

// ---- 設定で動かせるか ------------------------------------------------------

t('開始日は Config で動かせる', () => {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, { protect_free_start_before_days: 8 }));
  e.__addRow('Seasons', {
    season_id: 's1', name: 'x', status: '準備中',
    window1_open_at: new Date(2026, 4, 22, 12, 0, 0), window2_open_at: '',
  });
  const p = e._protectionPeriods(e.findRow('Seasons', 'season_id', 's1'), 1);
  eq(iso(p.freeStart), '2026-5-14');
});

t('締切も Config で動かせる', () => {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, { protect_free_before_days: 2 }));
  e.__addRow('Seasons', {
    season_id: 's1', name: 'x', status: '準備中',
    window1_open_at: new Date(2026, 4, 22, 12, 0, 0), window2_open_at: '',
  });
  const p = e._protectionPeriods(e.findRow('Seasons', 'season_id', 's1'), 1);
  eq(iso(p.freeEnd), '2026-5-20');
});

// ---- 書き込み側も従うか ----------------------------------------------------

t('開始前はプロテクトを設定できない', () => {
  const e = env();
  e.now = () => new Date(2026, 4, 15, 12, 0, 0);
  e.__addRow('Players', { player_id: 'p1', name: '選手', position: 'FW', real_club: '鹿島アントラーズ', eligible: true });
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's1', team_id: 't_a', player_id: 'p1', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });

  const r = e.setProtection('A', { season_id: 's1', team_id: 't_a', player_id: 'p1' });
  eq(r.ok, false);
});

t('無料期なら設定できる', () => {
  const e = env();
  e.now = () => new Date(2026, 4, 17, 12, 0, 0);
  e.__addRow('Players', { player_id: 'p1', name: '選手', position: 'FW', real_club: '鹿島アントラーズ', eligible: true });
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's1', team_id: 't_a', player_id: 'p1', status: '在籍', acquisition_type: 'エントリー', acquired_cost: 0 });

  const r = e.setProtection('A', { season_id: 's1', team_id: 't_a', player_id: 'p1' });
  eq(r.ok, true);
});

report('protectwindow.js');
