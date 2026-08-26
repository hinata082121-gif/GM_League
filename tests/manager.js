const { t, eq, ok, report } = require('./harness');
const { env, setRound, picks, pickOf } = require('./mg-fixture');

// ---- 監督マスタ ------------------------------------------------------------

t('名前未入力・非アクティブは選択肢に出ない', () => {
  const e = env();
  setRound(e, 1);
  const d = e.getManagerStatus('A', { season_id: 's1' }).data;
  const ids = [].concat(...d.categories.map((c) => d.managers[c])).map((m) => m.manager_id);
  eq(ids.sort(), ['mg_1', 'mg_2', 'mg_3', 'mg_4']);
});

t('カテゴリ別にまとまる', () => {
  const e = env();
  setRound(e, 1);
  const d = e.getManagerStatus('A', { season_id: 's1' }).data;
  eq(d.categories.sort(), ['J1', 'J2']);
  eq(d.managers.J2.length, 1);
});

t('マスタは主催者だけが一覧できる', () => {
  const e = env();
  eq(e.listManagers('A').ok, false);
  eq(e.listManagers('ORG').data.unnamed, 1);
});

t('監督を追加・修正できる', () => {
  const e = env();
  const r = e.upsertManager('ORG', { manager_id: 'mg_5', name: '監督E', club: 'FC町田ゼルビア', category: 'J1' });
  eq(r.ok, true);
  eq(r.data.created, false);
  eq(e.listManagers('ORG').data.unnamed, 0);
});

t('監督名が空だと保存できない', () => {
  const e = env();
  eq(e.upsertManager('ORG', { manager_id: 'mg_5', name: '', club: 'x', category: 'J1' }).ok, false);
});

// ---- 受付状態 --------------------------------------------------------------

t('停止中は申告できない', () => {
  const e = env();
  setRound(e, 0);
  const r = e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  eq(r.ok, false);
  ok(r.error.includes('受け付けていません'), r.error);
});

t('ラウンドの切替は主催者のみ', () => {
  const e = env();
  eq(e.setManagerRound('A', { round: 1 }).ok, false);
  eq(e.setManagerRound('ORG', { round: 1 }).ok, true);
});

t('不正なラウンドは拒否', () => {
  const e = env();
  eq(e.setManagerRound('ORG', { round: 5 }).ok, false);
});

// ---- 第一次（盲目申告） ----------------------------------------------------

t('第一次では申告中として記録される', () => {
  const e = env();
  setRound(e, 1);
  const r = e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  eq(r.ok, true);
  eq(r.data.status, '申告中');
  eq(pickOf(e, 't_A')[5], '申告中');
});

t('第一次は同じ監督を複数チームが申告できる', () => {
  const e = env();
  setRound(e, 1);
  eq(e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' }).ok, true);
  eq(e.declareManager('B', { season_id: 's1', manager_id: 'mg_1' }).ok, true);
  eq(picks(e).length, 2);
});

t('第一次では他チームの申告が見えない', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });

  const d = e.getManagerStatus('B', { season_id: 's1' }).data;
  const mg1 = d.managers.J1.find((m) => m.manager_id === 'mg_1');
  eq(mg1.taken, false);
  eq(mg1.taken_by, '');
});

t('自分の申告は自分には見える', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  const d = e.getManagerStatus('A', { season_id: 's1' }).data;
  eq(d.my_pick.manager_id, 'mg_1');
  eq(d.my_pick.status, '申告中');
});

t('締切前は何度でも変更できる', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  const r = e.declareManager('A', { season_id: 's1', manager_id: 'mg_2' });
  eq(r.ok, true);
  eq(r.data.updated, true);
  eq(picks(e).length, 1);
  eq(pickOf(e, 't_A')[4], 'mg_2');
});

t('他人のチームでは申告できない', () => {
  const e = env();
  setRound(e, 1);
  eq(e.declareManager('A', { season_id: 's1', team_id: 't_B', manager_id: 'mg_1' }).ok, false);
});

