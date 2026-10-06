const { t, eq, ok, report } = require('./harness');
const { env, seedLeague, seedCup } = require('./sp-fixture');

// GMリーグ杯（2レグ制トーナメント）と GMスーパーカップ（1試合）。
//
// 以前は GMリーグ杯の対戦表を作ると総当たりが出ていた。スーパーカップは
// 出場しないチームでも報告できた。

/**
 * s2（2027シーズン）に6チーム。前シーズン s1 のリーグ順位は A > B > C > D（E・F は出ていない）。
 * 前シーズンの GMリーグ杯は A が優勝・B が準優勝・C と D がベスト4（seedCup）。
 * 6チームなので8枠・シード2。決勝だけ1試合、それ以外は2レグ。
 */
function cup(over) {
  const e = env(over);
  ['E', 'F'].forEach((k) => {
    e.__tokens[k] = k.toLowerCase() + '@example.com';
    e.__addRow('Users', { user_id: 'u_' + k, email: k.toLowerCase() + '@example.com', display_name: 'GM' + k, role: 'team', team_id: 't_' + k });
    e.__addRow('Teams', { team_id: 't_' + k, name: 'チーム' + k, owner_user_id: 'u_' + k, kind: '継続', active: true });
  });
  ['A', 'B', 'C', 'D', 'E', 'F'].forEach((k) =>
    e.__addRow('SeasonTeams', { season_id: 's2', team_id: 't_' + k, division: 'GM1' }));
  const rows = e.__rows('Seasons');
  const col = rows[0];
  rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's2')[col.indexOf('leg_enabled')] = true;
  e.__dropCache('Seasons');
  seedLeague(e);
  seedCup(e, true);
  return e;
}

/** 抽選を固定する（並びをそのまま使う） */
const noShuffle = () => 0.999999;

const build = (e, payload) =>
  e.generateCupBracket('ORG', Object.assign({ season_id: 's2', rng: noShuffle }, payload || {}));

const bracket = (e, who) => e.getCupBracket(who || 'A', { season_id: 's2' }).data;

/** 承認済みの杯の試合を直接入れる */
function played(e, tie, leg, home, away, hs, as, pk) {
  e.__addRow('Matches', {
    match_id: 'c' + Math.random().toString(36).slice(2, 8),
    season_id: 's2', stage: 'tournament', round: '', tie_id: tie, leg,
    home_team: home, away_team: away, home_score: hs, away_score: as,
    home_pk: pk ? pk[0] : '', away_pk: pk ? pk[1] : '', status: '承認', reported_by: 'u_org',
    created_at: new Date(),
  });
  e.__dropCache('Matches');
}

const report0 = (e, who, home, away, extra) =>
  e.submitMatchResult(who, Object.assign({
    season_id: 's2', stage: 'tournament', round: '', home_team: home, away_team: away,
    home_score: 0, away_score: 0, goals: [], team_stats: [], gk_stats: [],
  }, extra || {}));

// =============================================================================
// トーナメント表の生成
// =============================================================================

t('GMリーグ杯の対戦表は総当たりではなくトーナメントになる', () => {
  const e = cup();
  const r = e.generateFixtures('ORG', { season_id: 's2', stage: 'tournament', rng: noShuffle });
  eq(r.ok, true, r.error);
  eq(r.data.size, 8);
  eq(r.data.byes, 2);
  eq(r.data.rounds, 3);

  const b = bracket(e);
  eq(b.rounds.map((x) => x.round), ['準々決勝', '準決勝', '決勝']);
  eq(b.rounds.map((x) => x.ties.length), [4, 2, 1]);
});

t('シードは前シーズンの GMリーグ杯の優勝・準優勝から。山を分ける', () => {
  const e = cup();
  eq(build(e).data.seeds, ['t_A', 't_B']);

  const r1 = bracket(e).rounds[0].ties;
  const byes = r1.filter((x) => x.bye);
  eq(byes.map((x) => [x.slot, x.team_a]), [[1, 't_A'], [3, 't_B']]);
  eq(byes.every((x) => x.winner === x.team_a && x.decided_by === 'シード'), true);
});

t('決勝以外は2レグ、決勝は1試合', () => {
  const e = cup();
  build(e);
  const b = bracket(e);
  ok(b.rounds[0].ties.filter((x) => !x.bye).every((x) => x.leg_count === 2), '準々決勝は2レグ');
  ok(b.rounds[1].ties.every((x) => x.leg_count === 2), '準決勝は2レグ');
  eq(b.rounds[2].ties[0].leg_count, 1);
});

