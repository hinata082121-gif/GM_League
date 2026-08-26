const { t, eq, ok, report } = require('./harness');
const { env, players } = require('./pf-fixture');

// =============================================================================
// 登録
// =============================================================================

t('年齢と国籍を付けて登録できる', () => {
  const e = env();
  const r = e.upsertPlayer('ORG', {
    name: 'フアンぺ', detail_position: 'CMF', age: 30,
    nationality: 'スペイン', real_club: 'ガンバ大阪',
  });

  eq(r.ok, true);
  const p = e.listPlayers('ORG', {}).data[0];
  eq(p.name, 'フアンぺ');
  eq(p.position, 'MF');
  eq(p.detail_position, 'CMF');
  eq(p.age, 30);
  eq(p.nationality, 'スペイン');
  eq(p.foreign, true);
});

t('国籍を省くと日本になり外国籍にならない', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '小川航基', detail_position: 'CF', age: 29 });

  const p = e.listPlayers('ORG', {}).data[0];
  eq(p.nationality, '日本');
  eq(p.foreign, false);
});

t('国籍に日本と書いても外国籍にならない', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '瀬古樹', detail_position: 'CMF', nationality: '日本' });
  eq(e.listPlayers('ORG', {}).data[0].foreign, false);
});

t('年齢を省くと0になる', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '年齢なし', detail_position: 'CB' });
  eq(e.listPlayers('ORG', {}).data[0].age, 0);
});

t('年齢が負の数なら拒否する', () => {
  const e = env();
  const r = e.upsertPlayer('ORG', { name: 'X', detail_position: 'CB', age: -1 });
  eq(r.ok, false);
  ok(r.error.indexOf('年齢') !== -1, r.error);
});

t('年齢が現実離れしていれば拒否する', () => {
  const e = env();
  eq(e.upsertPlayer('ORG', { name: 'X', detail_position: 'CB', age: 120 }).ok, false);
});

t('年齢の文字列は数値として読む', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '喜田陽', detail_position: 'DMF', age: '26' });
  eq(e.listPlayers('ORG', {}).data[0].age, 26);
});

t('更新すると年齢と国籍が書き換わる', () => {
  const e = env();
  const id = e.upsertPlayer('ORG', { name: '山根視来', detail_position: 'RSB', age: 32 }).data.player_id;
  e.upsertPlayer('ORG', { player_id: id, name: '山根視来', detail_position: 'RSB', age: 33 });

  const list = e.listPlayers('ORG', {}).data;
  eq(list.length, 1);
  eq(list[0].age, 33);
});

t('参加者は選手を登録できない', () => {
  const e = env();
  eq(e.upsertPlayer('A', { name: 'X', detail_position: 'CB', age: 20 }).ok, false);
});

// =============================================================================
// スカッド
// =============================================================================

t('スカッドに年齢と国籍が乗る', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: 'フアンぺ', position: 'CMF', age: 30, nationality: 'スペイン' }],
  });

  const s = e.getTeamSquad('ORG', { team_id: 't_a', season_id: 's2' }).data.squad[0];
  eq(s.age, 30);
  eq(s.nationality, 'スペイン');
  eq(s.foreign, true);
});

t('スカッドが外国籍の人数を数える', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [
      { name: 'フアンぺ', position: 'CMF', nationality: 'スペイン' },
      { name: 'ネタラヴィ', position: 'DMF', nationality: 'イスラエル' },
      { name: '宇佐美貴史', position: 'OMF' },
    ],
  });

  const d = e.getTeamSquad('ORG', { team_id: 't_a', season_id: 's2' }).data;
  eq(d.total, 3);
  eq(d.foreign_count, 2);
});

t('国籍が全員日本なら外国籍は0人', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '宇佐美貴史', position: 'OMF' }, { name: '半田陸', position: 'RSB' }],
  });
  eq(e.getTeamSquad('ORG', { team_id: 't_a', season_id: 's2' }).data.foreign_count, 0);
});

// =============================================================================
// 取り込み
// =============================================================================

t('取り込みで年齢と国籍が選手マスタに入る', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: 'フアンぺ', position: 'CMF', age: 30, nationality: 'スペイン', real_club: 'ガンバ大阪' }],
  });

  const p = e.listPlayers('ORG', {}).data[0];
  eq(p.age, 30);
  eq(p.nationality, 'スペイン');
});

t('取り込みは既にいる選手の空欄だけ埋める', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '宇佐美貴史', detail_position: 'OMF' });

  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '宇佐美貴史', position: 'OMF', age: 34 }],
  });

  eq(e.listPlayers('ORG', {}).data[0].age, 34);
});

t('取り込みは既に入っている年齢を上書きしない', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '宇佐美貴史', detail_position: 'OMF', age: 34 });

  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '宇佐美貴史', position: 'OMF', age: 99 }],
  });

  eq(e.listPlayers('ORG', {}).data[0].age, 34);
});

