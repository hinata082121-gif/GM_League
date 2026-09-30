/**
 * app.js — GAS API 共通 fetch ラッパ
 *
 * 役割:
 *   - callApi(action, payload) : GAS Web App に JSON-RPC 風リクエストを送る
 *   - onSignIn / onSignOut : auth.js からのコールバックを受けてUI切替
 *   - renderUserInfo : whoami 結果をユーザーバーに表示
 *
 * doPost 規約（SPEC.md §8）:
 *   リクエスト: { action: string, token: string, payload: object }
 *   成功: { ok: true,  data: any }
 *   失敗: { ok: false, error: string }
 *
 * 依存:
 *   - config.js (GM_CONFIG.GAS_URL)
 *   - auth.js   (getIdToken, signOut)
 */

// ---------------------------------------------------------------------------
// GAS API 共通ラッパ
// ---------------------------------------------------------------------------

/**
 * GAS Web App に action を送り、{ ok, data } / { ok:false, error } を返す。
 *
 * ポイント:
 *   - Content-Type: text/plain で送ることで CORS プリフライトを回避する
 *     （GAS は text/plain の POST を e.postData.contents で受け取れる）
 *   - redirect: 'follow' で GAS が返すリダイレクト（302）を自動追跡する
 *
 * @param {string} action       GAS 側の action 名（例: "whoami"）
 * @param {Object} [payload={}] action ごとのパラメータ
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 *
 * @example
 *   const res = await callApi('whoami');
 *   if (res.ok) console.log(res.data.role);
 */
function callApi(action, payload = {}, opts = {}) {
  if (_isCacheableRead(action)) return _cachedRead(action, payload, opts.fresh);

  // 書き込みの前後で使い回しを捨てる。自分の操作の結果がすぐ画面に出るように。
  // 後にも捨てるのは、書き込みの最中に出た読み取りが古い値を持ち帰るため
  if (!_isReadAction(action)) {
    _clearReadCache();
    const p = _sendApi(action, payload);
    p.then(_clearReadCache, _clearReadCache);
    return p;
  }

  return _sendApi(action, payload);
}

/**
 * 読み取りの結果を使い回す秒数。
 *
 * タブを行き来するたびに同じ一覧を取り直すと、そのぶん GAS の順番待ちが伸びる。
 * 他の参加者の操作が画面に出るのは最大この時間だけ遅れる。
 * 自分が書き込んだときは即座に捨てるので、自分の操作は遅れない。
 * 最終的な判定はすべて GAS 側で行うので、古い表示から操作しても不正にはならない。
 */
const READ_CACHE_TTL_MS = 30 * 1000;

/** action + payload → { gen, at, promise }。at は応答が返った時刻（通信中は 0） */
const _readCache = new Map();
/** 書き込みのたびに進める。古い世代の読み取り結果はキャッシュに残さない */
let _readCacheGen = 0;

/**
 * 使い回してよい読み取りか。
 *
 * 点検（audit）は、主催者がスプレッドシートを直した直後に押し直して
 * 結果を確かめるためのものなので、毎回取り直す。
 */
function _isCacheableRead(action) {
  return action !== 'whoami' && !/^audit/.test(action) && _isReadAction(action);
}

/** 使い回しを全部捨てる。書き込みの前後とログイン・ログアウト時に呼ぶ */
function _clearReadCache() {
  _readCacheGen++;
  _readCache.clear();
}

/**
 * 読み取りを1回の通信で済ませる。
 *
 * - 同じ読み取りが通信中なら、その結果を待つ（同時に2本投げない）
 * - READ_CACHE_TTL_MS 以内に取った結果があればそれを返す
 * - 失敗した結果は残さない（次に開いたとき取り直す）
 *
 * 呼び出し側が結果を書き換えても他へ影響しないよう、毎回複製して渡す。
 *
 * @param {string} action
 * @param {Object} payload
 * @param {boolean} fresh true なら使い回さずに取り直す
 * @returns {Promise<Object>}
 */
function _cachedRead(action, payload, fresh) {
  const key = action + '\u0000' + JSON.stringify(payload || {});
  const hit = _readCache.get(key);
  const alive = hit && (hit.at === 0 || Date.now() - hit.at < READ_CACHE_TTL_MS);

  if (hit && alive && !fresh) return hit.promise.then(_cloneResult);

  const entry = { gen: _readCacheGen, at: 0, promise: null };
  entry.promise = _sendApi(action, payload).then((res) => {
    if (_readCache.get(key) === entry) {
      if (res.ok && entry.gen === _readCacheGen) entry.at = Date.now();
      else _readCache.delete(key);
    }
    return res;
  });
  _readCache.set(key, entry);
  return entry.promise.then(_cloneResult);
}

