const { t, eq, ok, report } = require('./harness');
const { env, balance, eligibleOf, claimsOf } = require('./rt-fixture');

// ---- 対象の抽出 ------------------------------------------------------------

t('保有状況と補填額が一覧に出る', () => {
  const e = env();
  const d = e.getRealTransferTargets('ORG', { season_id: 's1' }).data;
  const p1 = d.players.find((p) => p.player_id === 'p1');
  eq(p1.owned, true);
  eq(p1.team_name, '鹿島アントラーズ');
  eq(p1.acquired_cost, 100000000);
  eq(p1.compensation, 80000000);
  eq(p1.compensable, true);
});

t('オークション獲得は補填対象外と分かる', () => {
  const e = env();
  const d = e.getRealTransferTargets('ORG', { season_id: 's1' }).data;
  const p2 = d.players.find((p) => p.player_id === 'p2');
  eq(p2.owned, true);
  eq(p2.compensable, false);
  eq(p2.compensation, 0);
});

t('獲得額0の選手も補填対象外', () => {
  const e = env();
  const d = e.getRealTransferTargets('ORG', { season_id: 's1' }).data;
  eq(d.players.find((p) => p.player_id === 'p3').compensable, false);
});

t('どこも保有していない選手は owned=false', () => {
  const e = env();
  const d = e.getRealTransferTargets('ORG', { season_id: 's1' }).data;
  const p4 = d.players.find((p) => p.player_id === 'p4');
  eq(p4.owned, false);
  eq(p4.compensation, 0);
});

t('キーワードで絞れる（名前・実クラブ両方）', () => {
  const e = env();
  eq(e.getRealTransferTargets('ORG', { season_id: 's1', keyword: 'エース' }).data.players.length, 1);
  eq(e.getRealTransferTargets('ORG', { season_id: 's1', keyword: '横浜' }).data.players.length, 1);
});

t('保有選手だけに絞れる', () => {
  const e = env();
  eq(e.getRealTransferTargets('ORG', { season_id: 's1', only_owned: true }).data.players.length, 3);
});

t('チームごとの在籍人数が返る', () => {
  const e = env();
  const d = e.getRealTransferTargets('ORG', { season_id: 's1' }).data;
  eq(d.teams.find((x) => x.team_id === 't_a').squad, 3);
  eq(d.teams.find((x) => x.team_id === 't_b').squad, 0);
});

t('一覧は主催者のみ', () => {
  const e = env();
  eq(e.getRealTransferTargets('A', { season_id: 's1' }).ok, false);
});

// ---- 反映 ------------------------------------------------------------------

t('反映すると eligible が false になる', () => {
  const e = env();
  eq(e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] }).ok, true);
  eq(eligibleOf(e, 'p1'), false);
});

t('補填の請求が立つが、この時点では入金しない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  eq(claimsOf(e).length, 1);
  eq(claimsOf(e)[0][7], 80000000);   // refund_amount
  eq(claimsOf(e)[0][10], '選択待ち');
  eq(balance(e, 't_a'), 0);
});

t('補填の合計が返る', () => {
  const e = env();
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1','p2','p3'] });
  eq(r.data.total_amount, 80000000);
  eq(r.data.applied_count, 3);
  eq(r.data.compensations.length, 1);
});

t('オークション選手は請求が立たないが対象外にはなる', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p2'] });
  eq(eligibleOf(e, 'p2'), false);
  eq(claimsOf(e).length, 0);
});

t('無所属の選手は補填なしで対象外になる', () => {
  const e = env();
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p4'] });
  eq(r.ok, true);
  eq(eligibleOf(e, 'p4'), false);
  eq(r.data.total_amount, 0);
  ok(r.data.applied[0].reason.includes('保有していない'), r.data.applied[0].reason);
});

t('今シーズンのスカッドは減らない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  const d = e.getRealTransferTargets('ORG', { season_id: 's1' }).data;
  eq(d.teams.find((x) => x.team_id === 't_a').squad, 3);
});

