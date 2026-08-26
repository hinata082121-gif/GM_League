const { createEnv, t, eq, ok, report } = require('./harness');

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','leg_enabled','window1_open_at','window2_open_at','created_at'],
  Signups: ['signup_id','email','display_name','team_name','x_id','note','status','created_at','decided_at','decided_by','team_id'],
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
  two_division_min_teams: 15, win_points: 3, draw_points: 1,
};

function env(over) {
  const e = createEnv(SHEETS, Object.assign({}, CONFIG, over || {}));
  e.__tokens['ORG'] = 'org@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', display_name: '主催者', role: 'organizer', team_id: '', x_id: 'gm_master' });

  ['A','B','C'].forEach((k, i) => {
    e.__addRow('Users', {
      user_id: 'u_' + k, email: k.toLowerCase() + '@example.com',
      display_name: 'オーナー' + k, role: 'team', team_id: 't_' + k,
      x_id: i === 2 ? '' : 'owner_' + k.toLowerCase(),
    });
    e.__addRow('Teams', { team_id: 't_' + k, name: 'チーム' + k, owner_user_id: 'u_' + k, kind: '新規', active: true });
  });

  e.__addRow('Seasons', { season_id: 's1', name: '2025シーズン', status: '終了' });
  e.__addRow('Seasons', { season_id: 's2', name: '2026シーズン', status: 'シーズン1' });

  e.__addRow('Players', { player_id: 'p1', name: '選手いち', position: 'FW', real_club: '鹿島', eligible: true });
  e.__addRow('Players', { player_id: 'p2', name: '選手にい', position: 'DF', real_club: '浦和', eligible: true });
  return e;
}

function addMatch(e, over) {
  e.__addRow('Matches', Object.assign({
    match_id: 'm' + Math.random().toString(36).slice(2, 7),
    season_id: 's2', stage: 'league', round: '第1節', tie_id: '', leg: '',
    home_team: 't_A', away_team: 't_B', home_score: 2, away_score: 1,
    home_pk: '', away_pk: '', status: '承認', reported_by: 'u_A',
    created_at: new Date(),
  }, over || {}));
}

// ---- 認証不要であること ----------------------------------------------------

t('トークンなしで公開データが取れる', () => {
  const e = env();
  const r = e.getPublicData({});
  eq(r.ok, true);
});

t('doPost 経由でもトークンなしで通る', () => {
  const e = env();
  const r = e._route('getPublicData', '', {});
  eq(r.ok, true);
});

t('公開データに email は一切含まれない', () => {
  const e = env();
  const json = JSON.stringify(e.getPublicData({}));
  ok(!json.includes('@example.com'), 'email が漏れている');
});

t('偽の合鍵では順位表を直接取れない', () => {
  const e = env();
  // PUBLIC_ACCESS はオブジェクトなので、文字列では一致しない
  eq(e.getStandings('{}', { season_id: 's2' }).ok, false);
  eq(e.getStandings('[object Object]', { season_id: 's2' }).ok, false);
  eq(e._route('getStandings', '', { season_id: 's2' }).ok, false);
});

// ---- 参加者一覧 ------------------------------------------------------------

t('参加者一覧にチーム名とXIDが出る', () => {
  const e = env();
  const list = e.getPublicData({}).data.participants;
  eq(list.length, 3);
  const a = list.filter((p) => p.team_name === 'チームA')[0];
  eq(a.owner_name, 'オーナーA');
  eq(a.owner_x_id, 'owner_a');
});

t('X ID 未設定のオーナーは空文字', () => {
  const e = env();
  const c = e.getPublicData({}).data.participants.filter((p) => p.team_name === 'チームC')[0];
  eq(c.owner_x_id, '');
});

t('参加中のチームが先に並ぶ', () => {
  const e = env();
  e.__addRow('Users', { user_id: 'u_Z', email: 'z@example.com', display_name: 'オーナーZ', role: 'team', team_id: 't_Z', x_id: '' });
  e.__addRow('Teams', { team_id: 't_Z', name: 'あいうえおFC', owner_user_id: 'u_Z', kind: '新規', active: false });
  const list = e.getPublicData({}).data.participants;
  eq(list[list.length - 1].team_name, 'あいうえおFC');
  eq(list[list.length - 1].active, false);
});

t('主催者だけのアカウントはチーム一覧に出ない', () => {
  const e = env();
  const list = e.getPublicData({}).data.participants;
  ok(list.every((p) => p.owner_name !== '主催者'));
});

