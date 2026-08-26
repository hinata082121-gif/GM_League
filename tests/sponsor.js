const { t, eq, ok, report } = require('./harness');
const { env, addSponsor, balance, contracts, seedLeague, seedCup } = require('./sp-fixture');

// ---- 設定 ------------------------------------------------------------------

t('スポンサーを登録できる', () => {
  const e = env();
  const id = addSponsor(e);
  const d = e.listSponsors('ORG', { season_id: 's1' }).data;
  eq(d.sponsors.length, 1);
  eq(d.sponsors[0].sponsor_id, id);
  eq(d.sponsors[0].quota_label, 'リーグ戦 3位以内');
});

t('リーグ杯のノルマも設定できる', () => {
  const e = env();
  addSponsor(e, { quota_type: 'リーグ杯', quota_value: 'ベスト4以上' });
  eq(e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0].quota_label,
     'GMリーグ杯 ベスト4以上');
});

t('ノルマなしも作れる', () => {
  const e = env();
  addSponsor(e, { quota_type: 'なし', quota_value: '', penalty: 0 });
  eq(e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0].quota_label, 'ノルマなし');
});

t('ノルマなしに罰金は付けられない', () => {
  const e = env();
  const r = e.upsertSponsor('ORG', {
    season_id: 's1', name: 'x', contract_fee: 1, quota_type: 'なし', penalty: 100,
  });
  eq(r.ok, false);
});

t('リーグ杯のノルマは決まった値だけ', () => {
  const e = env();
  const r = e.upsertSponsor('ORG', {
    season_id: 's1', name: 'x', contract_fee: 1,
    quota_type: 'リーグ杯', quota_value: '3回戦進出', penalty: 1,
  });
  eq(r.ok, false);
});

t('順位のノルマは1以上', () => {
  const e = env();
  eq(e.upsertSponsor('ORG', {
    season_id: 's1', name: 'x', contract_fee: 1,
    quota_type: 'リーグ順位', quota_value: '0', penalty: 1,
  }).ok, false);
});

t('登録は主催者のみ', () => {
  const e = env();
  eq(e.upsertSponsor('A', { season_id: 's1', name: 'x', contract_fee: 1 }).ok, false);
});

t('契約されていなければ削除できる', () => {
  const e = env();
  const id = addSponsor(e);
  eq(e.deleteSponsor('ORG', { sponsor_id: id }).ok, true);
  eq(e.listSponsors('ORG', { season_id: 's1' }).data.sponsors.length, 0);
});

t('契約中は削除できない', () => {
  const e = env();
  const id = addSponsor(e);
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });
  const r = e.deleteSponsor('ORG', { sponsor_id: id });
  eq(r.ok, false);
  ok(r.error.includes('契約中'), r.error);
});

t('前シーズンから複製できる', () => {
  const e = env();
  addSponsor(e, { name: 'A社' });
  addSponsor(e, { name: 'B社', quota_type: 'なし', quota_value: '', penalty: 0 });

  const r = e.copySponsors('ORG', { from_season_id: 's1', to_season_id: 's2' });
  eq(r.ok, true);
  eq(r.data.copied, 2);
  eq(e.listSponsors('ORG', { season_id: 's2' }).data.sponsors.length, 2);
});

t('複製で同名は作らない', () => {
  const e = env();
  addSponsor(e, { name: 'A社' });
  e.copySponsors('ORG', { from_season_id: 's1', to_season_id: 's2' });
  const r = e.copySponsors('ORG', { from_season_id: 's1', to_season_id: 's2' });
  eq(r.data.copied, 0);
  eq(r.data.skipped, 1);
});

// ---- 契約 ------------------------------------------------------------------

t('契約すると契約金がその場で入る', () => {
  const e = env();
  const id = addSponsor(e, { contract_fee: 300000000 });
  const r = e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });
  eq(r.ok, true);
  eq(balance(e, 't_A'), 300000000);
  eq(e.__rows('BudgetTx')[1][4], 'スポンサー契約金');
});

t('同じスポンサーを何チームでも契約できる', () => {
  const e = env();
  const id = addSponsor(e);
  eq(e.chooseSponsor('A', { season_id: 's1', sponsor_id: id }).ok, true);
  eq(e.chooseSponsor('B', { season_id: 's1', sponsor_id: id }).ok, true);
  eq(e.chooseSponsor('C', { season_id: 's1', sponsor_id: id }).ok, true);
  eq(contracts(e).length, 3);
});

t('1チームは1社まで。変更すると前の契約金が戻る', () => {
  const e = env();
  const a = addSponsor(e, { name: 'A社', contract_fee: 300000000 });
  const b = addSponsor(e, { name: 'B社', contract_fee: 100000000 });

  e.chooseSponsor('A', { season_id: 's1', sponsor_id: a });
  eq(balance(e, 't_A'), 300000000);

  const r = e.chooseSponsor('A', { season_id: 's1', sponsor_id: b });
  eq(r.ok, true);
  eq(r.data.refunded, 300000000);
  eq(balance(e, 't_A'), 100000000);
  eq(contracts(e).length, 1);
});