t('主催者は代理で申告できる', () => {
  const e = env();
  setRound(e, 1);
  eq(e.declareManager('ORG', { season_id: 's1', team_id: 't_A', manager_id: 'mg_1' }).ok, true);
});

t('存在しない監督は申告できない', () => {
  const e = env();
  setRound(e, 1);
  eq(e.declareManager('A', { season_id: 's1', manager_id: 'mg_999' }).ok, false);
});

t('名前未入力の監督は申告できない', () => {
  const e = env();
  setRound(e, 1);
  eq(e.declareManager('A', { season_id: 's1', manager_id: 'mg_5' }).ok, false);
});

// ---- 抽選 ------------------------------------------------------------------

t('重複がなければ全員そのまま確定', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  e.declareManager('B', { season_id: 's1', manager_id: 'mg_2' });

  const r = e.drawManagers('ORG', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.fixed_count, 2);
  eq(r.data.lotteries.length, 0);
  eq(pickOf(e, 't_A')[5], '確定');
  eq(pickOf(e, 't_B')[5], '確定');
});

t('上限までの重複は抽選なしで全員確定', () => {
  const e = env();
  setRound(e, 1);
  ['A', 'B', 'C'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));

  const r = e.drawManagers('ORG', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.fixed_count, 3);
  eq(r.data.lost_count, 0);
  eq(r.data.lotteries.length, 0);
  eq(picks(e).map((p) => p[5]).sort(), ['確定', '確定', '確定']);
});

t('上限を超えたぶんだけ落選になる', () => {
  const e = env();
  setRound(e, 1);
  ['A', 'B', 'C', 'D', 'E'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));

  const r = e.drawManagers('ORG', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.fixed_count, 3);
  eq(r.data.lost_count, 2);
  eq(r.data.lotteries.length, 1);
  eq(r.data.lotteries[0].entries.length, 5);
  eq(r.data.lotteries[0].winners.length, 3);
  eq(r.data.lotteries[0].losers.length, 2);

  eq(picks(e).map((p) => p[5]).sort(), ['確定', '確定', '確定', '落選', '落選']);
});

t('上限は設定で変えられる', () => {
  const e = env();
  setRound(e, 1, 1);   // 1チーム1監督の独占にする
  ['A', 'B', 'C'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));

  const r = e.drawManagers('ORG', { season_id: 's1' });
  eq(r.data.fixed_count, 1);
  eq(r.data.lost_count, 2);
});

t('当選者は申告順に左右されない', () => {
  // 5チームが同じ監督を選び、100回抽選して全チームが当選しうることを見る
  const winners = {};
  for (let i = 0; i < 100; i++) {
    const e = env();
    setRound(e, 1);
    ['A', 'B', 'C', 'D', 'E'].forEach((k) =>
      e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));
    e.drawManagers('ORG', { season_id: 's1' });
    picks(e).forEach((p) => { if (p[5] === '確定') winners[p[2]] = true; });
  }
  eq(Object.keys(winners).length, 5);
});

t('抽選の結果が記録される', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  e.declareManager('B', { season_id: 's1', manager_id: 'mg_1' });
  e.drawManagers('ORG', { season_id: 's1' });
  // decided_at が入っている
  ok(picks(e).every((p) => p[7]), '抽選日時が記録されていない');
});

t('当選と落選が混在しても正しく処理される', () => {
  const e = env();
  setRound(e, 1);
  ['A', 'B', 'C', 'D'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));
  e.declareManager('E', { season_id: 's1', manager_id: 'mg_3' });

  const r = e.drawManagers('ORG', { season_id: 's1' });
  eq(r.data.fixed_count, 4);   // mg_1 の当選3 + mg_3 の1
  eq(r.data.lost_count, 1);
  eq(pickOf(e, 't_E')[5], '確定');
});

t('抽選は主催者のみ', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  eq(e.drawManagers('A', { season_id: 's1' }).ok, false);
});

t('申告が無ければ抽選できない', () => {
  const e = env();
  eq(e.drawManagers('ORG', { season_id: 's1' }).ok, false);
});

