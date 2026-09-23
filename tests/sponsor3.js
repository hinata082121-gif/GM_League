const { t, eq, ok, report } = require('./harness');
const { env, addSponsor, seedLeague } = require('./sp-fixture');

// スポンサー: 解放条件の「判定するシーズン」と、罰則の主力放出。
//
// シーズンは名前の番号で前後を決める（作成日時ではない。Season13 は
// Season14 より後に取り込んでいる）。fixture は 2026シーズン(s1) / 2027シーズン(s2)。

/** 過去シーズンを足す。2024 / 2025 */
function withPast(e) {
  e.__addRow('Seasons', { season_id: 's_24', name: '2024シーズン', status: '終了' });
  e.__addRow('Seasons', { season_id: 's_25', name: '2025シーズン', status: '終了' });
  return e;
}

const options = (e, sid) => e.listSponsors('ORG', { season_id: sid }).data.unlock_season_options;

// ---- 判定するシーズンの選択肢 --------------------------------------------

t('今のシーズンは選択肢に出ない', () => {
  const o = options(env(), 's1');
  ok(!o.some((x) => x.value === 's1'), '今のシーズンが混ざっている');
});

t('過去のシーズンだけが並ぶ（新しい順）', () => {
  const o = options(withPast(env()), 's2');
  eq(o.slice(2).map((x) => x.value), ['s1', 's_25', 's_24']);
});

t('前シーズンと直近3シーズンが先頭に出る', () => {
  const o = options(withPast(env()), 's2');
  eq(o[0].value, 'prev');
  ok(o[0].label.includes('2026シーズン'), o[0].label);
  eq(o[1].value, 'last3');
  eq(o[1].available, true);
  ok(o[1].label.includes('2024シーズン〜2026シーズン'), o[1].label);
});

t('過去が3シーズンそろっていなければ直近3シーズンは使えない', () => {
  // s2 から見ると過去は s1 だけ
  const o = options(env(), 's2');
  eq(o[1].value, 'last3');
  eq(o[1].available, false);
  ok(o[1].reason.includes('そろっていません'), o[1].reason);

  const r = addSponsorTry(env(), { season_id: 's2', unlock_type: '順位', unlock_season_id: 'last3', unlock_value: '3' });
  eq(r.ok, false);
});

t('今のシーズンや先のシーズンを判定に使うと拒否', () => {
  eq(addSponsorTry(env(), { season_id: 's1', unlock_type: '順位', unlock_season_id: 's1', unlock_value: '3' }).ok, false);
  eq(addSponsorTry(env(), { season_id: 's1', unlock_type: '順位', unlock_season_id: 's2', unlock_value: '3' }).ok, false);
});

function addSponsorTry(e, over) {
  return e.upsertSponsor('ORG', Object.assign({
    season_id: 's2', name: '強豪向け', contract_fee: 100000000,
    quota_type: 'リーグ順位', quota_value: '1', penalty: 10000000,
  }, over));
}

// ---- 判定 ---------------------------------------------------------------

t('「前シーズン」は1つ前のシーズンの順位で判定する', () => {
  const e = env();
  seedLeague(e);   // s1 で A>B>C>D
  eq(addSponsorTry(e, { unlock_type: '順位', unlock_season_id: 'prev', unlock_value: '2' }).ok, true);

  const a = e.getSponsorOptions('A', { season_id: 's2' }).data.sponsors[0];
  const c = e.getSponsorOptions('C', { season_id: 's2' }).data.sponsors[0];
  eq(a.unlocked, true);
  eq(c.unlocked, false);
  ok(a.unlock_label.includes('前シーズン（2026シーズン） 2位以内'), a.unlock_label);
});

t('「直近3シーズン」はいずれかのシーズンで条件を満たせば解放', () => {
  const e = withPast(env());
  seedLeague(e);   // s1 だけ試合がある。s_24 / s_25 は順位なし
  eq(addSponsorTry(e, { unlock_type: '順位', unlock_season_id: 'last3', unlock_value: '2' }).ok, true);

  const b = e.getSponsorOptions('B', { season_id: 's2' }).data.sponsors[0];
  const d = e.getSponsorOptions('D', { season_id: 's2' }).data.sponsors[0];
  eq(b.unlocked, true);
  eq(d.unlocked, false);
  ok(d.unlock_reason.includes('2024シーズン: 順位なし'), d.unlock_reason);
});

t('相対の指定は複製しても引き継ぐ。名指しのシーズンは引き継がない', () => {
  const e = withPast(env());
  e.__addRow('Seasons', { season_id: 's3', name: '2028シーズン', status: '準備中' });
  eq(addSponsorTry(e, { name: '相対', unlock_type: '順位', unlock_season_id: 'prev', unlock_value: '2' }).ok, true);
  eq(addSponsorTry(e, { name: '名指し', unlock_type: '順位', unlock_season_id: 's1', unlock_value: '2' }).ok, true);

  eq(e.copySponsors('ORG', { from_season_id: 's2', to_season_id: 's3' }).ok, true);
  const list = e.listSponsors('ORG', { season_id: 's3' }).data.sponsors;
  eq(list.find((s) => s.name === '相対').unlock_season_id, 'prev');
  eq(list.find((s) => s.name === '名指し').unlock_season_id, '');
});

// ---- 罰則: 主力放出 -------------------------------------------------------

/**
 * D に選手を3人持たせ、s1 のリーグ杯の試合で点を取らせる（リーグの順位は変えない）。
 * d1: 2点 / d2: 1点1アシスト / d3: 0点
 */
