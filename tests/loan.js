const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

/**
 * A が B へ期限付きで貸した状態を作る。
 *
 * @param {string} method 半期期限付き / 全期期限付き
 */
function lend(e, method) {
  e.__addRow('Players', { player_id: 'p_1', name: '望月', position: 'DF', real_club: '', eligible: true });

  // 借りた側の在籍（今シーズンで期限切れ）
  e.__addRow('Rosters', {
    roster_id: 'rs_1', season_id: 's1', team_id: 't_B', player_id: 'p_1',
    status: '在籍', acquisition_type: method, acquired_cost: 5000000,
    acquired_at: new Date(), expires_season: 's1',
  });

  e.__addRow('Transfers', {
    transfer_id: 'tr_1', season_id: 's1', window: 1, player_id: 'p_1',
    from_team: 't_A', to_team: 't_B', method,
    gross_fee: 50000000, cost_to_buyer: 50000000, payout_to_seller: 5000000,
    registered_at: new Date(), status: '承認',
  });

  return e;
}

const rosters = (e, sid) => e.__rows('Rosters').slice(1).filter((r) => r[1] === sid);

t('期限が切れたら貸出元に戻る', () => {
  const e = lend(env(), '全期期限付き');
  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });

  eq(r.ok, true);
  eq(r.data.report.loans_returned.length, 1);
  eq(r.data.report.loans_returned[0].team_name, 'チームA');
  eq(r.data.report.loans_returned[0].player_name, '望月');

  const next = rosters(e, 's2').filter((x) => x[3] === 'p_1');
  eq(next.length, 1);
  eq(next[0][2], 't_A');      // 貸出元へ
  eq(next[0][4], '在籍');
});

t('半期期限付きも同じように戻る', () => {
  const e = lend(env(), '半期期限付き');
  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.loans_returned.length, 1);
});

t('戻すときの獲得額は0にする', () => {
  const e = lend(env(), '全期期限付き');
  e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });

  const back = rosters(e, 's2').find((x) => x[3] === 'p_1');
  eq(back[5], '初期');
  eq(Number(back[6]), 0);
  eq(back[8], '');           // 期限は空に戻す
});

t('借りた側には残らない', () => {
  const e = lend(env(), '全期期限付き');
  e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });

  const b = rosters(e, 's2').filter((x) => x[2] === 't_B' && x[3] === 'p_1');
  eq(b.length, 0);
  // 今シーズンの行は離脱として残る
  eq(rosters(e, 's1').find((x) => x[3] === 'p_1')[4], '離脱');
});

t('引継ぎ先を指定しなければ戻さない', () => {
  const e = lend(env(), '全期期限付き');
  const r = e.closeSeason('ORG', { season_id: 's1' });
  eq(r.data.report.loans_returned, []);
  eq(rosters(e, 's2').length, 0);
});

t('完全移籍は戻さない', () => {
  const e = env();
  e.__addRow('Players', { player_id: 'p_2', name: '尾谷', position: 'FW', eligible: true });
  e.__addRow('Rosters', {
    roster_id: 'rs_2', season_id: 's1', team_id: 't_B', player_id: 'p_2',
    status: '在籍', acquisition_type: '完全移籍', acquired_cost: 18000000,
    acquired_at: new Date(), expires_season: '',
  });
  e.__addRow('Transfers', {
    transfer_id: 'tr_2', season_id: 's1', window: 1, player_id: 'p_2',
    from_team: 't_A', to_team: 't_B', method: '完全移籍',
    gross_fee: 18000000, cost_to_buyer: 18000000, payout_to_seller: 16200000,
    registered_at: new Date(), status: '承認',
  });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.loans_returned, []);
  // 完全移籍は引継ぎで借りた側に残る
  eq(rosters(e, 's2').find((x) => x[3] === 'p_2')[2], 't_B');
});

t('貸出元が辞退していたら戻さない', () => {
  const e = lend(env(), '全期期限付き');
  e.updateRow('Teams', 'team_id', 't_A', { active: false });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.loans_returned, []);
});

t('移籍の記録が無ければ戻せない', () => {
  const e = env();
  e.__addRow('Players', { player_id: 'p_3', name: '取り込み選手', position: 'MF', eligible: true });
  e.__addRow('Rosters', {
    roster_id: 'rs_3', season_id: 's1', team_id: 't_B', player_id: 'p_3',
    status: '在籍', acquisition_type: '全期期限付き', acquired_cost: 1000000,
    acquired_at: new Date(), expires_season: 's1',
  });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.loans_returned, []);
});

t('承認前の移籍からは戻さない', () => {
  const e = lend(env(), '全期期限付き');
  e.updateRow('Transfers', 'transfer_id', 'tr_1', { status: '主催者承認待ち' });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.loans_returned, []);
});

t('次シーズンに既にいる選手は二重に作らない', () => {
  const e = lend(env(), '全期期限付き');
  e.__addRow('Rosters', {
    roster_id: 'rs_pre', season_id: 's2', team_id: 't_A', player_id: 'p_1',
    status: '在籍', acquisition_type: '初期', acquired_cost: 0,
    acquired_at: new Date(), expires_season: '',
  });

  const r = e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
  eq(r.data.report.loans_returned, []);
  eq(rosters(e, 's2').filter((x) => x[3] === 'p_1').length, 1);
});

report('loan.js');