t('2レグのホームは1stと2ndで入れ替わる', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  eq([tie.legs[0].home, tie.legs[0].away], [tie.team_a, tie.team_b]);
  eq([tie.legs[1].home, tie.legs[1].away], [tie.team_b, tie.team_a]);
});

t('リーグ戦の順位ではなく、GMリーグ杯の成績で決める', () => {
  const e = cup();
  // 杯は B が優勝・A が準優勝に入れ替える（リーグは A が1位のまま）
  const rows = e.__rows('Matches');
  const col = rows[0];
  const fin = rows.slice(1).find((r) => r[col.indexOf('tie_id')] === 'f1');
  fin[col.indexOf('home_score')] = 0;
  fin[col.indexOf('away_score')] = 1;
  e.__dropCache('Matches');
  eq(build(e).data.seeds, ['t_B', 't_A']);
});

t('3枠目以降のシードはベスト4から', () => {
  // 5チームなら8枠でシード3
  const five = cup();
  const st = five.__rows('SeasonTeams');
  const sc = st[0];
  st.splice(st.findIndex((r) => r[sc.indexOf('season_id')] === 's2' && r[sc.indexOf('team_id')] === 't_F'), 1);
  five.__dropCache('SeasonTeams');
  eq(build(five).data.seeds, ['t_A', 't_B', 't_C']);
});

t('前シーズンの GMリーグ杯の記録が無ければ、シードを選ぶよう求める', () => {
  const e = cup();
  const rows = e.__rows('Matches');
  const col = rows[0];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][col.indexOf('stage')] === 'tournament') rows.splice(i, 1);
  }
  e.__dropCache('Matches');
  const r = build(e);
  eq(r.ok, false);
  ok(r.error.includes('GMリーグ杯') && r.error.includes('2 チーム'), r.error);
});

t('シードを選べば、その順で使う', () => {
  const e = cup();
  const r = build(e, { seeds: ['t_E', 't_F'] });
  eq(r.ok, true, r.error);
  eq(bracket(e).rounds[0].ties.filter((x) => x.bye).map((x) => x.team_a), ['t_E', 't_F']);
});

t('シードの数が合わなければ断る', () => {
  eq(build(cup(), { seeds: ['t_E'] }).ok, false);
});

t('既にあれば上書きを求める', () => {
  const e = cup();
  build(e);
  eq(build(e).ok, false);
  eq(build(e, { replace: true }).ok, true);
});

t('主催者だけが作れる', () => {
  eq(cup().generateCupBracket('A', { season_id: 's2' }).ok, false);
});

// =============================================================================
// 報告画面に出る対戦
// =============================================================================

t('報告画面にはレグごとに出る', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  const fx = e.getFixtures('A', { season_id: 's2', stage: 'tournament' }).data.fixtures
    .filter((f) => f.tie_id === tie.tie_id);
  eq(fx.map((f) => f.label), ['準々決勝 1stレグ', '準々決勝 2ndレグ']);
});

t('勝ち上がりが決まるまで、次のラウンドは報告画面に出ない', () => {
  const e = cup();
  build(e);
  const fx = e.getFixtures('A', { season_id: 's2', stage: 'tournament' }).data.fixtures;
  ok(fx.every((f) => f.round === '準々決勝'), JSON.stringify(fx.map((f) => f.round)));
});

// =============================================================================
// 報告と勝ち上がり
// =============================================================================

t('1stレグを報告すると、トーナメント表のタイ・レグ・ラウンドにそろう', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  const team = tie.team_a.replace('t_', '');

  const r = report0(e, team, tie.team_a, tie.team_b, { leg: '1', round: '適当' });
  eq(r.ok, true, r.error);

  const m = e.__rows('Matches').slice(-1)[0];
  const col = e.__rows('Matches')[0];
  eq(m[col.indexOf('tie_id')], tie.tie_id);
  eq(String(m[col.indexOf('leg')]), '1');
  eq(m[col.indexOf('round')], '準々決勝');
});

t('レグを指定しなくても、ホームのチームから決まる', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  const team = tie.team_b.replace('t_', '');
  const r = report0(e, team, tie.team_b, tie.team_a);
  eq(r.ok, true, r.error);
  const col = e.__rows('Matches')[0];
  eq(String(e.__rows('Matches').slice(-1)[0][col.indexOf('leg')]), '2');
});

t('同じレグは2回報告できない', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  const team = tie.team_a.replace('t_', '');
  eq(report0(e, team, tie.team_a, tie.team_b, { leg: '1' }).ok, true);
  eq(report0(e, team, tie.team_a, tie.team_b, { leg: '1' }).ok, false);
});

