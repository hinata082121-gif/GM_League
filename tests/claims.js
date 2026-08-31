const { t, eq, ok, report } = require('./harness');
const { env, balance, claimsOf, rostersOf, setDeadline } = require('./cl-fixture');

// ---- 請求が立つ ------------------------------------------------------------

t('現実移籍で保有チームに請求が立つ', () => {
  const e = env();
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  eq(r.ok, true);
  eq(claimsOf(e).length, 1);
  const c = claimsOf(e)[0];
  eq(c[2], 't_a');            // team_id
  eq(c[4], '大会外移籍');      // reason
  eq(c[7], 80000000);         // refund_amount 1億×80%
  eq(c[10], '選択待ち');       // status
});

t('請求が立った時点では入金しない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  eq(balance(e, 't_a'), 0);
});

t('獲得額0でも請求は立つ。ただし入れ替えのみ', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['k1'] });

  const c = claimsOf(e);
  eq(c.length, 1, '手放したのに何も受け取れないのはおかしい');

  const mine = e.getMyClaims('A', { season_id: 's1' }).data.claims;
  eq(mine.length, 1);
  eq(mine[0].refund_amount, 0);
});

t('獲得額0の請求は払い戻しを拒む', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['k1'] });
  const id = e.getMyClaims('A', { season_id: 's1' }).data.claims[0].claim_id;

  const r = e.chooseClaim('A', { claim_id: id, choice: '払い戻し' });
  eq(r.ok, false);
  ok(r.error.indexOf('0円') !== -1, r.error);
});

t('獲得額0の請求は swap_only で返る', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['k1'] });

  const mine = e.getMyClaims('A', { season_id: 's1' }).data.claims;
  eq(mine.filter((c) => c.swap_only).length, 1);
});

t('同じ選手で二重に請求は立たない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  e.__rows('Players').slice(1).find((p) => p[0] === 'u1')[4] = true;  // 手で戻す
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  eq(claimsOf(e).length, 1);
});

// ---- 辞退 ------------------------------------------------------------------

t('辞退でそのクラブの選手が全員対象外になる', () => {
  const e = env();
  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: '辞退' });
  eq(r.ok, true);
  eq(r.data.ineligible, 4);   // u1..u4
  const players = e.__rows('Players').slice(1);
  eq(players.filter((p) => p[3] === '浦和レッズ' && p[4] === true).length, 0);
  eq(players.filter((p) => p[3] === '鹿島アントラーズ' && p[4] === true).length, 4);
});

t('辞退で他チームの保有分に90%の請求が立つ', () => {
  const e = env();
  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: '辞退' });
  eq(r.data.claims.length, 1);
  eq(r.data.claims[0].team_id, 't_a');
  eq(r.data.claims[0].amount, 90000000);   // 1億 × 90%
  eq(claimsOf(e)[0][4], '辞退');
});

t('辞退した本人には請求を立てない', () => {
  const e = env();
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: '辞退' });
  eq(claimsOf(e).filter((c) => c[2] === 't_b').length, 0);
});

t('辞退するとチームが非アクティブになりスカッドが離脱する', () => {
  const e = env();
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: '辞退' });
  const team = e.__rows('Teams').slice(1).find((x) => x[0] === 't_b');
  eq(team[4], false);
  eq(rostersOf(e, 's1', 't_b').length, 0);
});

t('辞退で他チームのスカッドは減らない', () => {
  const e = env();
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: '辞退' });
  eq(rostersOf(e, 's1', 't_a').length, 3);
});

// ---- チーム変更 ------------------------------------------------------------

t('チーム変更でクラブ名が変わる', () => {
  const e = env();
  const r = e.withdrawTeam('ORG', {
    season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ',
  });
  eq(r.ok, true);
  const team = e.__rows('Teams').slice(1).find((x) => x[0] === 't_b');
  eq(team[1], '川崎フロンターレ');
  eq(team[4], true);   // active のまま
});

