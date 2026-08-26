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
  MatchGoals: ['goal_id','match_id','team_id','scorer_id','assist_id'],
  MatchTeamStats: ['id','match_id','team_id','shots','shots_on_target'],
  MatchGKStats: ['id','match_id','team_id','gk_player_id','saves'],
  SeasonTeams: ['season_id','team_id','division'],
  SuperCup: ['season_id','team_a','team_b','streamed','note'],
  EntryLists: ['entry_id','season_id','team_id','status'],
  Protections: ['protection_id','season_id','team_id','player_id','window','slot','fee'],
  Config: ['key','value','note'],
  BudgetTx: ['tx_id','season_id','team_id','amount','reason','ref','created_at'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','expires_at'],
  Goals: ['goal_id','match_id','team_id','scorer_id','assist_id','minute'],
  TeamMatchStats: ['id','match_id','team_id','shots','shots_on_target'],
  GkStats: ['id','match_id','team_id','gk_player_id','saves'],
};

const CONFIG = { signup_code: 'code', signup_open: true, signup_club_categories: 'J1,J2' };

function env() {
  const e = createEnv(SHEETS, CONFIG);

  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', display_name: '参加A', role: 'team', team_id: 't_a' });
  e.__addRow('Users', { user_id: 'u_b', email: 'b@example.com', display_name: '参加B', role: 'team', team_id: 't_b' });

  e.__addRow('Teams', { team_id: 't_a', name: 'テストA', owner_user_id: 'u_a', kind: '新規', active: true });
  e.__addRow('Teams', { team_id: 't_b', name: 'テストB', owner_user_id: 'u_b', kind: '新規', active: true });

  e.__addRow('Seasons', { season_id: 's1', name: 'テストシーズン', status: '終了' });
  e.__addRow('Seasons', { season_id: 's2', name: 'E2E', status: '準備中' });

  e.__addRow('Matches', { match_id: 'm1', season_id: 's1', stage: 'league', home_team: 't_a', away_team: 't_b', status: '承認' });
  e.__addRow('Transfers', { transfer_id: 'tr1', season_id: 's1', player_id: 'p1', to_team: 't_a', status: '承認' });
  e.__addRow('BudgetTx', { tx_id: 'tx1', season_id: 's1', team_id: 't_a', amount: 100, reason: 'テスト' });
  e.__addRow('Rosters', { roster_id: 'r1', season_id: 's1', team_id: 't_a', player_id: 'p1', status: '在籍' });
  e.__addRow('Signups', { signup_id: 'sg1', email: 'x@example.com', team_name: 'あ', status: '却下' });
  e.__addRow('SeasonTeams', { season_id: 's1', team_id: 't_a', division: 'GM1' });
  e.__addRow('SuperCup', { season_id: 's1', team_a: 't_a', team_b: 't_b', streamed: true });

  // 残るべきもの
  e.__addRow('Players', { player_id: 'p1', name: '選手いち', position: 'FW', real_club: '鹿島', eligible: true });
  e.__addRow('Clubs', { category: 'J1', club_name: '鹿島アントラーズ', sort_order: 1 });

  return e;
}

const rows = (e, sheet) => e.__rows(sheet).length - 1;

t('確認フラグが false なら何も消さない', () => {
  const e = env();
  e.resetAllTournamentData();
  eq(rows(e, 'Teams'), 2);
  eq(rows(e, 'Seasons'), 2);
  eq(rows(e, 'Users'), 3);
});

t('previewReset は何も消さない', () => {
  const e = env();
  e.previewReset();
  eq(rows(e, 'Teams'), 2);
  eq(rows(e, 'Matches'), 1);
  eq(rows(e, 'Users'), 3);
});

t('確認フラグを立てると大会データが消える', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();

  ['Seasons','Teams','Rosters','Transfers','BudgetTx','Matches',
   'SeasonTeams','SuperCup','Signups','EntryLists','Protections'].forEach((s) => {
    eq(rows(e, s), 0, s + ' が残っている');
  });
});

t('選手マスタとクラブは残る', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();
  eq(rows(e, 'Players'), 1);
  eq(rows(e, 'Clubs'), 1);
});

t('主催者は残り、参加者だけ消える', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();
  eq(rows(e, 'Users'), 1);
  eq(e.__rows('Users')[1][1], 'org@example.com');
});

t('主催者が居ないときは中止する', () => {
  const e = env();
  // 主催者を消してから実行
  e.__rows('Users')[1][3] = 'team';
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();
  eq(rows(e, 'Teams'), 2, '中止せず消してしまった');
  eq(rows(e, 'Users'), 3);
});

t('リセット後はログインが通り、公開ページも空で返る', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();

  e.__tokens['ORG'] = 'org@example.com';
  eq(e.whoami('ORG').ok, true);

  const pub = e.getPublicData({});
  eq(pub.ok, true);
  eq(pub.data.seasons.length, 0);
  eq(pub.data.participants.length, 0);
});

t('リセット後は全クラブが選べる', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();
  const d = e.getSignupClubs('', {}).data;
  eq(d.available, 1);
  eq(d.clubs.J1[0].taken, false);
});

t('ヘッダー行は消さない', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();
  eq(e.__rows('Teams')[0], ['team_id','name','owner_user_id','kind','active']);
  eq(e.__rows('Matches')[0][0], 'match_id');
});

t('空のシートに対しても落ちない', () => {
  const e = env();
  e.RESET_CONFIRMED = true;
  e.resetAllTournamentData();
  e.resetAllTournamentData();  // 2回目
  eq(rows(e, 'Teams'), 0);
});

report('reset.js');