t('取り込みでも年齢が不正なら全体を拒否する', () => {
  const e = env();
  const r = e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: 'A', position: 'CB' }, { name: 'B', position: 'CB', age: -5 }],
  });

  eq(r.ok, false);
  eq(players(e).length, 0, '1人も作られていないこと');
});

t('CSV で年齢と国籍を取り込める', () => {
  const e = env();
  const r = e.importPlayersCsv('ORG', {
    csv: 'name,position,age,nationality,real_club\n' +
         'フアンぺ,CMF,30,スペイン,ガンバ大阪\n' +
         '小川航基,CF,29,,FC町田ゼルビア\n',
  });

  eq(r.ok, true);
  eq(r.data.added, 2);

  const list = e.listPlayers('ORG', {}).data;
  const juanpe = list.filter((p) => p.name === 'フアンぺ')[0];
  eq(juanpe.age, 30);
  eq(juanpe.foreign, true);
  eq(list.filter((p) => p.name === '小川航基')[0].foreign, false);
});

t('CSV に年齢の列が無くても取り込める', () => {
  const e = env();
  const r = e.importPlayersCsv('ORG', { csv: 'name,position\n山根視来,RSB\n' });
  eq(r.ok, true);
  eq(e.listPlayers('ORG', {}).data[0].age, 0);
});

t('CSV の不正な年齢はその行だけ落とす', () => {
  const e = env();
  const r = e.importPlayersCsv('ORG', {
    csv: 'name,position,age\n良い人,CB,25\n悪い人,CB,-3\n',
  });

  eq(r.ok, true);
  eq(r.data.added, 1);
  eq(r.data.errors.length, 1);
});

// =============================================================================
// 補填の入れ替え候補
// =============================================================================

function withClaim(e) {
  // 大会外移籍で t_a の選手が抜け、同じ現実クラブから入れ替える状況を作る
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '山中亮輔', position: 'LSB', age: 33, real_club: 'ガンバ大阪', acquired_cost: 80000000 }],
  });

  const pid = e.listPlayers('ORG', {}).data
    .filter((p) => p.name === '山中亮輔')[0].player_id;

  e.applyRealTransfers('ORG', { season_id: 's2', player_ids: [pid] });
  return pid;
}

t('入れ替え候補に年齢と国籍が乗る', () => {
  const e = env();
  e.upsertPlayer('ORG', {
    name: 'フアンぺ', detail_position: 'CMF', age: 30,
    nationality: 'スペイン', real_club: 'ガンバ大阪',
  });
  withClaim(e);

  const cands = e.getMyClaims('A', { season_id: 's2' }).data.candidates;
  const juanpe = cands.filter((c) => c.name === 'フアンぺ')[0];

  ok(juanpe, '候補に出ていること');
  eq(juanpe.age, 30);
  eq(juanpe.nationality, 'スペイン');
  eq(juanpe.foreign, true);
  eq(juanpe.detail_position, 'CMF');
});

t('登録したての選手がそのまま入れ替え候補になる', () => {
  const e = env();
  withClaim(e);

  eq(e.getMyClaims('A', { season_id: 's2' }).data.candidates.length, 0, '登録前は候補なし');

  e.upsertPlayer('ORG', { name: 'フアンぺ', detail_position: 'CMF', age: 30, nationality: 'スペイン', real_club: 'ガンバ大阪' });

  const after = e.getMyClaims('A', { season_id: 's2' }).data.candidates;
  eq(after.length, 1);
  eq(after[0].name, 'フアンぺ');
});

t('現実クラブが違えば候補に出ない', () => {
  const e = env();
  withClaim(e);
  e.upsertPlayer('ORG', { name: '小川航基', detail_position: 'CF', age: 29, real_club: 'FC町田ゼルビア' });

  eq(e.getMyClaims('A', { season_id: 's2' }).data.candidates.length, 0);
});

t('エントリー不可の選手は候補に出ない', () => {
  const e = env();
  withClaim(e);
  e.upsertPlayer('ORG', { name: 'フアンぺ', detail_position: 'CMF', real_club: 'ガンバ大阪', eligible: false });

  eq(e.getMyClaims('A', { season_id: 's2' }).data.candidates.length, 0);
});

// =============================================================================
// 並び順
// =============================================================================

t('候補はポジション順に並ぶ', () => {
  const e = env();
  withClaim(e);

  [['CF', '前の人'], ['CB', '後ろの人'], ['CMF', '真ん中の人']].forEach(([pos, name]) =>
    e.upsertPlayer('ORG', { name, detail_position: pos, real_club: 'ガンバ大阪' }));

  const names = e.getMyClaims('A', { season_id: 's2' }).data.candidates.map((c) => c.name);
  eq(names, ['後ろの人', '真ん中の人', '前の人']);
});

report('profile.js');
