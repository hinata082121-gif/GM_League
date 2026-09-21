const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 移籍ログ（getTransferLog）。
//
// 「移籍」タブの一覧と違い、リーグ全体の成立済み移籍を全員に同じ形で見せる。
// そのぶん、承認前のものが混ざらないことと、交渉の中身が漏れないことが要件になる。

/** 移籍を1件仕込む */
function addTx(e, over) {
  const base = {
    transfer_id: 'tr_' + Math.random().toString(36).slice(2, 8),
    season_id: 's1', window: 1, player_id: 'p_1',
    from_team: 't_A', to_team: 't_B', method: '完全移籍',
    gross_fee: 100000000, cost_to_buyer: 100000000, payout_to_seller: 90000000,
    registered_at: new Date('2026-10-01T10:00:00Z'), status: '承認',
  };
  e.__addRow('Transfers', Object.assign(base, over || {}));
  return e;
}

function base(e) {
  e.__addRow('Players', { player_id: 'p_1', name: '望月ヘンリー海輝', position: 'DF', eligible: true });
  e.__addRow('Players', { player_id: 'p_2', name: '中山雄太', position: 'DF', eligible: true });
  return e;
}

const log = (e, who) => e.getTransferLog(who || 'A', { season_id: 's1' });

// =============================================================================
// 載せる
// =============================================================================

t('承認済みの移籍が載る', () => {
  const e = addTx(base(env()));
  const r = log(e);

  eq(r.ok, true, r.error);
  eq(r.data.rows.length, 1);
  eq(r.data.rows[0].player_name, '望月ヘンリー海輝');
  eq(r.data.rows[0].from_team_name, 'チームA');
  eq(r.data.rows[0].to_team_name, 'チームB');
  eq(r.data.rows[0].amount, 100000000);
  eq(r.data.rows[0].method, '完全移籍');
});

t('自チームと無関係の移籍も見える', () => {
  const e = addTx(base(env()), { from_team: 't_C', to_team: 't_D' });
  // D の移籍を A が見る。移籍タブの listTransfers では返らない範囲
  eq(log(e, 'A').data.rows.length, 1);
});

t('新しい順に並ぶ', () => {
  const e = base(env());
  addTx(e, { player_id: 'p_1', registered_at: new Date('2026-10-01T10:00:00Z') });
  addTx(e, { player_id: 'p_2', registered_at: new Date('2026-10-02T10:00:00Z') });

  const rows = log(e).data.rows;
  eq(rows[0].player_name, '中山雄太');
  eq(rows[1].player_name, '望月ヘンリー海輝');
});

t('オークションは移籍元を空で返す', () => {
  const e = addTx(base(env()), { method: 'オークション', from_team: '' });
  eq(log(e).data.rows[0].from_team_name, '');
});

t('主催者も同じものを見る', () => {
  const e = addTx(base(env()));
  eq(log(e, 'ORG').data.rows.length, 1);
});

// =============================================================================
// 載せない
// =============================================================================

t('承認前のものは載らない', () => {
  const e = base(env());
  addTx(e, { status: '主催者承認待ち' });
  addTx(e, { status: '売り手承認待ち' });
  addTx(e, { status: '差戻' });
  addTx(e, { status: '売り手拒否' });

  eq(log(e).data.rows.length, 0, '成立していない移籍は成立として読まれてはいけない');
});

t('他シーズンの移籍は混ざらない', () => {
  const e = addTx(base(env()), { season_id: 's2' });
  eq(log(e).data.rows.length, 0);
});

t('交渉の中身は返さない', () => {
  const e = addTx(base(env()));
  const keys = Object.keys(log(e).data.rows[0]);
  ok(keys.indexOf('payout_to_seller') === -1, '売り手の受取額は出さない: ' + keys.join(','));
  ok(keys.indexOf('gross_fee') === -1, '交渉額は出さない: ' + keys.join(','));
});

// =============================================================================
// 入口
// =============================================================================

t('ログインしていなければ拒否する', () => {
  const e = addTx(base(env()));
  eq(e.getTransferLog('', { season_id: 's1' }).ok, false);
});

t('season_id を省略しても返る', () => {
  const e = addTx(base(env()));
  const r = e.getTransferLog('A', {});
  eq(r.ok, true, r.error);
});

report('txlog.js');