t('返金と入金が別々に履歴に残る', () => {
  const e = env();
  const a = addSponsor(e, { name: 'A社', contract_fee: 300000000 });
  const b = addSponsor(e, { name: 'B社', contract_fee: 100000000 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: a });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: b });

  const tx = e.__rows('BudgetTx').slice(1).map((r) => Number(r[3]));
  eq(tx, [300000000, -300000000, 100000000]);
});

t('同じスポンサーを選び直すことはできない', () => {
  const e = env();
  const id = addSponsor(e);
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });
  eq(e.chooseSponsor('A', { season_id: 's1', sponsor_id: id }).ok, false);
});

t('受付停止中は契約できない', () => {
  const e = env({ sponsor_open: false });
  const id = addSponsor(e);
  const r = e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });
  eq(r.ok, false);
  ok(r.error.includes('受け付けていません'), r.error);
});

t('主催者は受付停止中でも代理で契約できる', () => {
  const e = env({ sponsor_open: false });
  const id = addSponsor(e);
  eq(e.chooseSponsor('ORG', { season_id: 's1', team_id: 't_A', sponsor_id: id }).ok, true);
});

t('他人のチームでは契約できない', () => {
  const e = env();
  const id = addSponsor(e);
  eq(e.chooseSponsor('A', { season_id: 's1', team_id: 't_B', sponsor_id: id }).ok, false);
});

t('使わない設定のスポンサーは選べない', () => {
  const e = env();
  const id = addSponsor(e, { active: false });
  eq(e.chooseSponsor('A', { season_id: 's1', sponsor_id: id }).ok, false);
});

t('未契約のチームが一覧で分かる', () => {
  const e = env();
  const id = addSponsor(e);
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });
  const d = e.listSponsors('ORG', { season_id: 's1' }).data;
  eq(d.uncontracted.length, 3);
  eq(d.sponsors[0].teams, ['チームA']);
});

t('主催者が契約を取り消すと契約金も戻る', () => {
  const e = env();
  const id = addSponsor(e, { contract_fee: 300000000 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });

  const cid = contracts(e)[0][0];
  const r = e.clearTeamSponsor('ORG', { contract_id: cid });
  eq(r.ok, true);
  eq(r.data.refunded, 300000000);
  eq(balance(e, 't_A'), 0);
  eq(contracts(e).length, 0);
});

// ---- ノルマ判定（リーグ順位） -----------------------------------------------

function closeWith(e) {
  return e.closeSeason('ORG', { season_id: 's1' });
}

t('順位ノルマを達成すれば罰金なし', () => {
  const e = env();
  seedLeague(e);
  const id = addSponsor(e, { quota_type: 'リーグ順位', quota_value: '3', penalty: 200000000, contract_fee: 0 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });   // A は1位

  const r = closeWith(e);
  eq(r.ok, true);
  const res = r.data.report.sponsor_results[0];
  eq(res.met, true);
  eq(res.actual, '1位');
  eq(res.penalty, 0);
});

t('順位ノルマ未達なら罰金が引かれる', () => {
  const e = env();
  seedLeague(e);
  const id = addSponsor(e, { quota_type: 'リーグ順位', quota_value: '3', penalty: 200000000, contract_fee: 0 });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: id });   // D は4位

  const r = closeWith(e);
  const res = r.data.report.sponsor_results[0];
  eq(res.met, false);
  eq(res.actual, '4位');
  eq(res.penalty, 200000000);
  eq(balance(e, 't_D'), -200000000);
});

