const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 特別ルール / 無効化特別ルールを使えない相手。
//
// 期限付き・オークションは当該シーズン限りの契約なので、そこから更に強奪できると
// 借りた側は代価を払ったまま一度も使えずに失う。特別で既に動いた選手を除くのは
// 強奪の連鎖を止めるため。プロテクトだけは無効化特別で破れる。

const CONFIG = {
  squad_min: 0, squad_max: 99,          // 人数の制約はここでは見ない
  special_w1: 250000000,
  override_w1: 350000000,
  seller_rate_override: 0.7,
};

/** 移籍市場1が開いた状態を作り、B に潤沢な予算を入れる */
function market(over) {
  const e = env(Object.assign({}, CONFIG, over || {}));

  const rows = e.__rows('Seasons');
  const col = rows[0];
  const s1 = rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's1');
  s1[col.indexOf('status')] = '移籍市場1';
  e.__dropCache('Seasons');

  e.__addRow('BudgetTx', {
    tx_id: 'bt_1', season_id: 's1', team_id: 't_B',
    amount: 2000000000, reason: '初期予算', created_at: new Date(),
  });

  e.__addRow('Players', { player_id: 'p_1', name: '望月ヘンリー海輝', position: 'DF', eligible: true });
  return e;
}

/** A の在籍として仕込む。acquisition_type で「どう獲得したか」を変える */
function heldByA(e, acquisitionType) {
  e.__addRow('Rosters', {
    roster_id: 'rs_1', season_id: 's1', team_id: 't_A', player_id: 'p_1',
    status: '在籍', acquisition_type: acquisitionType || '初期',
    acquired_cost: 0, acquired_at: new Date(), expires_season: '',
  });
  return e;
}

/** 承認済みの移籍履歴を足す（在籍は別に作る） */
function history(e, method) {
  e.__addRow('Transfers', {
    transfer_id: 'tr_h', season_id: 's1', window: 1, player_id: 'p_1',
    from_team: 't_C', to_team: 't_A', method,
    gross_fee: 100000000, cost_to_buyer: 100000000, payout_to_seller: 0,
    registered_at: new Date(), status: '承認',
  });
  return e;
}

const grab = (e, method) =>
  e.requestTransfer('B', { season_id: 's1', to_team: 't_B', player_id: 'p_1', method });

const protectP1 = (e) => {
  e.__addRow('Protections', {
    protection_id: 'pt_1', season_id: 's1', team_id: 't_A',
    player_id: 'p_1', window: 1, slot: '無料1', fee: 0,
  });
  return e;
};

// =============================================================================
// 通る場合
// =============================================================================

t('普通に在籍している選手は特別ルールで獲れる', () => {
  const e = heldByA(market());
  const r = grab(e, '特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 250000000);
  eq(r.data.payout_to_seller, 0);
});

t('完全移籍で動いた選手は特別ルールの対象になる', () => {
  const e = history(heldByA(market(), '完全移籍'), '完全移籍');
  eq(grab(e, '特別').ok, true, '交渉で動いた選手まで守ると市場が止まる');
});

t('無効化特別はプロテクトを破れる', () => {
  const e = protectP1(heldByA(market()));
  const r = grab(e, '無効化特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 350000000);
  eq(r.data.payout_to_seller, 245000000, '固定額の70%');
});

t('無効化特別はプロテクトされていない選手にも使える', () => {
  const e = heldByA(market());
  eq(grab(e, '無効化特別').ok, true, 'プロテクト破り専用ではない');
});

// =============================================================================
// 期限付き・オークション
// =============================================================================

['半期期限付き', '全期期限付き', 'オークション'].forEach((m) => {
  t(m + 'で動いた選手は特別ルールで獲れない', () => {
    const e = history(heldByA(market(), m), m);
    const r = grab(e, '特別');
    eq(r.ok, false);
    ok(r.error.indexOf('期限付き') !== -1, r.error);
  });

  t(m + 'で動いた選手は無効化特別でも獲れない', () => {
    const e = history(heldByA(market(), m), m);
    eq(grab(e, '無効化特別').ok, false, 'プロテクトと違い無効化では破れない');
  });
});

t('在籍の獲得形態だけでも弾く', () => {
  // 主催者が取り込みで直接入れた在籍には Transfers の履歴が無い
  const e = heldByA(market(), '全期期限付き');
  eq(grab(e, '特別').ok, false);
});

t('履歴だけでも弾く', () => {
  // 第1次でオークション、第2次の前に完全移籍で別チームへ、という経緯
  const e = history(heldByA(market(), '完全移籍'), 'オークション');
  eq(grab(e, '特別').ok, false, '上書きされても経緯は消えない');
});

// =============================================================================
// 特別で既に動いている
// =============================================================================

['特別', '無効化特別'].forEach((m) => {
  t(m + 'で動いた選手に特別ルールは使えない', () => {
    const e = history(heldByA(market(), m), m);
    const r = grab(e, '特別');
    eq(r.ok, false);
    ok(r.error.indexOf('二度は使えません') !== -1, r.error);
  });

  t(m + 'で動いた選手に無効化特別も使えない', () => {
    const e = history(heldByA(market(), m), m);
    eq(grab(e, '無効化特別').ok, false);
  });
});

t('承認前の特別ルールは履歴として数えない', () => {
  const e = heldByA(market());
  e.__addRow('Transfers', {
    transfer_id: 'tr_x', season_id: 's1', window: 1, player_id: 'p_1',
    from_team: 't_C', to_team: 't_D', method: '特別',
    gross_fee: 250000000, cost_to_buyer: 250000000, payout_to_seller: 0,
    registered_at: new Date(), status: '差戻',
  });
  eq(grab(e, '特別').ok, true, '差し戻された申請で選手が守られてはいけない');
});

t('前シーズンの特別ルールは今シーズンに持ち越さない', () => {
  const e = heldByA(market());
  e.__addRow('Transfers', {
    transfer_id: 'tr_y', season_id: 's0', window: 1, player_id: 'p_1',
    from_team: 't_C', to_team: 't_A', method: '特別',
    gross_fee: 250000000, cost_to_buyer: 250000000, payout_to_seller: 0,
    registered_at: new Date(), status: '承認',
  });
  eq(grab(e, '特別').ok, true);
});

// =============================================================================
// 画面に出す情報
// =============================================================================

t('獲得候補に理由が付く', () => {
  const e = history(heldByA(market(), '全期期限付き'), '全期期限付き');
  const d = e.getTransferOptions('B', { season_id: 's1' }).data;
  const target = d.targets.find((x) => x.player_id === 'p_1');

  eq(target.special_blocked, true);
  ok(target.special_reason.indexOf('期限付き') !== -1, target.special_reason);
});

t('獲れる選手には理由が付かない', () => {
  const e = heldByA(market());
  const d = e.getTransferOptions('B', { season_id: 's1' }).data;
  const target = d.targets.find((x) => x.player_id === 'p_1');

  eq(target.special_blocked, false);
  eq(target.special_reason, '');
});

report('special.js');