t('チーム変更でも旧クラブの選手は対象外になる', () => {
  const e = env();
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(e.__rows('Players').slice(1).filter((p) => p[3] === '浦和レッズ' && p[4] === true).length, 0);
});

t('チーム変更ではスカッドを全員手放す', () => {
  const e = env();
  // B に他クラブの選手を1人持たせておく
  e.__addRow('Rosters', { roster_id: 'r6', season_id: 's1', team_id: 't_b', player_id: 'k3', status: '在籍', acquisition_type: '完全移籍', acquired_cost: 50000000 });
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(rostersOf(e, 's1', 't_b').length, 0);
});

t('チーム変更で kind が新規に戻る', () => {
  const e = env();
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  const team = e.__rows('Teams').slice(1).find((x) => x[0] === 't_b');
  eq(team[3], '新規');
});

t('チーム変更で予算が初期値に戻る', () => {
  const e = env();
  e.__addRow('BudgetTx', { tx_id: 'tx1', season_id: 's1', team_id: 't_b', amount: 500000000, reason: 'スポンサー収益' });
  e.__addRow('BudgetTx', { tx_id: 'tx2', season_id: 's1', team_id: 't_b', amount: -120000000, reason: '移籍金支出' });
  eq(balance(e, 't_b'), 380000000);

  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(r.data.reset.budget_before, 380000000);
  eq(r.data.reset.budget_after, 0);
  eq(balance(e, 't_b'), 0);
});

t('初期予算を設定すればその額から始まる', () => {
  const e = env({ new_team_initial_budget: 300000000 });
  e.__addRow('BudgetTx', { tx_id: 'tx1', season_id: 's1', team_id: 't_b', amount: 500000000, reason: 'スポンサー収益' });
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(balance(e, 't_b'), 300000000);
});

t('リセットの履歴が予算に残る', () => {
  const e = env();
  e.__addRow('BudgetTx', { tx_id: 'tx1', season_id: 's1', team_id: 't_b', amount: 500000000, reason: 'スポンサー収益' });
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  const tx = e.__rows('BudgetTx').slice(1).filter((r) => r[4] === 'チーム変更リセット');
  eq(tx.length, 1);
  eq(Number(tx[0][3]), -500000000);
});

t('予算が0ならリセット取引は作らない', () => {
  const e = env();
  e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(e.__rows('BudgetTx').slice(1).filter((r) => r[4] === 'チーム変更リセット').length, 0);
});

t('チーム変更でプロテクトとエントリーが消える', () => {
  const e = env();
  e.__addRow('Protections', { protection_id: 'pr1', season_id: 's1', team_id: 't_b', player_id: 'u2', window: 1, slot: 1, fee: 30000000 });
  e.__addRow('EntryLists', { entry_id: 'en1', season_id: 's1', team_id: 't_b', status: '承認' });

  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(r.data.reset.protections, 1);
  eq(r.data.reset.entries, 1);
  eq(e.__rows('Protections').length, 1);   // ヘッダーのみ
  eq(e.__rows('EntryLists').length, 1);
});

t('チーム変更で進行中の移籍申請が差戻になる', () => {
  const e = env();
  e.__addRow('Transfers', { transfer_id: 'tr1', season_id: 's1', player_id: 'k4', to_team: 't_b', method: '完全移籍', status: '主催者承認待ち' });
  e.__addRow('Transfers', { transfer_id: 'tr2', season_id: 's1', player_id: 'u1', from_team: 't_b', to_team: 't_a', method: '完全移籍', status: '承認' });

  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(r.data.reset.transfers, 1);

  const rows = e.__rows('Transfers').slice(1);
  eq(rows.find((x) => x[0] === 'tr1')[11], '差戻');
  eq(rows.find((x) => x[0] === 'tr2')[11], '承認');   // 承認済みは触らない
});