t('罰金の理由が予算に残る', () => {
  const e = env();
  seedLeague(e);
  const id = addSponsor(e, { quota_value: '1', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('B', { season_id: 's1', sponsor_id: id });
  closeWith(e);

  const tx = e.__rows('BudgetTx').slice(1).find((r) => r[4] === 'スポンサーノルマ未達');
  ok(tx, '罰金の取引が無い');
  eq(Number(tx[3]), -100000000);
});

t('1試合も消化していないチームは未達', () => {
  const e = env();
  const id = addSponsor(e, { quota_value: '3', penalty: 50000000, contract_fee: 0 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });

  const res = closeWith(e).data.report.sponsor_results[0];
  eq(res.met, false);
  eq(res.actual, '順位なし');
});

t('ノルマなしは常に達成', () => {
  const e = env();
  const id = addSponsor(e, { quota_type: 'なし', quota_value: '', penalty: 0, contract_fee: 100000000 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });

  const res = closeWith(e).data.report.sponsor_results[0];
  eq(res.met, true);
  eq(balance(e, 't_A'), 100000000);
});

// ---- ノルマ判定（リーグ杯） -------------------------------------------------

t('優勝ノルマは優勝したチームだけ達成', () => {
  const e = env();
  seedCup(e, true);   // 決勝は A の勝ち
  const id = addSponsor(e, { quota_type: 'リーグ杯', quota_value: '優勝', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });
  e.chooseSponsor('B', { season_id: 's1', sponsor_id: id });

  const results = closeWith(e).data.report.sponsor_results;
  const a = results.find((r) => r.team_name === 'チームA');
  const b = results.find((r) => r.team_name === 'チームB');

  eq(a.met, true);
  eq(a.actual, '優勝');
  eq(b.met, false);
  eq(b.actual, '準優勝以上');
  eq(b.penalty, 100000000);
});

t('準優勝以上なら決勝進出で達成', () => {
  const e = env();
  seedCup(e, true);
  const id = addSponsor(e, { quota_type: 'リーグ杯', quota_value: '準優勝以上', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('B', { season_id: 's1', sponsor_id: id });

  const res = closeWith(e).data.report.sponsor_results[0];
  eq(res.met, true);
});

t('ベスト4以上なら準決勝敗退でも達成', () => {
  const e = env();
  seedCup(e, true);
  const id = addSponsor(e, { quota_type: 'リーグ杯', quota_value: 'ベスト4以上', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('C', { season_id: 's1', sponsor_id: id });   // C は準決勝敗退

  const res = closeWith(e).data.report.sponsor_results[0];
  eq(res.met, true);
  eq(res.actual, 'ベスト4以上');
});

t('ベスト4に届かなければ未達', () => {
  const e = env();
  seedCup(e, true);
  // E相当のチームは居ないので、杯に出ていない扱いのチームで確認
  e.__addRow('Teams', { team_id: 't_E', name: 'チームE', owner_user_id: 'u_E', kind: '継続', active: true });
  e.__addRow('Users', { user_id: 'u_E', email: 'e@example.com', display_name: 'GME', role: 'team', team_id: 't_E' });
  e.__tokens['E'] = 'e@example.com';

  const id = addSponsor(e, { quota_type: 'リーグ杯', quota_value: 'ベスト4以上', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('E', { season_id: 's1', sponsor_id: id });

  const res = closeWith(e).data.report.sponsor_results[0];
  eq(res.met, false);
  eq(res.actual, 'ベスト4未満');
});

// ---- 精算まわり ------------------------------------------------------------

t('判定は1回だけ。二重に引かれない', () => {
  const e = env();
  seedLeague(e);
  const id = addSponsor(e, { quota_value: '1', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: id });

  closeWith(e);
  eq(balance(e, 't_D'), -100000000);

  // closeSeason は二重実行できないので、判定関数を直接もう一度呼ぶ
  const report = { sponsor_results: [] };
  e._settleSponsors('ORG', 's1', new Date(), report);
  eq(report.sponsor_results.length, 0);
  eq(balance(e, 't_D'), -100000000);
});

t('判定後は契約を変更できない', () => {
  const e = env();
  seedLeague(e);
  const a = addSponsor(e, { name: 'A社', quota_value: '1', penalty: 1, contract_fee: 0 });
  const b = addSponsor(e, { name: 'B社', quota_value: '1', penalty: 1, contract_fee: 0 });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: a });
  closeWith(e);

  const r = e.chooseSponsor('D', { season_id: 's1', sponsor_id: b });
  eq(r.ok, false);
  ok(r.error.includes('判定'), r.error);
});

t('契約していないチームには何も起きない', () => {
  const e = env();
  seedLeague(e);
  const id = addSponsor(e, { quota_value: '1', penalty: 100000000, contract_fee: 0 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });

  closeWith(e);
  eq(balance(e, 't_B'), 0);
  eq(balance(e, 't_C'), 0);
});

t('契約金と罰金の両方が予算に反映される', () => {
  const e = env();
  seedLeague(e);
  const id = addSponsor(e, { contract_fee: 300000000, quota_value: '1', penalty: 200000000 });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: id });   // D は4位で未達

  eq(balance(e, 't_D'), 300000000);
  closeWith(e);
  eq(balance(e, 't_D'), 100000000);   // 3億もらって2億引かれる
});

// ---- 参加者の画面 ----------------------------------------------------------

t('参加者は一覧と自分の契約を見られる', () => {
  const e = env();
  const id = addSponsor(e, { contract_fee: 300000000 });
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });

  const d = e.getSponsorOptions('A', { season_id: 's1' }).data;
  eq(d.open, true);
  eq(d.sponsors.length, 1);
  eq(d.sponsors[0].is_mine, true);
  eq(d.sponsors[0].contracted, 1);
  eq(d.my_contract.sponsor_name, '大型スポンサー');
});

t('タブは受付中だけ開く', () => {
  const open = env();
  eq(open.getUiState('A', { season_id: 's1' }).data.tabs.sponsor.open, true);

  const closed = env({ sponsor_open: false });
  eq(closed.getUiState('A', { season_id: 's1' }).data.tabs.sponsor.open, false);
});

t('受付停止中でも主催者にはタブが出る', () => {
  const e = env({ sponsor_open: false });
  eq(e.getUiState('ORG', { season_id: 's1' }).data.tabs.sponsor.open, true);
});

report('sponsor.js');
