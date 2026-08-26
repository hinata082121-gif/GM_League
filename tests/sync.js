const { t, eq, ok, report } = require('./harness');
const { env, players } = require('./pf-fixture');

/** マスタに選手を1人置く */
function put(e, name, pos, over) {
  e.upsertPlayer('ORG', Object.assign({ name, detail_position: pos }, over || {}));
}

/** 名前で1人引く */
function find(e, name) {
  return e.listPlayers('ORG', {}).data.filter((p) => p.name === name)[0];
}

// =============================================================================
// 更新
// =============================================================================

t('名簿の年齢・国籍・現実クラブでマスタを埋める', () => {
  const e = env();
  put(e, '宇佐美 貴史', 'OMF');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '宇佐美 貴史', position: 'OMF', age: 34, real_club: 'ガンバ大阪' }],
  });

  eq(r.ok, true);
  eq(r.data.updated, 1);
  eq(r.data.created, 0);

  const p = find(e, '宇佐美 貴史');
  eq(p.age, 34);
  eq(p.real_club, 'ガンバ大阪');
});

t('外国籍は国籍から導かれる', () => {
  const e = env();
  put(e, 'フアンぺ', 'CMF');

  e.syncPlayerProfiles('ORG', {
    players: [{ name: 'フアンぺ', age: 30, nationality: 'スペイン', real_club: 'ガンバ大阪' }],
  });

  const p = find(e, 'フアンぺ');
  eq(p.nationality, 'スペイン');
  eq(p.foreign, true);
});

t('同じ内容なら更新済みに数えない', () => {
  const e = env();
  put(e, '宇佐美 貴史', 'OMF', { age: 34, real_club: 'ガンバ大阪' });

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '宇佐美 貴史', age: 34, real_club: 'ガンバ大阪' }],
  });

  eq(r.data.updated, 0);
  eq(r.data.unchanged, 1);
});

t('二度流し込んでも結果が変わらない', () => {
  const e = env();
  put(e, '宇佐美 貴史', 'OMF');
  const list = [{ name: '宇佐美 貴史', position: 'OMF', age: 34, real_club: 'ガンバ大阪' }];

  e.syncPlayerProfiles('ORG', { players: list });
  const r2 = e.syncPlayerProfiles('ORG', { players: list });

  eq(r2.data.created, 0);
  eq(r2.data.updated, 0);
  eq(players(e).length, 1);
});

t('現実クラブが変わっていれば書き換える', () => {
  const e = env();
  put(e, '藤尾 翔太', 'CF', { real_club: 'FC町田ゼルビア' });

  e.syncPlayerProfiles('ORG', {
    players: [{ name: '藤尾 翔太', age: 25, real_club: '柏レイソル' }],
  });

  eq(find(e, '藤尾 翔太').real_club, '柏レイソル');
});

// =============================================================================
// 名前の揺れ
// =============================================================================

t('空白の有無が違っても同じ人とみなす', () => {
  const e = env();
  put(e, '三浦颯太', 'LSB');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '三浦 颯太', age: 25, real_club: '清水エスパルス' }],
  });

  eq(r.data.created, 0, '別人として作られていないこと');
  eq(find(e, '三浦颯太').real_club, '清水エスパルス');
});

t('中黒の有無が違っても同じ人とみなす', () => {
  const e = env();
  put(e, 'スベンド・ブローダーセン', 'GK');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'スベンド ブローダーセン', nationality: 'ドイツ', real_club: 'FC町田ゼルビア' }],
  });

  eq(r.data.created, 0);
  eq(find(e, 'スベンド・ブローダーセン').foreign, true);
});

t('異体字を同じ人とみなす（髙と高）', () => {
  const e = env();
  put(e, '高橋 成海', 'CF');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '髙橋 成海', position: 'CF', age: 17, real_club: 'サンフレッチェ広島' }],
  });

  eq(r.data.created, 0, '別人として作られないこと');
  eq(find(e, '高橋 成海').age, 17);
});

t('異体字は逆向きでも揃う（﨑と崎）', () => {
  const e = env();
  put(e, '山﨑 凌吾', 'CF');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '山崎 凌吾', position: 'CF', age: 34, real_club: 'V・ファーレン長崎' }],
  });

  eq(r.data.created, 0);
  eq(find(e, '山﨑 凌吾').real_club, 'V・ファーレン長崎');
});

t('ヴとブの違いを吸収する', () => {
  const e = env();
  put(e, 'ネタ ラヴィ', 'DMF');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'ネタ ラビ', nationality: 'イスラエル', real_club: 'FC町田ゼルビア' }],
  });

  eq(r.data.created, 0);
});