t('チーム変更で本人の未精算の請求が無効になる', () => {
  const e = env();
  // B が有償で持っている選手を現実移籍で失い、請求が立った状態を作る
  e.__addRow('Rosters', { roster_id: 'r9', season_id: 's1', team_id: 't_b', player_id: 'k4', status: '在籍', acquisition_type: '完全移籍', acquired_cost: 80000000 });
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['k4'] });
  eq(claimsOf(e).filter((c) => c[2] === 't_b' && c[10] === '選択待ち').length, 1);

  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(r.data.reset.claims, 1);
  eq(claimsOf(e).filter((c) => c[2] === 't_b' && c[10] === '無効').length, 1);
});

t('チーム変更しても他チームへの請求は残る', () => {
  const e = env();
  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '川崎フロンターレ' });
  eq(r.data.claims.length, 1);
  eq(claimsOf(e).filter((c) => c[2] === 't_a' && c[10] === '選択待ち').length, 1);
});

t('辞退では予算をリセットしない', () => {
  const e = env();
  e.__addRow('BudgetTx', { tx_id: 'tx1', season_id: 's1', team_id: 't_b', amount: 500000000, reason: 'スポンサー収益' });
  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: '辞退' });
  eq(r.data.reset, null);
  eq(balance(e, 't_b'), 500000000);
});

t('使用中のクラブへは変更できない', () => {
  const e = env();
  const r = e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '鹿島アントラーズ' });
  eq(r.ok, false);
  ok(r.error.includes('登録済み'), r.error);
});

t('同じクラブへは変更できない', () => {
  const e = env();
  eq(e.withdrawTeam('ORG', { season_id: 's1', team_id: 't_b', kind: 'チーム変更', new_club: '浦和レッズ' }).ok, false);
});

t('辞退・チーム変更は主催者のみ', () => {
  const e = env();
  eq(e.withdrawTeam('A', { season_id: 's1', team_id: 't_b', kind: '辞退' }).ok, false);
});

// ---- 参加者の選択 ----------------------------------------------------------

function withClaim(over) {
  const e = env(over);
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1'] });
  return { e, claimId: claimsOf(e)[0][0] };
}

t('自分の請求が見える', () => {
  const { e } = withClaim();
  const d = e.getMyClaims('A', { season_id: 's1' }).data;
  eq(d.claims.length, 1);
  eq(d.pending_count, 1);
  eq(d.claims[0].refund_amount, 80000000);
});

t('入れ替え候補は自クラブの空き選手だけ', () => {
  const { e } = withClaim();
  const d = e.getMyClaims('A', { season_id: 's1' }).data;
  // 鹿島は k1..k4。k1,k2 は保有中なので k3,k4 が候補
  eq(d.candidates.map((c) => c.player_id).sort(), ['k3','k4']);
});

t('他チームの請求は見えない', () => {
  const { e } = withClaim();
  eq(e.getMyClaims('B', { season_id: 's1' }).data.claims.length, 0);
});

t('払い戻しを選べる', () => {
  const { e, claimId } = withClaim();
  const r = e.chooseClaim('A', { claim_id: claimId, choice: '払い戻し' });
  eq(r.ok, true);
  eq(claimsOf(e)[0][8], '払い戻し');
  eq(claimsOf(e)[0][10], '確定');
});

t('選んだだけでは入金されない', () => {
  const { e, claimId } = withClaim();
  e.chooseClaim('A', { claim_id: claimId, choice: '払い戻し' });
  eq(balance(e, 't_a'), 0);
});

t('入れ替えを選べる', () => {
  const { e, claimId } = withClaim();
  const r = e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え', replacement_player_id: 'k3' });
  eq(r.ok, true);
  eq(claimsOf(e)[0][9], 'k3');
});

