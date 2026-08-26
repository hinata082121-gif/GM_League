const { t, eq, ok, report } = require('./harness');
const { env, addSponsor, balance, seedLeague, seedCup } = require('./sp-fixture');

// ---- or 条件 ---------------------------------------------------------------

t('2つ目のノルマを設定できる', () => {
  const e = env();
  addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '1',
    quota_type2: 'リーグ杯', quota_value2: '優勝',
    penalty: 100000000,
  });
  eq(e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0].quota_label,
     'リーグ戦 1位以内 または GMリーグ杯 優勝');
});

t('2つ目が空なら1つだけの表記', () => {
  const e = env();
  addSponsor(e, { quota_type: 'リーグ順位', quota_value: '3', penalty: 1 });
  eq(e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0].quota_label,
     'リーグ戦 3位以内');
});

t('1つ目が空で2つ目だけなら1つ目に寄せる', () => {
  const e = env();
  addSponsor(e, {
    quota_type: 'なし', quota_value: '',
    quota_type2: 'リーグ杯', quota_value2: '優勝',
    penalty: 100000000,
  });
  const s = e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0];
  eq(s.quota_type, 'リーグ杯');
  eq(s.quota_type2, 'なし');
  eq(s.quota_label, 'GMリーグ杯 優勝');
});

t('2つ目の値が不正なら拒否する', () => {
  const e = env();
  const r = e.upsertSponsor('ORG', {
    season_id: 's1', name: 'x', contract_fee: 1,
    quota_type: 'リーグ順位', quota_value: '1',
    quota_type2: 'リーグ杯', quota_value2: '3回戦',
    penalty: 1,
  });
  eq(r.ok, false);
  ok(r.error.indexOf('2つ目のノルマ') === 0, r.error);
});

// ---- or の判定 -------------------------------------------------------------

/** リーグ戦とリーグ杯の両方を仕込む */
function full(e) {
  seedLeague(e);   // A>B>C>D
  seedCup(e, true); // 決勝は A の勝ち。B が準優勝、C・D が準決勝敗退
  return e;
}

const results = (e) => e.closeSeason('ORG', { season_id: 's1' }).data.report.sponsor_results;

t('片方だけ達成でも達成になる', () => {
  const e = full(env());
  // ノルマ: リーグ1位 または リーグ杯優勝
  const id = addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '1',
    quota_type2: 'リーグ杯', quota_value2: '優勝',
    penalty: 100000000, contract_fee: 0,
  });
  // B は2位だが、リーグ杯は準優勝。どちらも未達
  // C は3位で準決勝敗退。どちらも未達
  e.chooseSponsor('A', { season_id: 's1', sponsor_id: id });   // 1位かつ優勝
  e.chooseSponsor('B', { season_id: 's1', sponsor_id: id });

  const rs = results(e);
  eq(rs.find((r) => r.team_name === 'チームA').met, true);
  eq(rs.find((r) => r.team_name === 'チームB').met, false);
});

t('リーグは未達でもカップで達成できる', () => {
  const e = full(env());
  // ノルマ: リーグ1位 または リーグ杯 準優勝以上
  const id = addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '1',
    quota_type2: 'リーグ杯', quota_value2: '準優勝以上',
    penalty: 100000000, contract_fee: 0,
  });
  e.chooseSponsor('B', { season_id: 's1', sponsor_id: id });   // 2位・決勝進出

  const r = results(e)[0];
  eq(r.met, true);
  eq(r.penalty, 0);
});

t('カップは未達でもリーグで達成できる', () => {
  const e = full(env());
  const id = addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '3',
    quota_type2: 'リーグ杯', quota_value2: '優勝',
    penalty: 100000000, contract_fee: 0,
  });
  e.chooseSponsor('C', { season_id: 's1', sponsor_id: id });   // 3位・準決勝敗退
  eq(results(e)[0].met, true);
});

t('どちらも未達なら罰金', () => {
  const e = full(env());
  const id = addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '2',
    quota_type2: 'リーグ杯', quota_value2: '優勝',
    penalty: 100000000, contract_fee: 0,
  });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: id });   // 4位・準決勝敗退

  const r = results(e)[0];
  eq(r.met, false);
  eq(r.penalty, 100000000);
  eq(balance(e, 't_D'), -100000000);
});

t('実績は両方の結果が並ぶ', () => {
  const e = full(env());
  const id = addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '1',
    quota_type2: 'リーグ杯', quota_value2: '優勝',
    penalty: 1, contract_fee: 0,
  });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: id });
  eq(results(e)[0].actual, '4位 / ベスト4以上');
});

// ---- 解放条件: 指定 --------------------------------------------------------

t('指定したチームだけ契約できる', () => {
  const e = env();
  const id = addSponsor(e, { unlock_type: '指定', unlock_teams: ['t_A', 't_B'] });

  eq(e.chooseSponsor('A', { season_id: 's1', sponsor_id: id }).ok, true);
  eq(e.chooseSponsor('B', { season_id: 's1', sponsor_id: id }).ok, true);

  const r = e.chooseSponsor('C', { season_id: 's1', sponsor_id: id });
  eq(r.ok, false);
  ok(r.error.indexOf('解放条件') !== -1, r.error);
});

t('解放状態が一覧に出る', () => {
  const e = env();
  addSponsor(e, { unlock_type: '指定', unlock_teams: ['t_A'] });

  eq(e.getSponsorOptions('A', { season_id: 's1' }).data.sponsors[0].unlocked, true);
  eq(e.getSponsorOptions('C', { season_id: 's1' }).data.sponsors[0].unlocked, false);
});