t('保存されている名前は書き換えない', () => {
  const e = env();
  put(e, '三浦颯太', 'LSB');

  e.syncPlayerProfiles('ORG', {
    players: [{ name: '三浦 颯太', real_club: '清水エスパルス' }],
  });

  ok(find(e, '三浦颯太'), '元の表記のまま残ること');
});

// =============================================================================
// 新規作成
// =============================================================================

t('マスタにいない選手は作る', () => {
  const e = env();

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '小川 航基', position: 'CF', age: 29, real_club: 'FC町田ゼルビア' }],
  });

  eq(r.data.created, 1);
  eq(r.data.created_names, ['小川 航基']);

  const p = find(e, '小川 航基');
  eq(p.position, 'FW');
  eq(p.detail_position, 'CF');
  eq(p.eligible, true);
});

t('create_missing が false なら作らない', () => {
  const e = env();

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '小川 航基', position: 'CF', real_club: 'FC町田ゼルビア' }],
    create_missing: false,
  });

  eq(r.data.created, 0);
  eq(players(e).length, 0);
});

t('作った選手はすぐ入れ替え候補になる', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '山中 亮輔', position: 'LSB', real_club: 'ガンバ大阪', acquired_cost: 80000000 }],
  });
  const pid = find(e, '山中 亮輔').player_id;
  e.applyRealTransfers('ORG', { season_id: 's2', player_ids: [pid] });

  e.syncPlayerProfiles('ORG', {
    players: [{ name: 'フアンぺ', position: 'CMF', age: 30, nationality: 'スペイン', real_club: 'ガンバ大阪' }],
  });

  const cands = e.getMyClaims('A', { season_id: 's2' }).data.candidates;
  eq(cands.length, 1);
  eq(cands[0].name, 'フアンぺ');
  eq(cands[0].foreign, true);
});

// =============================================================================
// ポジションの扱い
// =============================================================================

t('名簿のポジションで上書きする', () => {
  const e = env();
  put(e, '半田 陸', 'RSB');

  e.syncPlayerProfiles('ORG', {
    players: [{ name: '半田 陸', position: 'RMF', real_club: 'ガンバ大阪' }],
  });

  const p = find(e, '半田 陸');
  eq(p.detail_position, 'RMF', '名簿を正とすること');
  eq(p.position, 'MF', '大分類も付け替わること');
});

t('大分類が変わる書き換えもできる', () => {
  const e = env();
  put(e, '宇佐美 貴史', 'ST');
  eq(find(e, '宇佐美 貴史').position, 'FW');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '宇佐美 貴史', position: 'OMF', age: 34, real_club: 'ガンバ大阪' }],
  });

  eq(r.data.updated, 1);
  const p = find(e, '宇佐美 貴史');
  eq(p.detail_position, 'OMF');
  eq(p.position, 'MF');
});

t('名簿にポジションが無ければ元のまま残す', () => {
  const e = env();
  put(e, '半田 陸', 'RSB');

  e.syncPlayerProfiles('ORG', { players: [{ name: '半田 陸', real_club: 'ガンバ大阪' }] });

  const p = find(e, '半田 陸');
  eq(p.detail_position, 'RSB', '上書きする材料が無いので触らない');
  eq(p.position, 'DF');
});

t('ポジションが空欄なら名簿で埋める', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '半田 陸', position: 'DF' });
  eq(find(e, '半田 陸').detail_position, '');

  e.syncPlayerProfiles('ORG', {
    players: [{ name: '半田 陸', position: 'RSB', real_club: 'ガンバ大阪' }],
  });

  eq(find(e, '半田 陸').detail_position, 'RSB');
});

// =============================================================================
// 報告
// =============================================================================

t('名簿に載っていないマスタの選手を報告する', () => {
  const e = env();
  put(e, '宇佐美 貴史', 'OMF');
  put(e, '山中 亮輔', 'LSB');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: '宇佐美 貴史', real_club: 'ガンバ大阪' }],
  });

  eq(r.data.master_only, ['山中 亮輔']);
});

t('マスタに同名が複数いてもポジションで見分ける', () => {
  const e = env();
  put(e, 'エドゥアルド', 'CB');
  put(e, 'エドゥアルド', 'CF');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'エドゥアルド', position: 'CB', age: 33, real_club: 'V・ファーレン長崎' }],
  });

  eq(r.data.updated, 1);
  eq(r.data.ambiguous, []);

  const list = e.listPlayers('ORG', {}).data;
  eq(list.filter((p) => p.detail_position === 'CB')[0].real_club, 'V・ファーレン長崎');
  eq(list.filter((p) => p.detail_position === 'CF')[0].real_club, '', '別人は触られないこと');
});