// ---- 順位表 ----------------------------------------------------------------

t('既定は最新シーズン', () => {
  const e = env();
  eq(e.getPublicData({}).data.season_id, 's2');
});

t('シーズンを指定できる', () => {
  const e = env();
  eq(e.getPublicData({ season_id: 's1' }).data.season_id, 's1');
});

t('存在しないシーズンを指定したら最新に落とす', () => {
  const e = env();
  eq(e.getPublicData({ season_id: 'nope' }).data.season_id, 's2');
});

t('順位表が承認済み試合から作られる', () => {
  const e = env();
  addMatch(e);
  const st = e.getPublicData({}).data.standings;
  eq(st.gm1.match_count, 1);
  eq(st.gm1.table[0].team_name, 'チームA');
  eq(st.gm1.table[0].points, 3);
});

t('未承認の試合は順位表に入らない', () => {
  const e = env();
  addMatch(e, { status: '申請中' });
  eq(e.getPublicData({}).data.standings.gm1.match_count, 0);
});

t('一部制なら gm2 は null', () => {
  const e = env();
  addMatch(e);
  const st = e.getPublicData({}).data.standings;
  eq(st.two_division, false);
  eq(st.gm2, null);
});

t('二部制なら GM1 と GM2 の2本返る', () => {
  const e = env();
  e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_A', division: 'GM1' });
  e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_B', division: 'GM1' });
  e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_C', division: 'GM2' });
  addMatch(e);
  const st = e.getPublicData({}).data.standings;
  eq(st.two_division, true);
  eq(st.format, '二部制');
  eq(st.gm1.table.length, 2);
  eq(st.gm2.table.length, 1);
});

// ---- 移籍動向 --------------------------------------------------------------

function addTransfer(e, over) {
  e.__addRow('Transfers', Object.assign({
    transfer_id: 'tr' + Math.random().toString(36).slice(2, 7),
    season_id: 's2', window: '1', player_id: 'p1',
    from_team: 't_B', to_team: 't_A', method: '完全移籍',
    gross_fee: 100000000, cost_to_buyer: 100000000, payout_to_seller: 90000000,
    registered_at: new Date('2026-08-01T12:00:00Z'), status: '承認',
  }, over || {}));
}

t('承認済み移籍が選手名つきで出る', () => {
  const e = env();
  addTransfer(e);
  const tr = e.getPublicData({}).data.transfers;
  eq(tr.length, 1);
  eq(tr[0].player_name, '選手いち');
  eq(tr[0].from_name, 'チームB');
  eq(tr[0].to_name, 'チームA');
  eq(tr[0].fee, 100000000);
});

t('申請中と差戻の移籍は公開しない', () => {
  const e = env();
  addTransfer(e, { status: '申請中' });
  addTransfer(e, { status: '差戻' });
  eq(e.getPublicData({}).data.transfers.length, 0);
});

t('他シーズンの移籍は混ざらない', () => {
  const e = env();
  addTransfer(e, { season_id: 's1' });
  eq(e.getPublicData({}).data.transfers.length, 0);
  eq(e.getPublicData({ season_id: 's1' }).data.transfers.length, 1);
});

t('移籍は新しい順に並ぶ', () => {
  const e = env();
  addTransfer(e, { player_id: 'p1', registered_at: new Date('2026-08-01T12:00:00Z') });
  addTransfer(e, { player_id: 'p2', registered_at: new Date('2026-08-05T12:00:00Z') });
  const tr = e.getPublicData({}).data.transfers;
  eq(tr[0].player_name, '選手にい');
});

t('オークションは売り手が空でも表示できる', () => {
  const e = env();
  addTransfer(e, { from_team: '', method: 'オークション' });
  const tr = e.getPublicData({}).data.transfers;
  eq(tr[0].from_team, '');
  eq(tr[0].from_name, '');
  eq(tr[0].method, 'オークション');
});

// ---- 受付状態 --------------------------------------------------------------

t('公開データに受付中フラグが乗る', () => {
  const e = env();
  eq(e.getPublicData({}).data.signup_open, true);
  eq(env({ signup_open: false }).getPublicData({}).data.signup_open, false);
});

t('シーズンが1つも無くても落ちない', () => {
  const e = createEnv(SHEETS, CONFIG);
  const r = e.getPublicData({});
  eq(r.ok, true);
  eq(r.data.seasons.length, 0);
  eq(r.data.standings, null);
});

report('public.js');