function _cloneResult(res) {
  if (typeof structuredClone === 'function') return structuredClone(res);
  return JSON.parse(JSON.stringify(res));
}

/**
 * 画面を開く前に読み取りを先に投げておく。
 *
 * 結果は使い回しに入るので、後から同じ読み取りを呼ぶと通信せずに受け取れる。
 * 順番に await している画面でも、先に投げておけば1回の通信にまとまる。
 *
 * @param {string} action
 * @param {Object} [payload={}]
 */
function prefetchApi(action, payload = {}) {
  if (!_isCacheableRead(action)) return;
  callApi(action, payload).catch(() => {});
}

function _sendApi(action, payload) {
  // 読み取りは同じ瞬間に出たものを1回の通信にまとめる（_flushBatch）。
  // GAS は同時に動ける数に上限があり、通信の数そのものが混雑の原因になるため
  if (_isBatchable(action, payload)) {
    return new Promise((resolve) => {
      _batchQueue.push({ action, payload, resolve });
      if (!_batchTimer) _batchTimer = setTimeout(_flushBatch, BATCH_WAIT_MS);
    });
  }
  return _callApiDirect(action, payload);
}

/** まとめる待ち時間。画面を開いたときに同時に出る取得がここに収まる */
const BATCH_WAIT_MS = 15;
/** 1回にまとめる上限（GAS 側の BATCH_MAX と合わせる） */
const BATCH_MAX = 12;
let _batchQueue = [];
let _batchTimer = null;
/** GAS が batch を知らない（古いデプロイ）と分かったら以後まとめない */
let _batchUnsupported = false;

function _isBatchable(action, payload) {
  if (_batchUnsupported) return false;
  if (payload && payload.__retried) return false;
  // whoami もまとめる。ログイン時に最初の画面の読み取りと1回で済ませるため
  return _isReadAction(action);
}

/**
 * たまった読み取りを1回の通信で送る。
 * 1件だけなら普通に送る。まとめた通信が失敗したら、1件ずつ送り直す
 * （それぞれが自分の再試行を持っているので、ここでは重ねて再試行しない）。
 */
async function _flushBatch() {
  const queue = _batchQueue;
  _batchQueue = [];
  _batchTimer = null;

  for (let i = 0; i < queue.length; i += BATCH_MAX) {
    const group = queue.slice(i, i + BATCH_MAX);
    if (group.length === 1) {
      group[0].resolve(await _callApiDirect(group[0].action, group[0].payload));
      continue;
    }
    _sendBatch(group);
  }
}

async function _sendBatch(group) {
  const res = await _callApiDirect('batch', {
    calls: group.map((g) => ({ action: g.action, payload: g.payload })),
  });

  const results = res.ok && res.data && res.data.results;
  if (results && results.length === group.length) {
    // ログイン時の束（whoami 入り）でトークンが無効なら、onSignIn が案内を出す
    const atLogin = group.some((g) => g.action === 'whoami');
    group.forEach((g, i) => {
      const r = results[i];
      if (!r.ok && r.error === 'invalid_token' && !atLogin) showSessionExpired();
      g.resolve(r);
    });
    return;
  }

  if (!res.ok && /Unknown action: batch/.test(res.error || '')) {
    console.warn('[callApi] GAS が batch に未対応のため、1件ずつ送ります');
    _batchUnsupported = true;
  }

  // まとめて送れなかったので1件ずつ送る
  group.forEach(async (g) => g.resolve(await _callApiDirect(g.action, g.payload)));
}