t('マスタに同名が複数でポジションも同じなら報告する', () => {
  const e = env();
  put(e, 'エドゥアルド', 'CB');
  put(e, 'エドゥアルド', 'CB');

  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'エドゥアルド', position: 'CB', real_club: '鹿島アントラーズ' }],
  });

  eq(r.data.ambiguous, ['エドゥアルド']);
  eq(r.data.updated, 0);
  e.listPlayers('ORG', {}).data.forEach((p) => eq(p.real_club, '', '書き換わっていないこと'));
});

t('名簿の同姓同名はポジションで別人として扱う', () => {
  const e = env();
  put(e, 'エドゥアルド', 'CB');   // 長崎の33歳CBだけがマスタにいる

  const r = e.syncPlayerProfiles('ORG', {
    players: [
      { name: 'エドゥアルド', position: 'CB',  age: 33, nationality: 'ブラジル', real_club: 'V・ファーレン長崎' },
      { name: 'エドゥアルド', position: 'DMF', age: 20, nationality: 'ブラジル', real_club: 'ジェフユナイテッド千葉' },
    ],
  });

  eq(r.data.updated, 1, 'CB は既存を更新');
  eq(r.data.created, 1, 'DMF は新しく作る');
  eq(r.data.duplicated_in_list, []);

  const list = e.listPlayers('ORG', {}).data;
  eq(list.length, 2);
  eq(list.filter((p) => p.detail_position === 'CB')[0].real_club, 'V・ファーレン長崎');
  eq(list.filter((p) => p.detail_position === 'DMF')[0].real_club, 'ジェフユナイテッド千葉');
});

t('名簿の同姓同名でポジションが無ければ触らずに報告する', () => {
  const e = env();
  put(e, 'エドゥアルド', 'CB');

  const r = e.syncPlayerProfiles('ORG', {
    players: [
      { name: 'エドゥアルド', real_club: '鹿島アントラーズ' },
      { name: 'エドゥアルド', real_club: '柏レイソル' },
    ],
  });

  eq(r.data.duplicated_in_list, ['エドゥアルド']);
  eq(r.data.updated, 0);
  eq(r.data.created, 0);
});

// =============================================================================
// 検証と権限
// =============================================================================

t('選手が空なら拒否する', () => {
  const e = env();
  eq(e.syncPlayerProfiles('ORG', { players: [] }).ok, false);
});

t('名前が空の行があれば全体を拒否する', () => {
  const e = env();
  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'A', real_club: 'ガンバ大阪' }, { name: '', real_club: '柏レイソル' }],
  });

  eq(r.ok, false);
  eq(players(e).length, 0, '1人も作られていないこと');
});

t('年齢が不正なら全体を拒否する', () => {
  const e = env();
  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'A', real_club: 'ガンバ大阪' }, { name: 'B', age: 999, real_club: '柏レイソル' }],
  });

  eq(r.ok, false);
  eq(players(e).length, 0);
});

t('ポジションが不正なら全体を拒否する', () => {
  const e = env();
  const r = e.syncPlayerProfiles('ORG', {
    players: [{ name: 'A', position: 'ZZZ', real_club: 'ガンバ大阪' }],
  });

  eq(r.ok, false);
});

t('参加者は同期できない', () => {
  const e = env();
  eq(e.syncPlayerProfiles('A', { players: [{ name: 'A', real_club: 'ガンバ大阪' }] }).ok, false);
});

// =============================================================================
// まとまった名簿
// =============================================================================

t('更新と新規が混ざっていても正しく分かれる', () => {
  const e = env();
  put(e, '宇佐美 貴史', 'OMF');
  put(e, '半田 陸', 'RSB');
  put(e, '山中 亮輔', 'LSB');

  const r = e.syncPlayerProfiles('ORG', {
    players: [
      { name: '宇佐美 貴史', position: 'OMF', age: 34, real_club: 'ガンバ大阪' },
      { name: '半田 陸', position: 'RSB', age: 24, real_club: 'ガンバ大阪' },
      { name: 'フアンぺ', position: 'CMF', age: 30, nationality: 'スペイン', real_club: 'ガンバ大阪' },
      { name: '小川 航基', position: 'CF', age: 29, real_club: 'FC町田ゼルビア' },
    ],
  });

  eq(r.data.received, 4);
  eq(r.data.updated, 2);
  eq(r.data.created, 2);
  eq(r.data.master_only, ['山中 亮輔']);
  eq(players(e).length, 5);
});

report('sync.js');
