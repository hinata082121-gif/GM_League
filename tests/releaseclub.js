const { t, eq, ok, report } = require('./harness');
const { env, claimsOf, rostersOf } = require('./cl-fixture');

// 参加クラブ間の現実移籍。
//
// 大会の外へ出たのではないので、選手は使えるまま。
// 変わるのは「誰が使えるか」だけ。手放した側には補填の請求が立つ。
//
// A=鹿島 が u1（浦和の選手・1億で獲得）と k1（自クラブ・0円）を持っている。

/** 選手の現実クラブを付け替える。名簿の同期が済んだ状態を作る */
function moveClub(e, playerId, club) {
  const rows = e.__rows('Players');
  const col = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.indexOf('player_id')] !== playerId) continue;
    rows[i][col.indexOf('real_club')] = club;
  }
  e.__dropCache('Players');
}

const eligibleOf = (e, pid) => {
  const rows = e.__rows('Players');
  const col = rows[0];
  const r = rows.slice(1).find((x) => x[col.indexOf('player_id')] === pid);
  return r[col.indexOf('eligible')];
};

const call = (e, ids) =>
  e.releaseToLeagueClub('ORG', { season_id: 's1', player_ids: ids });

// =============================================================================
// 手放す
// =============================================================================

t('保有チームの在籍から外れる', () => {
  const e = env();
  moveClub(e, 'u1', '浦和レッズ');   // A が持っている浦和の選手はそのまま
  const r = call(e, ['u1']);

  eq(r.ok, true, r.error);
  eq(r.data.released.length, 1);
  eq(r.data.released[0].from_name, '鹿島アントラーズ');
  ok(rostersOf(e, 's1', 't_a').every((x) => x[3] !== 'u1'), 'A の在籍から消える');
});

t('選手は大会に残る', () => {
  const e = env();
  call(e, ['u1']);
  eq(eligibleOf(e, 'u1'), true, '大会の外へ出たわけではない');
});

t('手放した側に補填の請求が立つ', () => {
  const e = env();
  call(e, ['u1']);

  const c = e.getMyClaims('A', { season_id: 's1' }).data.claims;
  eq(c.length, 1);
  eq(c[0].refund_amount, 80000000, '1億の80%');
  eq(c[0].swap_only, false);
});

t('獲得額0円なら入れ替えのみの請求になる', () => {
  const e = env();
  // 鹿島の k1 が浦和へ移った形。A は k1 を0円で持っていた
  moveClub(e, 'k1', '浦和レッズ');
  call(e, ['k1']);

  const c = e.getMyClaims('A', { season_id: 's1' }).data.claims;
  eq(c.length, 1);
  eq(c[0].refund_amount, 0);
  eq(c[0].swap_only, true);
});

t('外した選手は移籍先クラブの未保有になる', () => {
  const e = env();
  call(e, ['u1']);

  // 浦和から見ると、自クラブの選手で誰も持っていない状態
  const d = e.getTeamRoster('B', { team_id: 't_b', season_id: 's1' }).data;
  ok(d.outside.some((o) => o.player_id === 'u1'), 'エントリー外に出る');
  ok(d.transferred.every((o) => o.player_id !== 'u1'), '移籍済には出ない');
});

t('まとめて外せる', () => {
  const e = env();
  moveClub(e, 'k1', '浦和レッズ');
  const r = call(e, ['u1', 'k1']);

  eq(r.data.released.length, 2);
  eq(r.data.claims.length, 2);
});

// =============================================================================
// 弾く
// =============================================================================

t('参加クラブでなければ弾く', () => {
  const e = env();
  moveClub(e, 'u1', '横浜F・マリノス');
  const r = call(e, ['u1']);

  eq(r.data.released.length, 0);
  ok(r.data.skipped[0].reason.indexOf('参加クラブではありません') !== -1,
     r.data.skipped[0].reason);
});

t('誰も持っていない選手は何もしない', () => {
  const e = env();
  const r = call(e, ['u4']);

  eq(r.data.released.length, 0);
  eq(r.data.claims.length, 0);
  ok(r.data.skipped[0].reason.indexOf('そのまま登録できます') !== -1);
});

t('既に移籍先が持っていれば何もしない', () => {
  const e = env();
  const r = call(e, ['u2']);   // u2 は浦和の選手で、浦和が持っている

  eq(r.data.released.length, 0);
  ok(r.data.skipped[0].reason.indexOf('既に移籍先') !== -1);
});

t('オークションの選手には請求を立てない', () => {
  const e = env();
  const rows = e.__rows('Rosters');
  const col = rows[0];
  rows.find((x) => x[col.indexOf('roster_id')] === 'r3')[col.indexOf('acquisition_type')] = 'オークション';
  e.__dropCache('Rosters');

  const r = call(e, ['u1']);
  eq(r.data.released.length, 1, '在籍からは外す');
  eq(r.data.claims.length, 0, 'シーズン終了で離脱するので補填は無し');
});

t('同じ選手を2回指定しても1回だけ', () => {
  const e = env();
  const r = call(e, ['u1', 'u1']);
  eq(r.data.released.length, 1);
  eq(claimsOf(e).length, 1);
});

t('選手が空なら拒否する', () => {
  const e = env();
  eq(call(e, []).ok, false);
});

t('存在しないシーズンは拒否する', () => {
  const e = env();
  eq(e.releaseToLeagueClub('ORG', { season_id: 's_none', player_ids: ['u1'] }).ok, false);
});

t('参加者は実行できない', () => {
  const e = env();
  eq(e.releaseToLeagueClub('A', { season_id: 's1', player_ids: ['u1'] }).ok, false);
});

report('releaseclub.js');
