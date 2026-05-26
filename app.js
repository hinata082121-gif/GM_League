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
async function callApi(action, payload = {}) {
  const token = getIdToken();
  if (!token) {
    return { ok: false, error: 'no_token' };
  }

  if (GM_CONFIG.GAS_URL.includes('PLACEHOLDER')) {
    console.error('[callApi] GAS_URL が未設定です。config.js を確認してください。');
    return { ok: false, error: 'gas_url_not_set' };
  }

  const body = JSON.stringify({ action, token, payload });

  try {
    const res = await fetch(GM_CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',   // GAS の 302 リダイレクトを自動追跡
    });

    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }

    const json = await res.json();
    return json; // { ok, data } or { ok:false, error }

  } catch (err) {
    console.error('[callApi] fetch 失敗:', err);
    return { ok: false, error: err.message };
  }
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

  const res = await callApi('whoami');

  if (loadingEl) loadingEl.style.display = 'none';

  if (res.ok) {
    // ✅ 登録済みユーザー
    console.log('[app] whoami 成功:', res.data);
    if (appSection) appSection.style.display = 'block';
    renderUserInfo(res.data);

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