t('抽選を2回走らせても確定は動かない', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  e.drawManagers('ORG', { season_id: 's1' });
  const r = e.drawManagers('ORG', { season_id: 's1' });
  eq(r.ok, false);   // 申告中がもう無い
  eq(pickOf(e, 't_A')[5], '確定');
});

// ---- 第二次（先着） --------------------------------------------------------

function afterFirst() {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  e.drawManagers('ORG', { season_id: 's1' });
  setRound(e, 2);
  return e;
}

t('第二次は申告した瞬間に確定する', () => {
  const e = afterFirst();
  const r = e.declareManager('B', { season_id: 's1', manager_id: 'mg_2' });
  eq(r.ok, true);
  eq(r.data.status, '確定');
  eq(pickOf(e, 't_B')[5], '確定');
});

t('第二次では確定済みの監督と残り枠が見える', () => {
  const e = afterFirst();
  const d = e.getManagerStatus('B', { season_id: 's1' }).data;
  const mg1 = d.managers.J1.find((m) => m.manager_id === 'mg_1');

  eq(d.max_teams, 3);
  eq(mg1.taken, false);        // まだ1チームなので満枠ではない
  eq(mg1.used, 1);
  eq(mg1.remaining, 2);
  eq(mg1.taken_by, 'チームA');
});

t('上限まで埋まると満枠になる', () => {
  const e = env();
  e.assignManager('ORG', { season_id: 's1', team_id: 't_A', manager_id: 'mg_1' });
  e.assignManager('ORG', { season_id: 's1', team_id: 't_B', manager_id: 'mg_1' });
  e.assignManager('ORG', { season_id: 's1', team_id: 't_C', manager_id: 'mg_1' });

  const d = e.getManagerStatus('D', { season_id: 's1' }).data;
  const mg1 = d.managers.J1.find((m) => m.manager_id === 'mg_1');
  eq(mg1.taken, true);
  eq(mg1.remaining, 0);
  eq(mg1.taken_by, 'チームA / チームB / チームC');
});

t('満枠の監督は先着で取れない', () => {
  const e = env();
  setRound(e, 2);
  ['A', 'B', 'C'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));

  const r = e.declareManager('D', { season_id: 's1', manager_id: 'mg_1' });
  eq(r.ok, false);
  ok(r.error.includes('上限'), r.error);
});

t('上限内なら先着でも同じ監督を取れる', () => {
  const e = env();
  setRound(e, 2);
  eq(e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' }).ok, true);
  eq(e.declareManager('B', { season_id: 's1', manager_id: 'mg_1' }).ok, true);
  eq(e.declareManager('C', { season_id: 's1', manager_id: 'mg_1' }).ok, true);
});

t('第二次は先着。上限を超えた4人目から弾かれる', () => {
  const e = env();
  setRound(e, 2);
  ['A', 'B', 'C'].forEach((k) =>
    eq(e.declareManager(k, { season_id: 's1', manager_id: 'mg_2' }).ok, true));
  eq(e.declareManager('D', { season_id: 's1', manager_id: 'mg_2' }).ok, false);
  eq(e.declareManager('E', { season_id: 's1', manager_id: 'mg_2' }).ok, false);
});

t('第一次で落選したチームは第二次で選び直せる', () => {
  const e = env();
  setRound(e, 1);
  ['A', 'B', 'C', 'D'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));
  e.drawManagers('ORG', { season_id: 's1' });

  const loser = picks(e).find((p) => p[5] === '落選');
  const token = loser[2].replace('t_', '');

  setRound(e, 2);
  const r = e.declareManager(token, { season_id: 's1', manager_id: 'mg_3' });
  eq(r.ok, true);
  eq(r.data.status, '確定');
});

t('確定した後は自分で変更できない', () => {
  const e = afterFirst();
  const r = e.declareManager('A', { season_id: 's1', manager_id: 'mg_2' });
  eq(r.ok, false);
  ok(r.error.includes('確定'), r.error);
});

