const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 移籍市場の最終日。
//
//   特別・無効化特別 — 最終日の 23:00 で終了。22:00〜23:00 は値下げ
//   市場全体         — 日付が変わった瞬間に完全閉鎖（新規の獲得申請は受けない）
//   同意・承認       — 閉鎖後も翌日中は可能
//
// 開幕 9/30、3日間なので最終日は 10/2。

const CONFIG = {
  squad_min: 0, squad_max: 99,
  special_w1: 250000000,
  special_w1_discount: 200000000,
  override_w1: 350000000,
  seller_rate_normal: 0.9,
  seller_rate_override: 0.7,
  market_days: 3,
};

const at = (d, h, m, s) => new Date(2026, 9, d, h, m || 0, s || 0);

/** 移籍市場1・開幕 9/30。A が p_1 を持ち、B が獲得側 */
function market(over, status) {
  const e = env(Object.assign({}, CONFIG, over || {}));

  const rows = e.__rows('Seasons');
  const col = rows[0];
  const s1 = rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's1');
  s1[col.indexOf('status')] = status || '移籍市場1';
  s1[col.indexOf('window1_open_at')] = new Date(2026, 8, 30, 0, 30, 0);
  e.__dropCache('Seasons');

  e.__addRow('BudgetTx', {
    tx_id: 'bt_1', season_id: 's1', team_id: 't_B',
    amount: 2000000000, reason: '初期予算', created_at: new Date(),
  });
  e.__addRow('Players', { player_id: 'p_1', name: '望月ヘンリー海輝', position: 'DF', eligible: true });
  e.__addRow('Rosters', {
    roster_id: 'rs_1', season_id: 's1', team_id: 't_A', player_id: 'p_1',
    status: '在籍', acquisition_type: '初期', acquired_cost: 0, acquired_at: new Date(), expires_season: '',
  });
  return e;
}

const apply = (e, method, fee) =>
  e.requestTransfer('B', { season_id: 's1', to_team: 't_B', player_id: 'p_1', method, gross_fee: fee });

const when = (e, d, h, m, s) => { e.now = () => at(d, h, m, s); return e; };

// =============================================================================
// 特別ルール
// =============================================================================