async function _callApiDirect(action, payload = {}) {
  const token = getIdToken();
  if (!token) {
    return { ok: false, error: 'no_token' };
  }

  if (GM_CONFIG.GAS_URL.includes('PLACEHOLDER')) {
    console.error('[callApi] GAS_URL が未設定です。config.js を確認してください。');
    return { ok: false, error: 'gas_url_not_set' };
  }

  // トークンが切れているなら通信せずに打ち切り、再ログインを促す
  // （切れたまま投げても GAS 側で invalid_token になるだけなので無駄な往復を省く）
  if (isTokenExpired()) {
    console.warn('[callApi] トークン期限切れのため中断:', action);
    showSessionExpired();
    return { ok: false, error: 'token_expired' };
  }

  const body = JSON.stringify({ action, token, payload });

  try {
    const res = await fetch(GM_CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',   // GAS の 302 リダイレクトを自動追跡
    });

    // GAS はデプロイ直後の伝播中に一時的に 404 を返すことがある。
    // 1回だけ間を置いて再試行する。
    if (res.status === 404 && !payload.__retried) {
      console.warn('[callApi] http_404。1.5秒後に再試行します:', action);
      await new Promise((r) => setTimeout(r, 1500));
      return _callApiDirect(action, Object.assign({}, payload, { __retried: true }));
    }

    if (!res.ok) {
      // 読み取りは何度投げても結果が変わらないので、混雑による一時的な失敗は1回だけ投げ直す
      if (res.status >= 500 && _isReadAction(action) && !payload.__retried) {
        await new Promise((r) => setTimeout(r, 2000));
        return _callApiDirect(action, Object.assign({}, payload, { __retried: true }));
      }
      return { ok: false, error: `http_${res.status}` };
    }

    const json = await res.json();

    // whoami 以外の action でトークン切れが返ってきた場合もここで拾う
    if (!json.ok && json.error === 'invalid_token' && action !== 'whoami') {
      showSessionExpired();
    }

    return json; // { ok, data } or { ok:false, error }

  } catch (err) {
    // GAS が混んでいると応答が返らずに通信が切れる（Failed to fetch）。
    // 読み取りだけ1回投げ直す。書き込みは向こうで処理済みのことがあるので投げ直さない
    if (_isReadAction(action) && !payload.__retried) {
      console.warn('[callApi] 通信失敗。2秒後に再試行します:', action, err.message);
      await new Promise((r) => setTimeout(r, 2000));
      return _callApiDirect(action, Object.assign({}, payload, { __retried: true }));
    }
    console.error('[callApi] fetch 失敗:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * 投げ直しても害のない読み取りの action か。
 *
 * 名前で判定する。書き込みを誤って投げ直すと二重に計上されうるので、
 * 読み取りだと確実に分かる接頭辞だけを通す。
 *
 * @param {string} action
 * @returns {boolean}
 */
function _isReadAction(action) {
  return /^(get|list|search|whoami$|audit)/.test(action);
}

// ---------------------------------------------------------------------------
// セッション期限の通知
// ---------------------------------------------------------------------------

/**
 * 期限が近づいたときに auth.js のタイマーから呼ばれる。
 * まだ操作は可能なので、警告だけ出して続行させる。
 */
function onTokenExpiring() {
  const left = getTokenMinutesLeft();
  _showSessionBanner(
    'warn',
    'ログインセッションがまもなく切れます（残り約 ' + left + ' 分）。',
    '今すぐ再ログイン'
  );
}

/**
 * トークンが切れて API が呼べなくなったときに表示する。
 * 同じバナーを何度も出さないよう、表示済みなら何もしない。
 */
function showSessionExpired() {
  const el = document.getElementById('session-banner');
  if (el && el.dataset.state === 'expired') return;

  _showSessionBanner(
    'expired',
    'ログインセッションの有効期限が切れました。再ログインしてください。',
    '再ログイン'
  );
}

/**
 * セッション通知バナーを表示する。
 *
 * @param {string} state   'warn' | 'expired'
 * @param {string} message 本文
 * @param {string} btnText ボタン文言
 */
function _showSessionBanner(state, message, btnText) {
  const el = document.getElementById('session-banner');
  if (!el) return;

  el.dataset.state = state;
  el.className = 'session-banner session-' + state;
  el.innerHTML = '';

  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);

  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-secondary';
  btn.textContent = btnText;
  btn.onclick = () => {
    hideSessionBanner();
    requestReauth();
  };
  el.appendChild(btn);

  el.style.display = 'flex';
}

/**
 * セッション通知バナーを隠す。
 */
function hideSessionBanner() {
  const el = document.getElementById('session-banner');
  if (!el) return;
  el.style.display = 'none';
  delete el.dataset.state;
}

// ---------------------------------------------------------------------------
// auth.js からのコールバックを受けるハンドラ
// ---------------------------------------------------------------------------

/**
 * Google ログイン成功時に auth.js から呼ばれる。
 * whoami を呼んでユーザー確認 → 結果に応じて画面を切り替える。
 *
 * @param {string} token - ID トークン（JWT）
 */
async function onSignIn(token) {
  console.log('[app] onSignIn — whoami 呼び出し中...');

  const loginSection  = document.getElementById('login-section');
  const appSection    = document.getElementById('app-section');
  const loadingEl     = document.getElementById('loading-message');

  // ログイン画面を隠してローディング表示
  if (loginSection) loginSection.style.display = 'none';
  if (loadingEl)    loadingEl.style.display    = 'block';

  // 別のアカウントで入り直したときに前の人の結果を見せない
  _clearReadCache();

  // 最初の画面で使う読み取りを whoami と一緒に投げ、1回の通信で済ませる。
  // これまでは whoami → 一覧 → ダッシュボード と順に待っていたので、
  // 混雑時は順番待ちがそのまま3回ぶん積み上がっていた
  const whoamiLoad = callApi('whoami');
  if (typeof prefetchInitialViews === 'function') prefetchInitialViews();
  const res = await whoamiLoad;

  if (loadingEl) loadingEl.style.display = 'none';

  if (res.ok) {
    // ✅ 登録済みユーザー
    console.log('[app] whoami 成功:', res.data);
    hideSessionBanner();
    if (appSection) appSection.style.display = 'block';
    renderUserInfo(res.data);

    // Phase 1 の画面を初期化（views.js）
    if (typeof initViews === 'function') {
      initViews(res.data);
    }

  } else if (res.error === 'unregistered') {
    // ❌ Users シートに email がない
    console.warn('[app] 未登録ユーザー');
    if (loginSection) loginSection.style.display = 'block';
    _showLoginError('このアカウントは登録されていません。\n主催者にお問い合わせください。');
    signOut(); // auth.js のトークンもクリア

  } else if (res.error === 'invalid_token') {
    // ❌ トークン期限切れ・改ざん
    console.error('[app] トークンが無効');
    if (loginSection) loginSection.style.display = 'block';
    _showLoginError('ログインセッションが無効です。もう一度サインインしてください。');
    signOut();

  } else if (res.error === 'gas_url_not_set') {
    // ❌ config.js の GAS_URL が未設定（開発時）
    if (loginSection) loginSection.style.display = 'block';
    _showLoginError('GAS URL が設定されていません（config.js を確認）。');

  } else {
    // ❌ その他のエラー
    console.error('[app] whoami 失敗:', res.error);
    if (loginSection) loginSection.style.display = 'block';
    _showLoginError('エラーが発生しました: ' + (res.error || '不明'));
    signOut();
  }
}

/**
 * ログアウト時に auth.js から呼ばれる。
 * アプリ画面を隠し、ログイン画面に戻す。
 */
function onSignOut() {
  const loginSection = document.getElementById('login-section');
  const appSection   = document.getElementById('app-section');
  const errorEl      = document.getElementById('login-error');

  if (appSection)   appSection.style.display   = 'none';
  if (loginSection) loginSection.style.display = 'block';
  if (errorEl)      errorEl.style.display      = 'none'; // エラーメッセージをクリア
  hideSessionBanner();
  _clearReadCache();

  console.log('[app] onSignOut — ログイン画面に戻りました');
}

// ---------------------------------------------------------------------------
// UI 描画
// ---------------------------------------------------------------------------

/**
 * whoami のレスポンスをユーザーバーに反映する。
 *
 * 対応する HTML 要素:
 *   #user-name  — 表示名
 *   #user-role  — ロールバッジ（organizer / team）
 *   #user-team  — チーム ID（team ロールのみ表示）
 *
 * @param {{ user_id: string, email: string, display_name: string, role: string, team_id: string }} user
 */
function renderUserInfo(user) {
  const nameEl = document.getElementById('user-name');
  const roleEl = document.getElementById('user-role');
  const teamEl = document.getElementById('user-team');

  // 表示名（display_name がなければ email を表示）
  if (nameEl) {
    nameEl.textContent = user.display_name || user.email;
  }

  // ロールバッジ
  if (roleEl) {
    if (user.role === 'organizer') {
      roleEl.textContent  = '主催者';
      roleEl.className    = 'role-badge role-organizer';
    } else {
      roleEl.textContent  = 'チームオーナー';
      roleEl.className    = 'role-badge role-team';
    }
  }

  // チーム ID（organizer は非表示）
  if (teamEl) {
    if (user.team_id && user.role !== 'organizer') {
      teamEl.textContent   = 'チーム: ' + user.team_id;
      teamEl.style.display = 'inline-block';
    } else {
      teamEl.style.display = 'none';
    }
  }
}

/**
 * ログイン画面にエラーメッセージを表示する。
 * @param {string} msg
 */
function _showLoginError(msg) {
  const el = document.getElementById('login-error');
  if (!el) { alert(msg); return; }
  el.textContent     = msg;
  el.style.display   = 'block';
}