t('空き数は満枠になった監督だけ減る', () => {
  const e = afterFirst();
  const d = e.getManagerStatus('B', { season_id: 's1' }).data;
  eq(d.total, 4);
  eq(d.available, 4);   // mg_1 はまだ1チームなので空きのまま

  ['B', 'C'].forEach((k) =>
    e.assignManager('ORG', { season_id: 's1', team_id: 't_' + k, manager_id: 'mg_1' }));

  eq(e.getManagerStatus('D', { season_id: 's1' }).data.available, 3);
});

// ---- 主催者の一覧・手動操作 ------------------------------------------------

t('抽選が必要なのは上限を超えたものだけ', () => {
  const e = env();
  setRound(e, 1);
  ['A', 'B', 'C'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));

  // 3チームは上限ちょうど。抽選は要らない
  eq(e.listManagerPicks('ORG', { season_id: 's1' }).data.duplicates.length, 0);

  e.declareManager('D', { season_id: 's1', manager_id: 'mg_1' });

  const d = e.listManagerPicks('ORG', { season_id: 's1' }).data;
  eq(d.declared, 4);
  eq(d.duplicates.length, 1);
  eq(d.duplicates[0].teams.length, 4);
  eq(d.undeclared.length, 1);
  eq(d.undeclared[0].team_name, 'チームE');
});

t('一覧は主催者のみ', () => {
  const e = env();
  eq(e.listManagerPicks('A', { season_id: 's1' }).ok, false);
});

t('主催者が手動で割り当てられる', () => {
  const e = env();
  const r = e.assignManager('ORG', { season_id: 's1', team_id: 't_A', manager_id: 'mg_1' });
  eq(r.ok, true);
  eq(pickOf(e, 't_A')[5], '確定');
});

t('手動でも上限を超えては割り当てられない', () => {
  const e = env();
  ['A', 'B', 'C'].forEach((k) =>
    eq(e.assignManager('ORG', { season_id: 's1', team_id: 't_' + k, manager_id: 'mg_1' }).ok, true));

  eq(e.assignManager('ORG', { season_id: 's1', team_id: 't_D', manager_id: 'mg_1' }).ok, false);
});

t('申告を取り消せる', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  const id = pickOf(e, 't_A')[0];
  eq(e.clearManagerPick('ORG', { pick_id: id }).ok, true);
  eq(picks(e).length, 0);
});

t('取り消しは主催者のみ', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  eq(e.clearManagerPick('A', { pick_id: pickOf(e, 't_A')[0] }).ok, false);
});

t('取り消すと監督が空きに戻る', () => {
  const e = env();
  e.assignManager('ORG', { season_id: 's1', team_id: 't_A', manager_id: 'mg_1' });
  e.clearManagerPick('ORG', { pick_id: pickOf(e, 't_A')[0] });
  setRound(e, 2);
  eq(e.declareManager('B', { season_id: 's1', manager_id: 'mg_1' }).ok, true);
});

// ---- 公開ページ ------------------------------------------------------------

t('確定した監督が公開ページに出る', () => {
  const e = env();
  e.assignManager('ORG', { season_id: 's1', team_id: 't_A', manager_id: 'mg_1' });
  const list = e.getPublicData({ season_id: 's1' }).data.managers;
  eq(list.length, 1);
  eq(list[0].team_name, 'チームA');
  eq(list[0].manager_name, '監督A');
});

t('申告中は公開ページに漏れない', () => {
  const e = env();
  setRound(e, 1);
  e.declareManager('A', { season_id: 's1', manager_id: 'mg_1' });
  eq(e.getPublicData({ season_id: 's1' }).data.managers.length, 0);
});

t('抽選後は当選者だけが公開される', () => {
  const e = env();
  setRound(e, 1);
  ['A', 'B', 'C', 'D'].forEach((k) =>
    e.declareManager(k, { season_id: 's1', manager_id: 'mg_1' }));
  e.drawManagers('ORG', { season_id: 's1' });
  eq(e.getPublicData({ season_id: 's1' }).data.managers.length, 3);
});

report('manager.js');