t('入れ替え先を指定しないと拒否', () => {
  const { e, claimId } = withClaim();
  eq(e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え' }).ok, false);
});

t('他クラブの選手とは入れ替えられない', () => {
  const { e, claimId } = withClaim();
  const r = e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え', replacement_player_id: 'u4' });
  eq(r.ok, false);
  ok(r.error.includes('入れ替えに使えません'), r.error);
});

t('保有済みの選手とは入れ替えられない', () => {
  const { e, claimId } = withClaim();
  eq(e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え', replacement_player_id: 'k1' }).ok, false);
});

t('他人の請求は選べない', () => {
  const { e, claimId } = withClaim();
  eq(e.chooseClaim('B', { claim_id: claimId, choice: '払い戻し' }).ok, false);
});

t('選び直せる（入れ替え → 払い戻しで予約が解放される）', () => {
  const { e, claimId } = withClaim();
  e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え', replacement_player_id: 'k3' });
  e.chooseClaim('A', { claim_id: claimId, choice: '払い戻し' });
  eq(claimsOf(e)[0][9], '');
  const d = e.getMyClaims('A', { season_id: 's1' }).data;
  ok(d.candidates.some((c) => c.player_id === 'k3'), 'k3 が候補に戻っていない');
});

t('同じ選手を2つの請求で予約できない', () => {
  const e = env();
  // A が2人失う: u1（1億）と、もう1人 k3 を有償で持たせる
  e.__addRow('Rosters', { roster_id: 'r7', season_id: 's1', team_id: 't_a', player_id: 'u2', status: '在籍', acquisition_type: '完全移籍', acquired_cost: 50000000 });
  e.__rows('Rosters').slice(1).find((r) => r[0] === 'r4')[4] = '離脱';  // B の u2 を外す
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['u1','u2'] });

  const ids = claimsOf(e).map((c) => c[0]);
  eq(e.chooseClaim('A', { claim_id: ids[0], choice: '入れ替え', replacement_player_id: 'k3' }).ok, true);
  eq(e.chooseClaim('A', { claim_id: ids[1], choice: '入れ替え', replacement_player_id: 'k3' }).ok, false);
});

// ---- 期限 ------------------------------------------------------------------

t('期限を過ぎると参加者は選べない', () => {
  const { e, claimId } = withClaim();
  setDeadline(e, new Date(Date.now() - 86400000));
  const r = e.chooseClaim('A', { claim_id: claimId, choice: '払い戻し' });
  eq(r.ok, false);
  ok(r.error.includes('期限'), r.error);
});

t('期限内なら選べる', () => {
  const { e, claimId } = withClaim();
  setDeadline(e, new Date(Date.now() + 86400000));
  eq(e.chooseClaim('A', { claim_id: claimId, choice: '払い戻し' }).ok, true);
});

t('主催者は期限後でも代行できる', () => {
  const { e, claimId } = withClaim();
  setDeadline(e, new Date(Date.now() - 86400000));
  eq(e.overrideClaim('ORG', { claim_id: claimId, choice: '払い戻し' }).ok, true);
});

// ---- 精算 ------------------------------------------------------------------

t('期限内は精算できない', () => {
  const { e } = withClaim();
  setDeadline(e, new Date(Date.now() + 86400000));
  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.ok, false);
  ok(r.error.includes('期限内'), r.error);
});

t('期限後に精算すると入金される', () => {
  const { e, claimId } = withClaim();
  setDeadline(e, new Date(Date.now() + 86400000));
  e.chooseClaim('A', { claim_id: claimId, choice: '払い戻し' });
  setDeadline(e, new Date(Date.now() - 1000));

  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.refund_total, 80000000);
  eq(balance(e, 't_a'), 80000000);
  eq(claimsOf(e)[0][10], '精算済');
});

t('入れ替えを選ぶと選手がスカッドに入る', () => {
  const { e, claimId } = withClaim();
  setDeadline(e, new Date(Date.now() + 86400000));
  e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え', replacement_player_id: 'k3' });
  setDeadline(e, new Date(Date.now() - 1000));

  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.swaps.length, 1);
  eq(balance(e, 't_a'), 0);

  const roster = rostersOf(e, 's1', 't_a').find((x) => x[3] === 'k3');
  ok(roster, 'k3 がスカッドに入っていない');
  eq(roster[6], 0);   // acquired_cost は 0
});