t('トーナメント表に無い対戦は報告できない', () => {
  const e = cup();
  build(e);
  // A と B はシード同士で、決勝まで当たらない
  const r = report0(e, 'A', 't_A', 't_B');
  eq(r.ok, false);
  ok(r.error.includes('トーナメント表に無い'), r.error);
});

t('2レグの合計スコアで勝ち上がりが決まり、次のラウンドに入る', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye && x.slot === 2);
  played(e, tie.tie_id, '1', tie.team_a, tie.team_b, 2, 1);

  let t2 = bracket(e).rounds[0].ties.find((x) => x.tie_id === tie.tie_id);
  eq(t2.winner, '', '1stレグだけでは決まらない');
  eq([t2.agg_a, t2.agg_b], [2, 1]);

  played(e, tie.tie_id, '2', tie.team_b, tie.team_a, 2, 0);
  const b = bracket(e);
  t2 = b.rounds[0].ties.find((x) => x.tie_id === tie.tie_id);
  eq([t2.agg_a, t2.agg_b], [2, 3]);
  eq(t2.winner, tie.team_b);
  eq(t2.decided_by, '合計スコア');

  // 準決勝1：シードA（枠1）と枠2の勝者
  const semi = b.rounds[1].ties[0];
  eq([semi.team_a, semi.team_b], ['t_A', tie.team_b]);
  eq(semi.legs[0].home, 't_A', '1stレグは上の山の勝者がホーム');
});

t('合計が並べば、2ndレグのPKで決まる', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  played(e, tie.tie_id, '1', tie.team_a, tie.team_b, 1, 0);
  played(e, tie.tie_id, '2', tie.team_b, tie.team_a, 1, 0, [4, 5]);
  const t2 = bracket(e).rounds[0].ties.find((x) => x.tie_id === tie.tie_id);
  eq(t2.winner, tie.team_a);
  eq(t2.decided_by, 'PK戦');
});

t('勝ち上がったチームは次のラウンドを報告できる', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => x.slot === 2);
  played(e, tie.tie_id, '1', tie.team_a, tie.team_b, 1, 0);
  played(e, tie.tie_id, '2', tie.team_b, tie.team_a, 0, 0);

  const r = report0(e, 'A', 't_A', tie.team_a, { leg: '1' });
  eq(r.ok, true, r.error);
  const col = e.__rows('Matches')[0];
  const m = e.__rows('Matches').slice(-1)[0];
  eq(m[col.indexOf('tie_id')], 'R2-01');
  eq(m[col.indexOf('round')], '準決勝');
});

t('決勝は1試合で、レグは付かない', () => {
  const e = cup();
  build(e);
  const b0 = bracket(e);
  const [q2, q4] = [b0.rounds[0].ties[1], b0.rounds[0].ties[3]];
  [q2, q4].forEach((q) => {
    played(e, q.tie_id, '1', q.team_a, q.team_b, 1, 0);
    played(e, q.tie_id, '2', q.team_b, q.team_a, 0, 0);
  });
  played(e, 'R2-01', '1', 't_A', q2.team_a, 1, 0);
  played(e, 'R2-01', '2', q2.team_a, 't_A', 0, 0);
  played(e, 'R2-02', '1', 't_B', q4.team_a, 1, 0);
  played(e, 'R2-02', '2', q4.team_a, 't_B', 0, 0);

  const r = report0(e, 'A', 't_A', 't_B', { leg: '2' });
  eq(r.ok, true, r.error);
  const col = e.__rows('Matches')[0];
  const m = e.__rows('Matches').slice(-1)[0];
  eq(m[col.indexOf('tie_id')], 'R3-01');
  eq(String(m[col.indexOf('leg')]), '');
  eq(m[col.indexOf('round')], '決勝');
});

t('賞金の判定に使う並びは、決勝が最後になる', () => {
  const e = cup();
  build(e);
  const b0 = bracket(e);
  const [q2, q4] = [b0.rounds[0].ties[1], b0.rounds[0].ties[3]];
  // 決勝を先に入れ、準決勝を後から入れる
  played(e, 'R3-01', '', 't_A', 't_B', 1, 0);
  [q2, q4].forEach((q) => {
    played(e, q.tie_id, '1', q.team_a, q.team_b, 1, 0);
    played(e, q.tie_id, '2', q.team_b, q.team_a, 0, 0);
  });
  played(e, 'R2-01', '1', 't_A', q2.team_a, 1, 0);
  played(e, 'R2-01', '2', q2.team_a, 't_A', 0, 0);
  const ties = e.getTournament('ORG', { season_id: 's2' }).data.ties;
  eq(ties[ties.length - 1].tie_id, 'R3-01');
});

