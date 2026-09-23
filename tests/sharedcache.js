const vm = require('vm');
const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// リクエストをまたぐ読み取りキャッシュ（CacheService）。
// 参加者が一斉に使うと GAS の順番待ちで1回20〜40秒かかったため、
// ほぼ全ての通信で読む参照用の表だけを使い回す。

function fakeCache() {
  const store = {};
  return {
    store,
    get: (k) => (k in store ? store[k] : null),
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
    put: (k, v) => { store[k] = v; },
    putAll: (o) => Object.assign(store, o),
    remove: (k) => { delete store[k]; },
  };
}

function withCache() {
  const e = env();
  const c = fakeCache();
  e.CacheService = { getScriptCache: () => c };
  e.__cache = c;
  return e;
}

/** 次のリクエストを始める（1リクエスト内のキャッシュを捨てる） */
const nextRequest = (e) => vm.runInContext('_sheetDataCache = {}; _configCache = null; _touchedSheets = {};', e);

/** シートを直接書き換える（スプレッドシートを手で編集したのと同じ） */
function editTeamNameDirectly(e, teamId, name) {
  const rows = e.__store.Teams.values;
  const c = rows[0];
  rows.find((r) => r[c.indexOf('team_id')] === teamId)[c.indexOf('name')] = name;
}

t('2回目のリクエストはキャッシュから読む', () => {
  const e = withCache();
  eq(e.findRow('Teams', 'team_id', 't_A').name, 'チームA');
  nextRequest(e);
  editTeamNameDirectly(e, 't_A', '直接書き換え');
  // キャッシュに載っているので古い値のまま（直接編集は TTL まで見えない）
  eq(e.findRow('Teams', 'team_id', 't_A').name, 'チームA');
});

t('ツール経由の書き込みはすぐに反映される', () => {
  const e = withCache();
  e.findRow('Teams', 'team_id', 't_A');
  nextRequest(e);
  e.withLock(() => e.updateRow('Teams', 'team_id', 't_A', { name: '新しい名前' }));
  nextRequest(e);
  eq(e.findRow('Teams', 'team_id', 't_A').name, '新しい名前');
});

t('書き込み中に別の通信が読んでも、古い値をキャッシュに残さない', () => {
  const e = withCache();
  e.findRow('Teams', 'team_id', 't_A');           // キャッシュに載る
  nextRequest(e);
  // 書き込み側がシートを取った（版が進む）あと、読み手が古い版で読み始めた想定
  const before = vm.runInContext('_sharedCacheGet("Teams").version', e);
  e.withLock(() => e.updateRow('Teams', 'team_id', 't_A', { name: 'X' }));
  // 読み手が古い版のまま置こうとしても置けない
  vm.runInContext('_sharedCachePut("Teams", ' + JSON.stringify(before) + ', [["team_id","name"],["t_A","古い"]])', e);
  nextRequest(e);
  eq(e.findRow('Teams', 'team_id', 't_A').name, 'X');
});

t('お金と保有に関わる表はキャッシュしない', () => {
  const e = withCache();
  ['Rosters', 'BudgetTx', 'Transfers', 'Claims'].forEach((n) => e.getSheetData(n));
  const keys = Object.keys(e.__cache.store).filter((k) => k.startsWith('sd:'));
  ok(!keys.some((k) => /Rosters|BudgetTx|Transfers|Claims/.test(k)), keys.join(','));
});

t('日付は Date のまま戻る', () => {
  const e = withCache();
  e.__addRow('Seasons', { season_id: 's9', name: 'Season9', status: '終了', window1_open_at: vm.runInContext('new Date(2026, 8, 30, 0, 30)', e) });
  e.getSheetData('Seasons');
  nextRequest(e);
  const s = e.findRow('Seasons', 'season_id', 's9');
  eq(Object.prototype.toString.call(s.window1_open_at), '[object Date]');
  eq(new Date(s.window1_open_at).getMinutes(), 30);
});

t('CacheService が無い環境でも動く', () => {
  const e = env();
  eq(e.findRow('Teams', 'team_id', 't_A').name, 'チームA');
});

report('sharedcache.js');
