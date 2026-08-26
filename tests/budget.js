const { t, eq, ok, report } = require('./harness');
const { env, squad } = require('./im-fixture');
const sp = require('./sp-fixture');

const bal = (e, sid, tid) => {
  let s = 0;
  e.__rows('BudgetTx').slice(1).forEach((r) => {
    if (r[2] === tid && r[1] === sid) s += Number(r[3]) || 0;
  });
  return s;
};

const rows = (e) => e.__rows('BudgetTx').slice(1);

// ---- 残高はシーズンごと ----------------------------------------------------

t('残高はシーズンをまたいで合算しない', () => {
  const e = env();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 64000000 });

  eq(e.getTeamBudget('ORG', { team_id: 't_A', season_id: 's1' }).data.balance, 29000000);
  eq(e.getTeamBudget('ORG', { team_id: 't_A', season_id: 's2' }).data.balance, 64000000);
});

t('シーズンを指定しなければ最新シーズンを見る', () => {
  const e = env();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 64000000 });

  eq(e.getTeamBudget('ORG', { team_id: 't_A' }).data.balance, 64000000);
});

t('自チーム画面の予算も最新シーズンだけ', () => {
  const e = env();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 64000000 });

  eq(e.getMyTeam('A', {}).data.budget.balance, 64000000);
});

// ---- シーズン終了時の手数料と繰越 ------------------------------------------

/** 手数料10%のシーズン環境 */
const feeEnv = () => sp.env({ season_end_fee_rate: 0.1 });

t('手数料の母数はそのシーズンの収支だけ', () => {
  const e = feeEnv();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });
  // 次シーズンに先に入った補填金。手数料の母数に含めてはいけない
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 64000000 });

  const r = e.closeSeason('ORG', { season_id: 's1' });
  eq(r.ok, true);

  const fee = r.data.report.fees.find((f) => f.team_id === 't_A');
  eq(fee.balance, 29000000);
  eq(fee.fee, 2900000);
});

t('繰越は前季マイナス・翌季プラスの2行で書く', () => {
  const e = feeEnv();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.ok, true);

  // 2900万 − 手数料290万 = 2610万
  const carried = r.data.report.carried_budget.find((c) => c.team_id === 't_A');
  eq(carried.amount, 26100000);

  eq(bal(e, 's1', 't_A'), 0);          // 前季は繰り出して0になる
  eq(bal(e, 's2', 't_A'), 26100000);   // 翌季に入る

  const reasons = rows(e).filter((x) => x[2] === 't_A').map((x) => x[4]);
  ok(reasons.indexOf('次シーズンへ繰越') !== -1, reasons.join(','));
  ok(reasons.indexOf('前シーズンからの繰越') !== -1, reasons.join(','));
});

t('翌季に先に入っていた分は繰越に足される', () => {
  const e = feeEnv();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });
  e.adjustBudget('ORG', { season_id: 's2', team_id: 't_A', amount: 64000000 });

  e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });

  // 補填6400万 + 繰越2610万
  eq(bal(e, 's2', 't_A'), 90100000);
});

t('マイナスの残高もそのまま繰り越す', () => {
  const e = feeEnv();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: -5000000 });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  // マイナスには手数料をかけない
  eq(r.data.report.fees.length, 0);
  eq(bal(e, 's2', 't_A'), -5000000);
});

t('引継ぎ先を指定しなければ繰り越さない', () => {
  const e = feeEnv();
  e.adjustBudget('ORG', { season_id: 's1', team_id: 't_A', amount: 29000000 });

  const r = e.closeSeason('ORG', { season_id: 's1' });
  eq(r.data.report.carried_budget, []);
  eq(bal(e, 's1', 't_A'), 26100000);   // 手数料だけ引かれて残る
  eq(bal(e, 's2', 't_A'), 0);
});

t('残高0のチームは繰越の行を作らない', () => {
  const e = feeEnv();
  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.carried_budget, []);
});

report('budget.js');
