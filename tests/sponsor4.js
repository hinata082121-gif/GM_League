const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 解放条件: GM1リーグ所属 / GM2リーグ所属 / 過去シーズン参加経験無
// fixture: 2026シーズン(s1) / 2027シーズン(s2)。スポンサーは s2 に置く。

function add(e, type) {
  const r = e.upsertSponsor('ORG', {
    season_id: 's2', name: type, contract_fee: 50000000,
    quota_type: 'なし', penalty: 0, unlock_type: type,
  });
  if (!r.ok) throw new Error(r.error);
  return r.data.sponsor_id;
}

const optFor = (e, team) => e.getSponsorOptions(team, { season_id: 's2' }).data.sponsors[0];

/** s2 のディビジョン: A,B が GM1 / C が GM2 / D は未割り当て */
function divisions(e) {
  e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_A', division: 'GM1' });
  e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_B', division: 'GM1' });
  e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_C', division: 'GM2' });
  return e;
}

t('3つの種別が選択肢に並ぶ', () => {
  const types = env().listSponsors('ORG', { season_id: 's2' }).data.unlock_types;
  ['GM1リーグ所属', 'GM2リーグ所属', '過去シーズン参加経験無'].forEach((x) => ok(types.includes(x), x));
});

t('GM1リーグ所属は今シーズン GM1 のチームだけ', () => {
  const e = divisions(env());
  add(e, 'GM1リーグ所属');
  eq(optFor(e, 'A').unlocked, true);
  eq(optFor(e, 'C').unlocked, false);
  eq(optFor(e, 'D').unlocked, false, '未割り当ては開けない');
  ok(optFor(e, 'D').unlock_reason.includes('割り当てられていません'));
  eq(optFor(e, 'A').unlock_label, '今シーズン GM1リーグ所属');
});

t('GM2リーグ所属は今シーズン GM2 のチームだけ', () => {
  const e = divisions(env());
  add(e, 'GM2リーグ所属');
  eq(optFor(e, 'C').unlocked, true);
  eq(optFor(e, 'A').unlocked, false);
});

t('過去シーズン参加経験無は、過去シーズンに在籍記録が無いチームだけ', () => {
  const e = env();
  // A は s1 に在籍記録あり。B は s1 の名簿に載っている。C・D はどちらも無し
  e.__addRow('Rosters', { roster_id: 'x1', season_id: 's1', team_id: 't_A', player_id: 'p1', status: '在籍' });
  e.__addRow('SeasonTeams', { season_id: 's1', team_id: 't_B', division: 'GM1' });
  // D は今シーズン(s2)にだけ在籍 → 過去ではないので経験なし扱い
  e.__addRow('Rosters', { roster_id: 'x2', season_id: 's2', team_id: 't_D', player_id: 'p2', status: '在籍' });
  add(e, '過去シーズン参加経験無');

  eq(optFor(e, 'A').unlocked, false);
  ok(optFor(e, 'A').unlock_reason.includes('2026シーズン'), optFor(e, 'A').unlock_reason);
  eq(optFor(e, 'B').unlocked, false);
  eq(optFor(e, 'C').unlocked, true);
  eq(optFor(e, 'D').unlocked, true);
});

t('新しい種別では判定シーズンや対象チームを保存しない', () => {
  const e = divisions(env());
  const r = e.upsertSponsor('ORG', {
    season_id: 's2', name: 'x', contract_fee: 1, quota_type: 'なし', penalty: 0,
    unlock_type: 'GM1リーグ所属', unlock_season_id: 's1', unlock_value: '3', unlock_teams: ['t_C'],
  });
  eq(r.ok, true, r.error);
  const s = e.listSponsors('ORG', { season_id: 's2' }).data.sponsors[0];
  eq(s.unlock_season_id, '');
  eq(s.unlock_teams, []);
});

t('参加者の契約も条件で止まる', () => {
  const e = divisions(env());
  const id = add(e, 'GM2リーグ所属');
  e.__addRow('Config', { key: 'sponsor_open', value: true });
  eq(e.chooseSponsor('A', { season_id: 's2', sponsor_id: id }).ok, false);
  eq(e.chooseSponsor('C', { season_id: 's2', sponsor_id: id }).ok, true);
});

report('sponsor4.js');
