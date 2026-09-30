const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t, eq, ok, report } = require('./harness');

// app.js の通信まわり。GAS は同時に動ける数に上限があり、通信の本数が
// そのまま順番待ちになる。同じ読み取りを使い回し、同じ瞬間の読み取りを
// 1回にまとめているかを確かめる。書き込みの後に古い値が残らないことも見る。

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function env(handler) {
  const sent = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, structuredClone,
    GM_CONFIG: { GAS_URL: 'https://example.invalid/exec' },
    getIdToken: () => 'TOKEN',
    isTokenExpired: () => false,
    document: { getElementById: () => null },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      const one = (a, p) => handler(a, p || {});
      const json = body.action === 'batch'
        ? { ok: true, data: { results: body.payload.calls.map((c) => one(c.action, c.payload)) } }
        : one(body.action, body.payload);
      return { ok: true, status: 200, json: async () => json };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.sent = sent;
  // 送った action を平らに並べる（batch は中身を展開）
  ctx.actions = () => sent.flatMap((b) =>
    b.action === 'batch' ? b.payload.calls.map((c) => c.action) : [b.action]);
  return ctx;
}

const okHandler = (a, p) => ({ ok: true, data: { action: a, payload: p, list: [1, 2, 3] } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tests = [];
const at = (name, fn) => tests.push([name, fn]);

at('同じ読み取りを2回呼んでも通信は1回', async () => {
  const e = env(okHandler);
  await e.callApi('listTeams', {});
  await e.callApi('listTeams', {});
  eq(e.sent.length, 1);
});

at('通信中の同じ読み取りは1本を共有する', async () => {
  const e = env(okHandler);
  const [a, b] = await Promise.all([e.callApi('listSeasons', {}), e.callApi('listSeasons', {})]);
  eq(e.actions(), ['listSeasons']);
  eq(a.ok && b.ok, true);
});

at('受け取った結果を書き換えても次の呼び出しに影響しない', async () => {
  const e = env(okHandler);
  const a = await e.callApi('listTeams', {});
  a.data.list.push(99);
  const b = await e.callApi('listTeams', {});
  eq(b.data.list, [1, 2, 3]);
});

at('payload が違えば別の読み取り', async () => {
  const e = env(okHandler);
  await e.callApi('listTransfers', { season_id: 's1' });
  await e.callApi('listTransfers', { season_id: 's2' });
  eq(e.sent.length, 2);
});

at('書き込みの後は取り直す', async () => {
  const e = env(okHandler);
  await e.callApi('listTransfers', { season_id: 's1' });
  await e.callApi('requestTransfer', { player_id: 'p1' });
  await e.callApi('listTransfers', { season_id: 's1' });
  eq(e.actions(), ['listTransfers', 'requestTransfer', 'listTransfers']);
});

at('書き込みの最中に返った読み取りは残さない', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const e = env(okHandler);
  const origFetch = e.fetch;
  e.fetch = async (url, opts) => {
    if (JSON.parse(opts.body).action === 'respondTransfer') await gate;
    return origFetch(url, opts);
  };
  const write = e.callApi('respondTransfer', { transfer_id: 't1' });
  await e.callApi('listTransfers', { season_id: 's1' });
  release();
  await write;
  await e.callApi('listTransfers', { season_id: 's1' });
  eq(e.actions().filter((a) => a === 'listTransfers').length, 2);
});

at('失敗した読み取りは残さない', async () => {
  let n = 0;
  const e = env((a) => (n++ === 0 ? { ok: false, error: 'busy' } : { ok: true, data: [] }));
  const a = await e.callApi('listSeasons', {});
  const b = await e.callApi('listSeasons', {});
  eq(a.ok, false);
  eq(b.ok, true);
  eq(e.sent.length, 2);
});

at('fresh を付けると取り直す', async () => {
  const e = env(okHandler);
  await e.callApi('listSeasons', {});
  await e.callApi('listSeasons', {}, { fresh: true });
  eq(e.sent.length, 2);
});

at('時間が経てば取り直す', async () => {
  const e = env(okHandler);
  const realNow = Date.now();
  vm.runInContext('Date.now = () => ' + realNow, e);
  await e.callApi('getUiState', {});
  vm.runInContext('Date.now = () => ' + (realNow + 29 * 1000), e);
  await e.callApi('getUiState', {});
  eq(e.sent.length, 1, '30秒以内は使い回す');
  vm.runInContext('Date.now = () => ' + (realNow + 31 * 1000), e);
  await e.callApi('getUiState', {});
  eq(e.sent.length, 2, '30秒を過ぎたら取り直す');
});

at('ログイン時は whoami と先読みが1回の通信にまとまる', async () => {
  const e = env(okHandler);
  const who = e.callApi('whoami');
  e.prefetchApi('listTeams', {});
  e.prefetchApi('getUiState', {});
  e.prefetchApi('getMyTeam', {});
  await who;
  await wait(5);
  eq(e.sent.length, 1);
  eq(e.sent[0].action, 'batch');
  eq(e.actions(), ['whoami', 'listTeams', 'getUiState', 'getMyTeam']);

  // 先読みしたものは通信せずに受け取れる
  const r = await e.callApi('getMyTeam', {});
  eq(r.data.action, 'getMyTeam');
  eq(e.sent.length, 1);
});

at('whoami は使い回さない', async () => {
  const e = env(okHandler);
  await e.callApi('whoami');
  await e.callApi('whoami');
  eq(e.sent.length, 2);
});

at('点検は使い回さない', async () => {
  const e = env(okHandler);
  await e.callApi('auditPlayerEligibility', {});
  await e.callApi('auditPlayerEligibility', {});
  eq(e.sent.length, 2);
});

at('書き込みはまとめない', async () => {
  const e = env(okHandler);
  await Promise.all([e.callApi('listTeams', {}), e.callApi('upsertTeam', { name: 'x' })]);
  ok(e.sent.every((b) => b.action !== 'batch'), JSON.stringify(e.sent.map((b) => b.action)));
});

at('prefetchApi は書き込みを投げない', async () => {
  const e = env(okHandler);
  e.prefetchApi('requestTransfer', {});
  await wait(30);
  eq(e.sent.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    let err = null;
    try { await fn(); } catch (x) { err = x; }
    t(name, () => { if (err) throw err; });
  }
  report('apicache.js');
})();
