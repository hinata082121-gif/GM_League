const vm = require('vm');
const { createEnv, t, eq, ok, report } = require('./harness');

// エントリー変更: 自クラブのエントリー済み選手を1人外し、
// 自クラブのエントリー外の選手を1人入れる。無償。
//
// A=鹿島（継続）
//   在籍: k1（自クラブ・初期） k2（自クラブ・プロテクト中） k5（自クラブ・対象外＋補填請求）
//         u1（浦和の選手・移籍で獲得） k6（自クラブ・期限付きで預かり中）
//   エントリー外: k3 k4（未保有） k7（補填の入れ替え先として予約済み）
// B=浦和 は u2 を保有

const SHEETS = {
  Users: ['user_id','email','display_name','role','team_id','x_id'],
  Teams: ['team_id','name','owner_user_id','kind','active'],
  Seasons: ['season_id','name','status','claim_deadline_at'],
  Players: ['player_id','name','position','detail_position','age','nationality','real_club','eligible'],
  Rosters: ['roster_id','season_id','team_id','player_id','status','acquisition_type','acquired_cost','acquired_at','expires_season'],
  Claims: ['claim_id','season_id','team_id','player_id','reason','base_cost','rate','refund_amount','choice','replacement_id','status','created_at','chosen_at','chosen_by','settled_at'],
  Protections: ['protection_id','season_id','window','team_id','player_id','tier','fee','set_at'],
  SeasonSchedule: ['schedule_id','season_id','date','label','note','sort_order','done'],
  EntryChanges: ['change_id','season_id','team_id','out_player_id','in_player_id','changed_at','changed_by'],
  Transfers: ['transfer_id','season_id','player_id','from_team','to_team','method','status'],
  Config: ['key','value','note'],
};

function env(nowIso) {
  const e = createEnv(SHEETS, { squad_min: 22, squad_max: 35 });
  e.__tokens.ORG = 'org@example.com';
  e.__tokens.A = 'a@example.com';
  e.__tokens.B = 'b@example.com';
  e.__addRow('Users', { user_id: 'u_org', email: 'org@example.com', role: 'organizer' });
  e.__addRow('Users', { user_id: 'u_a', email: 'a@example.com', role: 'team', team_id: 't_a' });
  e.__addRow('Users', { user_id: 'u_b', email: 'b@example.com', role: 'team', team_id: 't_b' });
  e.__addRow('Teams', { team_id: 't_a', name: '鹿島アントラーズ', kind: '継続', active: true });
  e.__addRow('Teams', { team_id: 't_b', name: '浦和レッズ', kind: '継続', active: true });
  e.__addRow('Seasons', { season_id: 's1', name: 'S15', status: 'エントリー受付' });

  const P = (id, name, club, eligible) =>
    e.__addRow('Players', { player_id: id, name, position: 'MF', detail_position: 'CMF', age: 25, nationality: '日本', real_club: club, eligible: eligible !== false });
  ['k1','k2','k3','k4','k6','k7'].forEach((id) => P(id, '鹿島' + id.slice(1), '鹿島アントラーズ'));
  P('k5', '鹿島5', '鹿島アントラーズ', false);
  P('u1', '浦和1', '浦和レッズ');
  P('u2', '浦和2', '浦和レッズ');

  const R = (id, team, pid, type, status) =>
    e.__addRow('Rosters', { roster_id: id, season_id: 's1', team_id: team, player_id: pid, status: status || '在籍', acquisition_type: type || '初期', acquired_cost: 0 });
  R('r1', 't_a', 'k1');
  R('r2', 't_a', 'k2');
  R('r5', 't_a', 'k5');
  R('r3', 't_a', 'u1', '完全移籍');
  R('r6', 't_a', 'k6', '全期期限付き');
  R('r4', 't_b', 'u2');

  e.__addRow('Protections', { protection_id: 'pr1', season_id: 's1', window: 1, team_id: 't_a', player_id: 'k2', tier: '無料1' });
  e.__addRow('Claims', { claim_id: 'c1', season_id: 's1', team_id: 't_a', player_id: 'k5', status: '確定', choice: '入れ替え', replacement_id: 'k7', refund_amount: 0 });

  // 9/23〜9/26 が受付期間
  e.__addRow('SeasonSchedule', { schedule_id: 'sc1', season_id: 's1', date: new Date(2026, 8, 23), label: 'エントリー変更開始' });
  e.__addRow('SeasonSchedule', { schedule_id: 'sc2', season_id: 's1', date: new Date(2026, 8, 26), label: 'エントリー変更締切' });
  e.__addRow('SeasonSchedule', { schedule_id: 'sc3', season_id: 's1', date: new Date(2026, 8, 22), label: '横浜F・マリノス エントリー変更（特例・本日中）' });

  const at = nowIso ? new Date(nowIso) : new Date(2026, 8, 24, 12, 0, 0);
  vm.runInContext('now = function () { return new Date(' + at.getTime() + '); };', e);
  return e;
}

const status = (e, who) => e.getEntryChangeStatus(who || 'A', { season_id: 's1', team_id: 't_a' });
const swap = (e, outId, inId, who) =>
  e.swapEntryPlayer(who || 'A', { season_id: 's1', team_id: 't_a', out_player_id: outId, in_player_id: inId });
const activeOf = (e, team) => {
  const rows = e.__rows('Rosters');
  const c = rows[0];
  return rows.slice(1)
    .filter((r) => r[c.indexOf('team_id')] === team && r[c.indexOf('status')] === '在籍')
    .map((r) => r[c.indexOf('player_id')]).sort();
};

// ---- 一覧 ----------------------------------------------------------------