t('二重に反映しても請求は1件だけ', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  eq(r.ok, true);
  eq(r.data.applied_count, 0);
  eq(r.data.skipped.length, 1);
  eq(claimsOf(e).length, 1);
});

t('同じ選手を重複指定しても1回だけ処理する', () => {
  const e = env();
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1','p1','p1'] });
  eq(r.data.applied_count, 1);
  eq(claimsOf(e).length, 1);
});

t('存在しない選手は skipped に入るだけ', () => {
  const e = env();
  const r = e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1','nope'] });
  eq(r.ok, true);
  eq(r.data.applied_count, 1);
  eq(r.data.skipped.length, 1);
});

t('選手未指定は拒否', () => {
  const e = env();
  eq(e.applyRealTransfers('ORG', { season_id: 's1', player_ids: [] }).ok, false);
});

t('反映は主催者のみ', () => {
  const e = env();
  eq(e.applyRealTransfers('A', { season_id: 's1', player_ids: ['p1'] }).ok, false);
  eq(eligibleOf(e, 'p1'), true);
});

// ---- 翌シーズンから離脱 ----------------------------------------------------

t('対象外の選手は翌シーズンへ引き継がれない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.ok, true);
  const next = e.__rows('Rosters').slice(1).filter((row) => row[1] === 's2');
  eq(next.length, 2);
  ok(!next.some((row) => row[3] === 'p1'), 'p1 が引き継がれてしまった');
});

t('落とした選手が終了レポートに出る', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.dropped_ineligible.length, 1);
  eq(r.data.report.dropped_ineligible[0].name, 'エース');
  eq(r.data.report.carried, 2);
});

t('対象外にしていない選手は普通に引き継がれる', () => {
  const e = env();
  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.carried, 3);
  eq(r.data.report.dropped_ineligible.length, 0);
});

t('今シーズンの在籍記録は残る', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  const cur = e.__rows('Rosters').slice(1).filter((r) => r[1] === 's1' && r[3] === 'p1');
  eq(cur.length, 1);
  eq(cur[0][4], '在籍');
});

// ---- 移籍からの除外 --------------------------------------------------------

t('対象外の選手は移籍候補に出ない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  e.__rows('Seasons')[1][2] = '移籍市場1';
  const res = e.getTransferOptions('A', { season_id: 's1', team_id: 't_b' });
  eq(res.ok, true);
  const all = res.data.targets.concat(res.data.free_agents);
  ok(!all.some((p) => p.player_id === 'p1'), '対象外の選手が候補に出ている');
  ok(all.some((p) => p.player_id === 'p4'), '通常の選手まで消えている');
});

t('対象外の選手は移籍申請できない', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p4'] });
  e.__rows('Seasons')[1][2] = '移籍市場1';
  const r = e.requestTransfer('ORG', {
    season_id: 's1', to_team: 't_b', player_id: 'p4',
    method: '完全移籍', gross_fee: 10000000,
  });
  eq(r.ok, false);
  ok(r.error.includes('大会対象外'), r.error);
});

// ---- 復帰 ------------------------------------------------------------------

t('誤って外した選手を戻せる', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  eq(e.restorePlayerEligible('ORG', { player_id: 'p1' }).ok, true);
  eq(eligibleOf(e, 'p1'), true);
});

t('戻しても補填の請求は残る', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  e.restorePlayerEligible('ORG', { player_id: 'p1' });
  eq(claimsOf(e).length, 1);
  eq(claimsOf(e)[0][10], '選択待ち');
});

t('対象になっている選手は戻せない', () => {
  const e = env();
  eq(e.restorePlayerEligible('ORG', { player_id: 'p1' }).ok, false);
});

t('復帰は主催者のみ', () => {
  const e = env();
  e.applyRealTransfers('ORG', { season_id: 's1', player_ids: ['p1'] });
  eq(e.restorePlayerEligible('A', { player_id: 'p1' }).ok, false);
});

report('realtransfer.js');