// =============================================================================
// 手直し
// =============================================================================

t('2チームの位置を入れ替えられる（シードも移る）', () => {
  const e = cup();
  build(e);
  const other = bracket(e).rounds[0].ties.find((x) => !x.bye).team_a;
  eq(e.swapCupTeams('ORG', { season_id: 's2', team_a: 't_A', team_b: other }).ok, true);
  const byes = bracket(e).rounds[0].ties.filter((x) => x.bye).map((x) => x.team_a);
  ok(byes.indexOf(other) !== -1 && byes.indexOf('t_A') === -1, JSON.stringify(byes));
});

t('H/A入替は2レグをまとめて入れ替える', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  eq(e.swapFixtureSides('ORG', { fixture_id: tie.legs[0].fixture_id }).ok, true);
  const t2 = bracket(e).rounds[0].ties.find((x) => x.tie_id === tie.tie_id);
  eq([t2.legs[0].home, t2.legs[1].home], [tie.team_b, tie.team_a]);
});

t('試合が報告されたら組み合わせは動かせない', () => {
  const e = cup();
  build(e);
  const tie = bracket(e).rounds[0].ties.find((x) => !x.bye);
  report0(e, tie.team_a.replace('t_', ''), tie.team_a, tie.team_b, { leg: '1' });
  eq(e.swapCupTeams('ORG', { season_id: 's2', team_a: 't_A', team_b: tie.team_a }).ok, false);
  eq(build(e, { replace: true }).ok, false);
});

// =============================================================================
// GMスーパーカップ
// =============================================================================

const sc = (e) => e.setSuperCup('ORG', { season_id: 's2', team_a: 't_C', team_b: 't_D' });
const reportSc = (e, who, home, away, extra) =>
  e.submitMatchResult(who, Object.assign({
    season_id: 's2', stage: 'supercup', round: '', home_team: home, away_team: away,
    home_score: 0, away_score: 0, home_pk: 5, away_pk: 4, goals: [], team_stats: [], gk_stats: [],
  }, extra || {}));

t('スーパーカップは保存した2チームだけが報告できる', () => {
  const e = cup();
  sc(e);
  const r = reportSc(e, 'A', 't_A', 't_C');
  eq(r.ok, false);
  ok(r.error.includes('チームC') && r.error.includes('チームD'), r.error);
});

t('主催者でも、保存したカード以外では報告できない', () => {
  const e = cup();
  sc(e);
  eq(reportSc(e, 'ORG', 't_A', 't_B').ok, false);
});

t('カードが保存されていなければ報告できない', () => {
  const r = reportSc(cup(), 'C', 't_C', 't_D');
  eq(r.ok, false);
  ok(r.error.includes('保存されていません'), r.error);
});

t('出場チームは報告でき、1試合なのでレグは付かない', () => {
  const e = cup();
  sc(e);
  const r = reportSc(e, 'D', 't_D', 't_C', { leg: '2', tie_id: 'x' });
  eq(r.ok, true, r.error);
  const col = e.__rows('Matches')[0];
  const m = e.__rows('Matches').slice(-1)[0];
  eq(String(m[col.indexOf('leg')]), '');
  eq(m[col.indexOf('tie_id')], '');
  eq(m[col.indexOf('round')], 'GMスーパーカップ');
  eq(String(m[col.indexOf('home_pk')]), '5');
});

t('スーパーカップは2回報告できない', () => {
  const e = cup();
  sc(e);
  eq(reportSc(e, 'C', 't_C', 't_D').ok, true);
  eq(reportSc(e, 'D', 't_D', 't_C').ok, false);
});

t('報告画面の対戦表には保存したカードが出る', () => {
  const e = cup();
  sc(e);
  const fx = e.getFixtures('C', { season_id: 's2', stage: 'supercup' }).data.fixtures;
  eq(fx.length, 1);
  eq([fx[0].home_team, fx[0].away_team], ['t_C', 't_D']);
});

t('報告画面は出場チームを知っている', () => {
  const e = cup();
  sc(e);
  build(e);
  const d = e.getMatchOptions('E', { season_id: 's2' }).data;
  eq(d.supercup_teams, ['t_C', 't_D']);
  eq(d.cup_bracket, true);
  eq(d.cup_teams.length, 6);
});

t('スーパーカップを総当たりで作ろうとしたら断る', () => {
  eq(cup().generateFixtures('ORG', { season_id: 's2', stage: 'supercup' }).ok, false);
});

report('cup.js');