t('解放条件の説明文がそのまま出る', () => {
  const e = env();
  addSponsor(e, {
    unlock_type: '指定', unlock_teams: ['t_A'],
    unlock_note: 'Season7〜13でGM1所属かつタイトル獲得',
  });
  eq(e.getSponsorOptions('A', { season_id: 's1' }).data.sponsors[0].unlock_label,
     'Season7〜13でGM1所属かつタイトル獲得');
});

t('主催者は解放条件を無視して代理契約できる', () => {
  const e = env();
  const id = addSponsor(e, { unlock_type: '指定', unlock_teams: ['t_A'] });
  eq(e.chooseSponsor('ORG', { season_id: 's1', team_id: 't_C', sponsor_id: id }).ok, true);
});

t('解放条件なしなら全員が契約できる', () => {
  const e = env();
  const id = addSponsor(e);
  eq(e.chooseSponsor('D', { season_id: 's1', sponsor_id: id }).ok, true);
  eq(e.getSponsorOptions('D', { season_id: 's1' }).data.sponsors[0].unlocked, true);
});

// ---- 解放条件: 順位 --------------------------------------------------------

t('前シーズンの順位で解放できる', () => {
  const e = env();
  seedLeague(e);   // s1 で A>B>C>D
  // s2 のスポンサーを、s1 の順位で解放する
  const r = e.upsertSponsor('ORG', {
    season_id: 's2', name: '強豪向け', contract_fee: 200000000,
    quota_type: 'リーグ順位', quota_value: '1', penalty: 100000000,
    unlock_type: '順位', unlock_season_id: 's1', unlock_value: '2',
  });
  eq(r.ok, true);

  const forA = e.getSponsorOptions('A', { season_id: 's2' }).data.sponsors[0];
  const forC = e.getSponsorOptions('C', { season_id: 's2' }).data.sponsors[0];

  eq(forA.unlocked, true);
  eq(forC.unlocked, false);
  ok(forC.unlock_reason.indexOf('3位') !== -1, forC.unlock_reason);
});

t('順位で解放するのにシーズン未指定なら拒否', () => {
  const e = env();
  const r = e.upsertSponsor('ORG', {
    season_id: 's1', name: 'x', contract_fee: 1,
    quota_type: 'なし', penalty: 0,
    unlock_type: '順位', unlock_value: '3',
  });
  eq(r.ok, false);
});

t('対象シーズンに順位が無ければ開けない', () => {
  const e = env();
  // s1 に試合を入れていないので順位が出ない
  e.upsertSponsor('ORG', {
    season_id: 's2', name: 'x', contract_fee: 1,
    quota_type: 'なし', penalty: 0,
    unlock_type: '順位', unlock_season_id: 's1', unlock_value: '3',
  });

  const s = e.getSponsorOptions('A', { season_id: 's2' }).data.sponsors[0];
  eq(s.unlocked, false);
  ok(s.unlock_reason.indexOf('順位がありません') !== -1, s.unlock_reason);
});

t('順位の解放条件は1以上', () => {
  const e = env();
  eq(e.upsertSponsor('ORG', {
    season_id: 's1', name: 'x', contract_fee: 1, quota_type: 'なし', penalty: 0,
    unlock_type: '順位', unlock_season_id: 's1', unlock_value: '0',
  }).ok, false);
});

t('種別を変えると使わない項目は消える', () => {
  const e = env();
  const id = addSponsor(e, { unlock_type: '指定', unlock_teams: ['t_A', 't_B'] });

  e.upsertSponsor('ORG', {
    sponsor_id: id, season_id: 's1', name: '大型スポンサー',
    contract_fee: 300000000, quota_type: 'リーグ順位', quota_value: '3', penalty: 200000000,
    unlock_type: 'なし',
  });

  const s = e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0];
  eq(s.unlock_teams, []);
  eq(s.unlock_type, 'なし');
});

// ---- 複製 ------------------------------------------------------------------

t('複製すると解放の対象は引き継がない', () => {
  const e = env();
  addSponsor(e, {
    unlock_type: '指定', unlock_teams: ['t_A'],
    unlock_note: '前季4位以内',
  });

  e.copySponsors('ORG', { from_season_id: 's1', to_season_id: 's2' });
  const c = e.listSponsors('ORG', { season_id: 's2' }).data.sponsors[0];

  eq(c.unlock_type, '指定');
  eq(c.unlock_teams, []);          // チームは引き継がない
  eq(c.unlock_note, '前季4位以内'); // 説明文は残る
});

t('複製でor条件も引き継ぐ', () => {
  const e = env();
  addSponsor(e, {
    quota_type: 'リーグ順位', quota_value: '1',
    quota_type2: 'リーグ杯', quota_value2: '優勝', penalty: 1,
  });
  e.copySponsors('ORG', { from_season_id: 's1', to_season_id: 's2' });

  eq(e.listSponsors('ORG', { season_id: 's2' }).data.sponsors[0].quota_label,
     'リーグ戦 1位以内 または GMリーグ杯 優勝');
});

t('設定画面の選択肢が返る', () => {
  const e = env();
  const d = e.listSponsors('ORG', { season_id: 's1' }).data;
  eq(d.unlock_types, ['なし', '順位', '指定']);
  eq(d.quota_types, ['なし', 'リーグ順位', 'リーグ杯']);
  eq(d.teams.length, 4);
});

report('sponsor2.js');