t('最終日の21:59は通常価格', () => {
  const e = when(market(), 2, 21, 59, 59);
  const r = apply(e, '特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 250000000);
  eq(r.data.discounted, false);
});

t('最終日の22:00から値下げされる', () => {
  const e = when(market(), 2, 22, 0, 0);
  const r = apply(e, '特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 200000000);
  eq(r.data.discounted, true);
});

t('最終日の22:59:59までは値下げのまま受け付ける', () => {
  const e = when(market(), 2, 22, 59, 59);
  const r = apply(e, '特別');
  eq(r.ok, true, r.error);
  eq(r.data.discounted, true);
});

t('最終日の23:00:00で特別は受け付けない', () => {
  const e = when(market(), 2, 23, 0, 0);
  const r = apply(e, '特別');
  eq(r.ok, false);
  ok(r.error.includes('23:00'), r.error);
  eq(e.__rows('Transfers').length, 1, '申請が作られていない');
});

t('最終日の前日の22:30に割引は効かない', () => {
  const e = when(market(), 1, 22, 30);
  const r = apply(e, '特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 250000000);
  eq(r.data.discounted, false);
});

// =============================================================================
// 無効化特別ルール
// =============================================================================

t('無効化特別も最終日の23:00で受け付けない', () => {
  const e = when(market(), 2, 23, 0, 0);
  const r = apply(e, '無効化特別');
  eq(r.ok, false);
  ok(r.error.includes('23:00'), r.error);
});

t('無効化特別は割引額を設定すると22:00〜23:00で値下げされる', () => {
  const e = when(market({ override_w1_discount: 300000000 }), 2, 22, 30);
  const r = apply(e, '無効化特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 300000000);
  eq(r.data.payout_to_seller, 210000000, '売り手は値下げ後の額の70%');
  eq(r.data.discounted, true);
});

t('無効化特別の割引額が未設定なら通常価格のまま', () => {
  const e = when(market(), 2, 22, 30);
  const r = apply(e, '無効化特別');
  eq(r.ok, true, r.error);
  eq(r.data.cost_to_buyer, 350000000);
  eq(r.data.discounted, false);
});

t('無効化特別の割引は22:00より前には効かない', () => {
  const e = when(market({ override_w1_discount: 300000000 }), 2, 21, 0);
  eq(apply(e, '無効化特別').data.cost_to_buyer, 350000000);
});

// =============================================================================
// 市場の閉鎖
// =============================================================================

t('最終日の23:00以降も、通常の移籍は日付が変わるまで申請できる', () => {
  const e = when(market(), 2, 23, 59, 59);
  const r = apply(e, '完全移籍', 100000000);
  eq(r.ok, true, r.error);
  eq(r.data.status, '売り手承認待ち');
});

t('日付が変わった瞬間に市場は完全に閉まる', () => {
  const e = when(market(), 3, 0, 0, 0);
  const r = apply(e, '完全移籍', 100000000);
  eq(r.ok, false);
  ok(r.error.includes('終了'), r.error);
  ok(r.error.includes('10月2日'), r.error);
  eq(e.__rows('Transfers').length, 1);
});

t('シーズンの状態が市場期間のままでも、日付が変われば申請できない', () => {
  const e = when(market(), 3, 12, 0);
  eq(apply(e, '完全移籍', 100000000).ok, false);
});

t('開幕日時が未設定なら、時刻では締め切らない（従来どおり状態だけで開閉）', () => {
  const e = env(Object.assign({}, CONFIG));
  const rows = e.__rows('Seasons');
  const col = rows[0];
  rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's1')[col.indexOf('status')] = '移籍市場1';
  e.__dropCache('Seasons');
  e.__addRow('BudgetTx', { tx_id: 'bt_1', season_id: 's1', team_id: 't_B', amount: 2000000000, reason: '初期予算', created_at: new Date() });
  e.__addRow('Players', { player_id: 'p_1', name: 'p', position: 'DF', eligible: true });
  e.__addRow('Rosters', { roster_id: 'rs_1', season_id: 's1', team_id: 't_A', player_id: 'p_1', status: '在籍', acquisition_type: '初期', acquired_cost: 0, acquired_at: new Date(), expires_season: '' });

  when(e, 3, 12, 0);
  eq(apply(e, '完全移籍', 100000000).ok, true);
});

t('オークションの登録は主催者の場外の結果なので、閉鎖後も止めない', () => {
  const e = when(market(), 3, 12, 0);
  e.__rows('Rosters').splice(1);       // p_1 をフリーにする
  e.__dropCache('Rosters');
  const r = e.registerAuction('ORG', { season_id: 's1', to_team: 't_B', player_id: 'p_1', gross_fee: 100000000 });
  eq(r.ok, true, r.error);
});

// =============================================================================
// 閉鎖後の同意・承認
// =============================================================================

t('閉鎖後の翌日でも、売り手は同意でき、主催者は承認できる', () => {
  const e = when(market(), 2, 23, 30);
  const r = apply(e, '完全移籍', 100000000);
  eq(r.ok, true, r.error);

  when(e, 3, 15, 0);                     // 日付が変わったあと
  const agree = e.respondTransfer('A', { transfer_id: r.data.transfer_id, agree: true });
  eq(agree.ok, true, agree.error);
  eq(agree.data.status, '主催者承認待ち');

  const done = e.approveTransfer('ORG', { transfer_id: r.data.transfer_id });
  eq(done.ok, true, done.error);
});

t('特別は売り手の同意なしで主催者承認待ちになり、翌日に承認できる', () => {
  const e = when(market(), 2, 22, 10);
  const r = apply(e, '特別');
  eq(r.data.status, '主催者承認待ち');

  when(e, 3, 9, 0);
  eq(e.approveTransfer('ORG', { transfer_id: r.data.transfer_id }).ok, true);
});

// =============================================================================
// 画面に返すもの
// =============================================================================

const options = (e) => e.getTransferOptions('B', { season_id: 's1' }).data;
const method = (d, name) => d.methods.filter((m) => m.method === name)[0];

t('23:00以降は特別・無効化特別だけが受付終了と返る', () => {
  const d = options(when(market(), 2, 23, 15));
  eq(d.market_open, true);
  eq(method(d, '特別').closed, true);
  eq(method(d, '無効化特別').closed, true);
  eq(method(d, '完全移籍').closed, false);
});

t('22:00〜23:00は割引中と返る', () => {
  const d = options(when(market({ override_w1_discount: 300000000 }), 2, 22, 30));
  eq(d.is_discount_time, true);
  eq(method(d, '特別').fixed_cost, 200000000);
  eq(method(d, '無効化特別').fixed_cost, 300000000);
  eq(method(d, '特別').closed, false);
});

t('日付が変わると市場は閉まったと返り、同意の期限も返る', () => {
  const d = options(when(market(), 3, 0, 5));
  eq(d.market_open, false);
  ok(d.market_closed_reason.includes('終了'), d.market_closed_reason);
  ok(d.response_until, '同意・承認の期限を返す');
});

// =============================================================================
// 移籍タブ
// =============================================================================

const tab = (e) => e.getUiState('A', { season_id: 's1' }).data.tabs.transfer;

t('閉鎖後もシーズンが市場期間のままならタブは残り、同意・承認の期限を伝える', () => {
  const x = tab(when(market(), 3, 10, 0));
  eq(x.open, true);
  ok(x.reason.includes('10月3日'), x.reason);
});

t('市場が終わって状態が進んでも、翌日いっぱいは同意のためにタブを残す', () => {
  const e = when(market({}, 'シーズン1'), 3, 20, 0);
  eq(tab(e).open, true);
});

t('翌々日になったらタブは消える', () => {
  const e = when(market({}, 'シーズン1'), 4, 0, 0);
  eq(tab(e).open, false);
});

t('市場の最終日までは普通に開いている', () => {
  const x = tab(when(market(), 2, 12, 0));
  eq(x.open, true);
  ok(x.reason.includes('第1次'), x.reason);
});

report('marketclose.js');