function withScorers(e, goals) {
  ['d1', 'd2', 'd3'].forEach((id, i) => {
    e.__addRow('Players', { player_id: id, name: 'D選手' + (i + 1), position: 'FW', real_club: 'チームD', eligible: true });
    e.__addRow('Rosters', { roster_id: 'rd' + i, season_id: 's1', team_id: 't_D', player_id: id, status: '在籍', acquisition_type: '初期', acquired_cost: 0 });
  });
  e.__addRow('Matches', {
    match_id: 'mx', season_id: 's1', stage: 'tournament', round: '1回戦', tie_id: 'q', leg: '',
    home_team: 't_D', away_team: 't_C', home_score: 3, away_score: 0,
    home_pk: '', away_pk: '', status: '承認', reported_by: 'u_org', created_at: new Date(),
  });
  (goals || [['d1', 'd2'], ['d1', ''], ['d2', 'd1']]).forEach(([sc, as], i) =>
    e.__addRow('MatchGoals', { goal_id: 'g' + i, match_id: 'mx', team_id: 't_D', scorer_id: sc, assist_id: as }));
  return e;
}

function releaseSponsor(e) {
  const id = addSponsor(e, { name: '航空会社', quota_type: 'リーグ順位', quota_value: '1', penalty: 80000000, penalty_release: true });
  eq(e.chooseSponsor('D', { season_id: 's1', sponsor_id: id }).ok, true);
  return id;
}

const close = (e) => e.closeSeason('ORG', { season_id: 's1', next_season_id: 's2' });
const rosterOf = (e, sid, tid) => e.__rows('Rosters').slice(1)
  .filter((r) => r[1] === sid && r[2] === tid && r[4] === '在籍').map((r) => r[3]).sort();

t('主力放出の設定が保存され、罰則の文言に出る', () => {
  const e = env();
  releaseSponsor(e);
  const s = e.listSponsors('ORG', { season_id: 's1' }).data.sponsors[0];
  eq(s.penalty_release, true);
  ok(s.penalty_label.includes('チーム内得点王をフリー放出'), s.penalty_label);
});

t('未達ならチーム内得点王を翌シーズンに引き継がず、オークションに回す', () => {
  const e = withScorers(env());
  seedLeague(e);   // D は最下位 → 未達
  releaseSponsor(e);

  const r = close(e);
  eq(r.ok, true, r.error);
  const res = r.data.report.sponsor_results.find((x) => x.team_id === 't_D');
  eq(res.met, false);
  eq(res.released.done, true);
  eq(res.released.name, 'D選手1');
  eq(res.released.goals, 3 - 1);

  eq(rosterOf(e, 's2', 't_D'), ['d2', 'd3'], 'd1 は引き継がない');
  eq(rosterOf(e, 's1', 't_D'), ['d1', 'd2', 'd3'], '今シーズンの記録はそのまま');

  const pool = e.__rows('AuctionPool');
  eq(pool.length, 2, '見出し＋1件');
  eq(pool[1][0], 's2');
  eq(pool[1][1], 'd1');
});

t('オークション送りの選手はエントリー変更でも補填でも拾えない', () => {
  const e = withScorers(env());
  seedLeague(e);
  releaseSponsor(e);
  close(e);

  e.__addRow('SeasonSchedule', { schedule_id: 'x1', season_id: 's2', date: new Date(2000, 0, 1), label: 'エントリー変更開始' });
  e.__addRow('SeasonSchedule', { schedule_id: 'x2', season_id: 's2', date: new Date(2100, 0, 1), label: 'エントリー変更締切' });
  const ec = e.getEntryChangeStatus('ORG', { season_id: 's2', team_id: 't_D' }).data;
  ok(!ec.candidates.some((c) => c.player_id === 'd1'), 'エントリー変更の候補に出ている');

  const cl = e.getMyClaims('ORG', { season_id: 's2', team_id: 't_D' }).data;
  ok(!cl.candidates.some((c) => c.player_id === 'd1'), '補填の候補に出ている');
});

t('ノルマを達成したら放出しない', () => {
  const e = withScorers(env());
  seedLeague(e);
  const id = addSponsor(e, { name: '緩い', quota_type: 'リーグ順位', quota_value: '4', penalty: 0, penalty_release: true });
  e.chooseSponsor('D', { season_id: 's1', sponsor_id: id });
  close(e);
  eq(rosterOf(e, 's2', 't_D'), ['d1', 'd2', 'd3']);
});

t('得点・アシストとも並んだら放出せず主催者に任せる', () => {
  const e = withScorers(env(), [['d1', ''], ['d2', '']]);
  seedLeague(e);
  releaseSponsor(e);
  const r = close(e);
  const res = r.data.report.sponsor_results.find((x) => x.team_id === 't_D');
  eq(res.released.done, false);
  eq(res.released.tied.sort(), ['D選手1', 'D選手2']);
  eq(rosterOf(e, 's2', 't_D'), ['d1', 'd2', 'd3']);
});

t('得点が同じならアシストの多い方', () => {
  const e = withScorers(env(), [['d1', ''], ['d2', 'd1']]);
  seedLeague(e);
  releaseSponsor(e);
  const res = close(e).data.report.sponsor_results.find((x) => x.team_id === 't_D');
  eq(res.released.name, 'D選手1');
});

t('期限付きで預かっている選手は放出の対象にしない', () => {
  const e = withScorers(env());
  const rows = e.__rows('Rosters');
  rows.slice(1).find((r) => r[3] === 'd1')[5] = '全期期限付き';
  e.__dropCache('Rosters');
  seedLeague(e);
  releaseSponsor(e);
  const res = close(e).data.report.sponsor_results.find((x) => x.team_id === 't_D');
  eq(res.released.name, 'D選手2');
});

report('sponsor3.js');
