const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 読み取りをまとめて1回で実行する batch。
// 参加者が一斉に使うと GAS の順番待ちで1回20〜40秒かかったため、通信の数を減らす。

const call = (e, token, payload) => e._route('batch', token, payload);

t('複数の読み取りを1回で返す', () => {
  const e = env();
  const r = call(e, 'A', { calls: [{ action: 'listTeams', payload: {} }, { action: 'listSeasons', payload: {} }] });
  eq(r.ok, true, r.error);
  eq(r.data.results.length, 2);
  eq(r.data.results[0].ok, true);
  eq(r.data.results[1].ok, true);
  eq(r.data.results[0].data.length, e.listTeams('A', {}).data.length);
});

t('書き込みの action は受け付けない', () => {
  const e = env();
  const r = call(e, 'ORG', { calls: [
    { action: 'listTeams', payload: {} },
    { action: 'upsertTeam', payload: { name: 'x' } },
  ] });
  eq(r.data.results[0].ok, true);
  eq(r.data.results[1].ok, false);
  ok(r.data.results[1].error.includes('まとめて実行できない'), r.data.results[1].error);
  eq(e.__rows('Teams').slice(1).some((x) => x[1] === 'x'), false, '書き込まれていない');
});

t('batch の入れ子は受け付けない', () => {
  const r = call(env(), 'A', { calls: [{ action: 'batch', payload: { calls: [] } }] });
  eq(r.data.results[0].ok, false);
});

t('上限を超えたら全体を拒否する', () => {
  const calls = Array.from({ length: 13 }, () => ({ action: 'listTeams', payload: {} }));
  eq(call(env(), 'A', { calls }).ok, false);
});

t('トークンが無効なら中身がそれぞれ失敗する', () => {
  const r = call(env(), 'BAD', { calls: [{ action: 'listTeams', payload: {} }] });
  eq(r.ok, true);
  eq(r.data.results[0].ok, false);
});

t('1件が例外でも他は返る', () => {
  const e = env();
  e.getSeasonSchedule = () => { throw new Error('boom'); };
  const r = call(e, 'A', { calls: [{ action: 'getSeasonSchedule', payload: {} }, { action: 'listTeams', payload: {} }] });
  eq(r.data.results[0].ok, false);
  eq(r.data.results[1].ok, true);
});

report('batch.js');
