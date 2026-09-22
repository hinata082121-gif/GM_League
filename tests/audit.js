const { t, eq, ok, report } = require('./harness');
const { env, claimsOf } = require('./cl-fixture');

// 現実クラブと保有の食い違いの点検。
//
// 現実移籍の反映は「誰を対象にするか」を主催者が選ぶので、選び漏れても
// 何も起きない。起きないことには気づけないため、点検する口を用意する。
//
// A=鹿島 が u1（浦和の選手・1億で獲得）と k1（自クラブ・0円）を持っている。

/** 新規参加のクラブを足す */
function addNewClub(e, name) {
  e.__addRow('Teams', { team_id: 't_n', name, owner_user_id: 'u_n', kind: '新規', active: true });
  e.__dropCache('Teams');
  return e;
}

/** 選手の現実クラブを付け替える */
function moveClub(e, playerId, club) {
  const rows = e.__rows('Players');
  const col = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.indexOf('player_id')] !== playerId) continue;
    rows[i][col.indexOf('real_club')] = club;
  }
  e.__dropCache('Players');
  return e;
}

/** 選手を大会対象外にする */
function makeIneligible(e, playerId) {
  const rows = e.__rows('Players');
  const col = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.indexOf('player_id')] !== playerId) continue;
    rows[i][col.indexOf('eligible')] = false;
  }
  e.__dropCache('Players');
  return e;
}

const audit = (e, who) => e.auditPlayerEligibility(who || 'ORG', { season_id: 's1' });

// =============================================================================
// 手放し漏れ
// =============================================================================

t('新規クラブへ移ったのに手放されていない選手を拾う', () => {
  const e = addNewClub(env(), '川崎フロンターレ');
  moveClub(e, 'u1', '川崎フロンターレ');

  const r = audit(e);
  eq(r.ok, true, r.error);
  eq(r.data.to_release.length, 1);
  eq(r.data.to_release[0].name, '浦和1');
  eq(r.data.to_release[0].held_by, '鹿島アントラーズ');
  eq(r.data.to_release[0].acquired_cost, 100000000);
  eq(r.data.clean, false);
});

t('手放した後は出てこない', () => {
  const e = addNewClub(env(), '川崎フロンターレ');
  moveClub(e, 'u1', '川崎フロンターレ');
  e.releaseToLeagueClub('ORG', { season_id: 's1', player_ids: ['u1'] });

  eq(audit(e).data.to_release.length, 0);
});

t('継続参加クラブへの移籍は拾わない', () => {
  // リーグ内の保有は現実の移籍とは別の話。手放す理由がない
  const e = env();
  moveClub(e, 'u1', '浦和レッズ');   // B=浦和 は継続参加

  eq(audit(e).data.to_release.length, 0);
});

t('誰も持っていない選手は拾わない', () => {
  const e = addNewClub(env(), '川崎フロンターレ');
  moveClub(e, 'u4', '川崎フロンターレ');   // u4 は在籍なし

  eq(audit(e).data.to_release.length, 0);
});

// =============================================================================
// 誤って対象外
// =============================================================================

t('参加クラブにいるのに対象外の選手を拾う', () => {
  // 名簿が未同期のまま反映を流すとこうなる
  const e = makeIneligible(env(), 'k1');   // k1 の現実クラブは鹿島（参加中）

  const r = audit(e);
  eq(r.data.wrongly_ineligible.length, 1);
  eq(r.data.wrongly_ineligible[0].name, '鹿島1');
  eq(r.data.wrongly_ineligible[0].held_by, '鹿島アントラーズ');
});

t('請求が立っていれば一緒に返す', () => {
  const e = env();
  moveClub(e, 'u1', '川崎フロンターレ');   // 反映した時点では大会外
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  moveClub(e, 'u1', '浦和レッズ');   // 後から名簿が入って参加クラブと判明

  const r = audit(e);
  eq(r.data.wrongly_ineligible.length, 1);
  ok(r.data.wrongly_ineligible[0].claim_id, '請求 ID を返す');
  eq(r.data.wrongly_ineligible[0].claim_status, '選択待ち');
});

t('本当に大会の外へ出た選手は拾わない', () => {
  const e = env();
  moveClub(e, 'u1', '川崎フロンターレ');   // 参加していないクラブ
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });

  eq(audit(e).data.wrongly_ineligible.length, 0);
});

t('問題が無ければ clean になる', () => {
  eq(audit(env()).data.clean, true);
});

t('参加者は点検できない', () => {
  eq(audit(env(), 'A').ok, false);
});

// =============================================================================
// 反映そのものを止める
// =============================================================================

t('参加クラブにいる選手は対象外にできない', () => {
  // 現実クラブが参加クラブなら大会の外へは出ていない。
  // 名簿が空のまま流して8名を巻き込んだ事故の再発防止
  const e = env();
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['k1'] });

  eq(r.ok, true, r.error);
  eq(r.data.applied.length, 0);
  ok(r.data.skipped[0].reason.indexOf('参加クラブです') !== -1, r.data.skipped[0].reason);
  eq(claimsOf(e).length, 0, '請求も立てない');
});

t('対象外にされずに eligible のまま残る', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['k1'] });

  const rows = e.__rows('Players');
  const col = rows[0];
  const p = rows.slice(1).find((x) => x[col.indexOf('player_id')] === 'k1');
  eq(p[col.indexOf('eligible')], true);
});

t('現実クラブが空なら従来どおり通す', () => {
  // 空は「参加クラブではない」なので、大会外へ出た扱いのまま
  const e = env();
  moveClub(e, 'u1', '');
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  eq(r.data.applied.length, 1);
});

report('audit.js');