t('未選択は既定（払い戻し）で精算される', () => {
  const { e } = withClaim();
  setDeadline(e, new Date(Date.now() - 1000));
  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.data.refunds.length, 1);
  eq(balance(e, 't_a'), 80000000);
});

t('既定を入れ替えにしても、指定が無ければ払い戻しに倒す', () => {
  const { e } = withClaim({ claim_default_choice: '入れ替え' });
  setDeadline(e, new Date(Date.now() - 1000));
  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.data.failed.length, 1);
  eq(balance(e, 't_a'), 80000000);
});

t('二重に精算しても入金は1回だけ', () => {
  const { e } = withClaim();
  setDeadline(e, new Date(Date.now() - 1000));
  e.settleClaims('ORG', { season_id: 's1' });
  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.data.settled_count, 0);
  eq(balance(e, 't_a'), 80000000);
});

t('精算後は選び直せない', () => {
  const { e, claimId } = withClaim();
  setDeadline(e, new Date(Date.now() - 1000));
  e.settleClaims('ORG', { season_id: 's1' });
  eq(e.chooseClaim('A', { claim_id: claimId, choice: '入れ替え', replacement_player_id: 'k3' }).ok, false);
});

t('精算は主催者のみ', () => {
  const { e } = withClaim();
  setDeadline(e, new Date(Date.now() - 1000));
  eq(e.settleClaims('A', { season_id: 's1' }).ok, false);
});

t('無効にした請求は精算されない', () => {
  const { e, claimId } = withClaim();
  e.voidClaim('ORG', { claim_id: claimId });
  setDeadline(e, new Date(Date.now() - 1000));
  const r = e.settleClaims('ORG', { season_id: 's1' });
  eq(r.data.settled_count, 0);
  eq(balance(e, 't_a'), 0);
});

t('主催者は請求一覧で状況を把握できる', () => {
  const { e, claimId } = withClaim();
  const before = e.listClaims('ORG', { season_id: 's1' }).data;
  eq(before.waiting, 1);
  eq(before.fixed, 0);

  e.overrideClaim('ORG', { claim_id: claimId, choice: '払い戻し' });
  const after = e.listClaims('ORG', { season_id: 's1' }).data;
  eq(after.waiting, 0);
  eq(after.fixed, 1);
  eq(after.claims[0].team_name, '鹿島アントラーズ');
});

// ---- エントリーの範囲 ------------------------------------------------------

t('エントリー候補は自クラブの選手だけ', () => {
  const e = env();
  e.__rows('Seasons')[1][2] = 'エントリー受付';
  e.__rows('Teams').slice(1).find((x) => x[0] === 't_a')[3] = '新規';
  const d = e.getEntryStatus('A', { season_id: 's1' }).data;
  ok(d.available.every((p) => p.real_club === '鹿島アントラーズ'), '他クラブが混ざっている');
  eq(d.my_club, '鹿島アントラーズ');
});

t('他クラブの選手を混ぜて提出すると拒否される', () => {
  const e = env();
  e.__rows('Seasons')[1][2] = 'エントリー受付';
  e.__rows('Teams').slice(1).find((x) => x[0] === 't_a')[3] = '新規';
  const r = e.submitEntryList('A', { season_id: 's1', team_id: 't_a', player_ids: ['k1','k2','u4'] });
  eq(r.ok, false);
  ok(r.error.includes('からのみ選べます'), r.error);
});

t('自クラブだけなら提出できる', () => {
  const e = env();
  e.__rows('Seasons')[1][2] = 'エントリー受付';
  e.__rows('Teams').slice(1).find((x) => x[0] === 't_a')[3] = '新規';
  const r = e.submitEntryList('A', { season_id: 's1', team_id: 't_a', player_ids: ['k1','k2','k3'] });
  eq(r.ok, true);
});

report('claims.js');