t('入れられるのは自クラブの未保有だけ（予約済みは除く）', () => {
  const d = status(env()).data;
  eq(d.candidates.map((c) => c.player_id).sort(), ['k3', 'k4']);
});

t('外せる・外せないが理由つきで返る', () => {
  const d = status(env()).data;
  const by = {};
  d.entered.forEach((p) => { by[p.player_id] = p; });
  eq(by.k1.swappable, true);
  eq(by.k2.swappable, false, 'プロテクト中');
  ok(by.k2.reason.includes('プロテクト'), by.k2.reason);
  eq(by.k5.swappable, false, '補填対象');
  ok(by.k5.reason.includes('補填'), by.k5.reason);
  eq(by.u1.swappable, false, '他クラブ');
  ok(by.u1.reason.includes('他クラブ'), by.u1.reason);
  eq(by.k6.swappable, false, '期限付き');
});

t('受付期間は日程表の開始日0:00〜締切日23:59', () => {
  const at = (...a) => new Date(2026, 8, ...a).toISOString();
  eq(status(env(at(23, 0, 0, 0))).data.window.open, true, '開始日0:00');
  eq(status(env(at(22, 23, 59, 0))).data.window.open, false, '開始前日');
  eq(status(env(at(26, 23, 59, 0))).data.window.open, true, '締切日23:59');
  eq(status(env(at(27, 0, 0, 1))).data.window.open, false, '締切翌日');
});

t('マリノスの特例の行は期間の判定に混ざらない', () => {
  const w = status(env()).data.window;
  eq(new Date(w.start_at).getDate(), 23);
});

// ---- 入れ替え ------------------------------------------------------------

t('入れ替えると外した選手が離脱し、入れた選手が0円で在籍になる', () => {
  const e = env();
  const r = swap(e, 'k1', 'k3');
  eq(r.ok, true, r.error);
  eq(activeOf(e, 't_a'), ['k2', 'k3', 'k5', 'k6', 'u1']);

  const rows = e.__rows('Rosters');
  const c = rows[0];
  const k3 = rows.slice(1).find((x) => x[c.indexOf('player_id')] === 'k3');
  eq(k3[c.indexOf('acquisition_type')], 'エントリー変更');
  eq(k3[c.indexOf('acquired_cost')], 0);
});

t('人数は変わらない', () => {
  const e = env();
  const before = activeOf(e, 't_a').length;
  swap(e, 'k1', 'k3');
  eq(activeOf(e, 't_a').length, before);
});

t('履歴に残る', () => {
  const e = env();
  swap(e, 'k1', 'k3');
  const h = status(e).data.history;
  eq(h.length, 1);
  eq(h[0].out_name, '鹿島1');
  eq(h[0].in_name, '鹿島3');
  eq(e.listEntryChanges('ORG', { season_id: 's1' }).data.history.length, 1);
});

t('外した選手はエントリー外に戻り、また入れられる', () => {
  const e = env();
  swap(e, 'k1', 'k3');
  ok(status(e).data.candidates.some((c) => c.player_id === 'k1'));
  eq(swap(e, 'k3', 'k1').ok, true);
});

t('外した選手は補填の入れ替え候補にも戻る', () => {
  const e = env();
  swap(e, 'k1', 'k3');
  const d = e.getMyClaims('A', { season_id: 's1', team_id: 't_a' }).data;
  ok(d.candidates.some((c) => c.player_id === 'k1'));
});

t('申請中の行を入れ替えたら申請中のまま', () => {
  const e = env();
  const rows = e.__rows('Rosters');
  const c = rows[0];
  rows.slice(1).find((x) => x[0] === 'r1')[c.indexOf('status')] = '申請中';
  e.__dropCache('Rosters');
  eq(swap(e, 'k1', 'k3').ok, true);
  const k3 = e.__rows('Rosters').slice(1).find((x) => x[c.indexOf('player_id')] === 'k3');
  eq(k3[c.indexOf('status')], '申請中');
});

// ---- 拒否 ----------------------------------------------------------------

t('プロテクト中の選手は外せない', () => {
  const r = swap(env(), 'k2', 'k3');
  eq(r.ok, false);
  ok(r.error.includes('プロテクト'), r.error);
});

t('補填対象の選手は外せない', () => {
  eq(swap(env(), 'k5', 'k3').ok, false);
});

t('他クラブの選手は外せない', () => {
  eq(swap(env(), 'u1', 'k3').ok, false);
});

t('期限付きで預かっている選手は外せない', () => {
  eq(swap(env(), 'k6', 'k3').ok, false);
});

t('補填で予約済みの選手は入れられない', () => {
  eq(swap(env(), 'k1', 'k7').ok, false);
});

t('他クラブの選手は入れられない', () => {
  eq(swap(env(), 'k1', 'u2').ok, false);
});

t('保有済みの選手は入れられない', () => {
  eq(swap(env(), 'k1', 'k2').ok, false);
});

t('期間外は参加者は変更できない', () => {
  const r = swap(env(new Date(2026, 8, 27, 9, 0).toISOString()), 'k1', 'k3');
  eq(r.ok, false);
  ok(r.error.includes('終わりました'), r.error);
});

t('期間外でも主催者は代行できる', () => {
  eq(swap(env(new Date(2026, 8, 27, 9, 0).toISOString()), 'k1', 'k3', 'ORG').ok, true);
});

t('他チームのエントリーは触れない', () => {
  eq(swap(env(), 'k1', 'k3', 'B').ok, false);
});

t('失敗したら何も書かない', () => {
  const e = env();
  swap(e, 'k2', 'k3');
  eq(activeOf(e, 't_a'), ['k1', 'k2', 'k5', 'k6', 'u1']);
  eq(e.__rows('EntryChanges').length, 1);
});

report('entrychange.js');
