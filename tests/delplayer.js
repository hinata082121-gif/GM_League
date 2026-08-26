const { t, eq, ok, report } = require('./harness');
const { env } = require('./pf-fixture');

const idOf = (e, name) =>
  e.listPlayers('ORG', {}).data.filter((p) => p.name === name)[0].player_id;

const names = (e) => e.listPlayers('ORG', {}).data.map((p) => p.name);

t('参照されていない選手は消せる', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '重複 太郎', detail_position: 'CB' });
  e.upsertPlayer('ORG', { name: '宇佐美 貴史', detail_position: 'OMF' });

  const r = e.deletePlayer('ORG', { player_id: idOf(e, '重複 太郎') });

  eq(r.ok, true);
  eq(r.data.name, '重複 太郎');
  eq(names(e), ['宇佐美 貴史']);
});

t('在籍している選手は消せない', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '宇佐美 貴史', position: 'OMF' }],
  });

  const r = e.deletePlayer('ORG', { player_id: idOf(e, '宇佐美 貴史') });

  eq(r.ok, false);
  ok(r.error.indexOf('在籍') !== -1, r.error);
  eq(names(e).length, 1, '消えていないこと');
});

t('離脱済みでも履歴があれば消せない', () => {
  const e = env();
  e.importRoster('ORG', {
    season_id: 's2', team_id: 't_a',
    players: [{ name: '山中 亮輔', position: 'LSB', acquired_cost: 80000000 }],
  });
  const pid = idOf(e, '山中 亮輔');
  e.applyRealTransfers('ORG', { season_id: 's2', player_ids: [pid] });

  const r = e.deletePlayer('ORG', { player_id: pid });
  eq(r.ok, false);
});

t('移籍の記録があれば消せない', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '満田 誠', detail_position: 'OMF' });
  const pid = idOf(e, '満田 誠');
  e.__addRow('Transfers', { transfer_id: 'tr1', season_id: 's2', player_id: pid, status: '承認' });

  const r = e.deletePlayer('ORG', { player_id: pid });
  eq(r.ok, false);
  ok(r.error.indexOf('移籍') !== -1, r.error);
});

t('補填の入れ替え先になっていれば消せない', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: 'フアンぺ', detail_position: 'CMF' });
  const pid = idOf(e, 'フアンぺ');
  e.__addRow('Claims', { claim_id: 'c1', season_id: 's2', team_id: 't_a', replacement_id: pid, status: '確定' });

  const r = e.deletePlayer('ORG', { player_id: pid });
  eq(r.ok, false);
  ok(r.error.indexOf('補填') !== -1, r.error);
});

t('存在しない player_id は断る', () => {
  const e = env();
  eq(e.deletePlayer('ORG', { player_id: 'p_none' }).ok, false);
});

t('player_id が空なら断る', () => {
  const e = env();
  eq(e.deletePlayer('ORG', {}).ok, false);
});

t('参加者は削除できない', () => {
  const e = env();
  e.upsertPlayer('ORG', { name: '重複 太郎', detail_position: 'CB' });

  const r = e.deletePlayer('A', { player_id: idOf(e, '重複 太郎') });
  eq(r.ok, false);
  eq(names(e).length, 1);
});

t('消しても他の選手の行はずれない', () => {
  const e = env();
  ['A', 'B', 'C'].forEach((n) => e.upsertPlayer('ORG', { name: n, detail_position: 'CB' }));

  e.deletePlayer('ORG', { player_id: idOf(e, 'B') });

  const list = e.listPlayers('ORG', {}).data;
  eq(list.map((p) => p.name), ['A', 'C']);
  eq(list.every((p) => p.detail_position === 'CB'), true);
});

report('delplayer.js');
