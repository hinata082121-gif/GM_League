const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 移籍の一括承認。100件を超えても1回で承認できるようにする。

const CONFIG = { squad_min: 0, squad_max: 999, special_w1: 250000000, seller_rate_normal: 0.9 };

function market(budgetB) {
  const e = env(CONFIG);
  const rows = e.__rows('Seasons');
  const col = rows[0];
  rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's1')[col.indexOf('status')] = '移籍市場1';
  e.__dropCache('Seasons');
  e.__addRow('BudgetTx', { tx_id: 'bt_b', season_id: 's1', team_id: 't_B', amount: budgetB || 2000000000, reason: '初期予算', created_at: new Date() });
  for (let i = 1; i <= 5; i++) {
    e.__addRow('Players', { player_id: 'p_' + i, name: '選手' + i, position: 'MF', eligible: true });
    e.__addRow('Rosters', {
      roster_id: 'rs_' + i, season_id: 's1', team_id: 't_A', player_id: 'p_' + i,
      status: '在籍', acquisition_type: '初期', acquired_cost: 0, acquired_at: new Date(), expires_season: '',
    });
  }
  return e;
}

const req = (e, pid, method, fee) =>
  e.requestTransfer('B', { season_id: 's1', to_team: 't_B', player_id: pid, method, gross_fee: fee });

const statusOf = (e, id) => {
  const rows = e.__rows('Transfers'); const col = rows[0];
  return rows.slice(1).find((r) => r[col.indexOf('transfer_id')] === id)[col.indexOf('status')];
};
const activeOf = (e, team) => {
  const rows = e.__rows('Rosters'); const col = rows[0];
  return rows.slice(1).filter((r) => r[col.indexOf('team_id')] === team && r[col.indexOf('status')] === '在籍')
    .map((r) => r[col.indexOf('player_id')]).sort();
};
const balance = (e, team) => {
  const rows = e.__rows('BudgetTx'); const col = rows[0];
  return rows.slice(1).filter((r) => r[col.indexOf('team_id')] === team)
    .reduce((a, r) => a + Number(r[col.indexOf('amount')]), 0);
};

t('主催者承認待ちをまとめて承認できる', () => {
  const e = market();
  const ids = ['p_1', 'p_2', 'p_3'].map((p) => req(e, p, '特別').data.transfer_id);
  const r = e.approveTransfers('ORG', { transfer_ids: ids });
  eq(r.ok, true, r.error);
  eq(r.data.approved_count, 3);
  eq(r.data.failed_count, 0);
  ids.forEach((id) => eq(statusOf(e, id), '承認'));
  eq(activeOf(e, 't_B'), ['p_1', 'p_2', 'p_3']);
  eq(activeOf(e, 't_A'), ['p_4', 'p_5']);
  eq(balance(e, 't_B'), 2000000000 - 750000000);
});

t('1件ずつ承認したときと同じ結果になる（売り手の受取も入る）', () => {
  const a = market(); const b = market();
  [a, b].forEach((e) => {
    const id = req(e, 'p_1', '完全移籍', 100000000).data.transfer_id;
    e.respondTransfer('A', { transfer_id: id, agree: true });
  });
  const idA = a.__rows('Transfers')[1][0];
  const idB = b.__rows('Transfers')[1][0];
  a.approveTransfer('ORG', { transfer_id: idA });
  b.approveTransfers('ORG', { transfer_ids: [idB] });
  eq(balance(b, 't_A'), balance(a, 't_A'));
  eq(balance(b, 't_B'), balance(a, 't_B'));
  eq(balance(b, 't_A'), 90000000);
  eq(activeOf(b, 't_B'), activeOf(a, 't_B'));
});

t('all_pending でシーズンの主催者承認待ちをすべて承認する', () => {
  const e = market();
  ['p_1', 'p_2'].forEach((p) => req(e, p, '特別'));
  const seller = req(e, 'p_3', '完全移籍', 100000000).data.transfer_id;  // 売り手承認待ちは対象外
  const r = e.approveTransfers('ORG', { season_id: 's1', all_pending: true });
  eq(r.data.approved_count, 2);
  eq(statusOf(e, seller), '売り手承認待ち');
});

t('予算が足りない申請は飛ばし、古い申請から承認する', () => {
  const e = market(600000000);
  const first = req(e, 'p_1', '特別').data.transfer_id;
  const second = req(e, 'p_2', '特別').data.transfer_id;
  // 申請後に罰金で残高が減った
  e.__addRow('BudgetTx', { tx_id: 'bt_pen', season_id: 's1', team_id: 't_B', amount: -200000000, reason: '罰金', created_at: new Date() });
  const r = e.approveTransfers('ORG', { transfer_ids: [second, first] });
  eq(r.data.approved_count, 1);
  eq(r.data.approved[0].transfer_id, first, '先に出した申請が優先');
  eq(r.data.failed[0].transfer_id, second);
  ok(r.data.failed[0].reason.includes('予算'), r.data.failed[0].reason);
  eq(statusOf(e, second), '主催者承認待ち', '失敗したものは残る');
});

t('売り手承認待ちや処理済みは理由つきで飛ばす', () => {
  const e = market();
  const s = req(e, 'p_1', '完全移籍', 100000000).data.transfer_id;
  const r = e.approveTransfers('ORG', { transfer_ids: [s, 'tr_none'] });
  eq(r.data.approved_count, 0);
  eq(r.data.failed_count, 2);
});

t('一括承認は主催者のみ', () => {
  const e = market();
  const id = req(e, 'p_1', '特別').data.transfer_id;
  eq(e.approveTransfers('B', { transfer_ids: [id] }).ok, false);
});

t('120件でも1回で承認できる', () => {
  const e = market(100000000000);
  for (let i = 6; i <= 125; i++) {
    e.__addRow('Players', { player_id: 'p_' + i, name: '選手' + i, position: 'MF', eligible: true });
    e.__addRow('Rosters', { roster_id: 'rs_' + i, season_id: 's1', team_id: 't_A', player_id: 'p_' + i, status: '在籍', acquisition_type: '初期', acquired_cost: 0 });
  }
  e.__dropCache && e.__dropCache('Players');
  e.__dropCache && e.__dropCache('Rosters');
  let n = 0;
  for (let i = 6; i <= 125; i++) if (req(e, 'p_' + i, '特別').ok) n++;
  eq(n, 120);
  const r = e.approveTransfers('ORG', { season_id: 's1', all_pending: true });
  eq(r.data.approved_count, 120);
  eq(activeOf(e, 't_B').length, 120);
});

report('bulkapprove.js');
