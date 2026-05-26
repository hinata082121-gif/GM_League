/**
 * app.js — GAS API 共通 fetch ラッパ
 *
 * 役割:
 *   - callApi(action, payload) : GAS Web App に JSON-RPC 風リクエストを送る
 *   - onSignIn / onSignOut : auth.js からのコールバックを受けてUI切替
 *
 * doPost 規約（SPEC.md §8）:
 *   リクエスト: { action: string, token: string, payload: object }
 *   成功: { ok: true,  data: any }
 *   失敗: { ok: false, error: string }
 *
 * 依存:
 *   - config.js (GM_CONFIG.GAS_URL)
 *   - auth.js   (getIdToken)
 */

/**
 * GAS Web App に action を送り、{ ok, data } / { ok:false, error } を返す。
 *
 * @param {string} action   - GAS 側の action 名（例: "whoami", "requestTransfer"）
 * @param {Object} [payload={}] - action ごとのパラメータ
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 *
 * @example
 *   const res = await callApi("whoami");
 *   if (res.ok) console.log(res.data);
 */
async function callApi(action, payload = {}) {
  const token = getIdToken();
  if (!token) {
    return { ok: false, error: "ログインが必要です。" };
  }

  const body = JSON.stringify({ action, token, payload });

  try {
    const res = await fetch(GM_CONFIG.GAS_URL, {
      method: "POST",
      // GAS doPost は application/json を受け取れるが、
      // CORS プリフライトを避けるため text/plain で送ることが多い。
      // GAS 側で e.postData.contents を JSON.parse する。
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const json = await res.json();
    return json; // { ok, data } or { ok:false, error }
  } catch (err) {
    console.error("[callApi] fetch 失敗:", err);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// auth.js からのコールバックを受けるハンドラ
// ---------------------------------------------------------------------------

/**
 * ログイン成功時に auth.js から呼ばれる。
 * ログイン画面を隠し、アプリ本体を表示する。
 * @param {string} token - ID トークン（JWT）
 */
async function onSignIn(token) {
  console.log("[app] onSignIn — whoami を呼び出します");

  // ログイン画面 → アプリ画面へ切替
  const loginSection = document.getElementById("login-section");
  const appSection = document.getElementById("app-section");
  const loadingEl = document.getElementById("loading-message");

  if (loginSection) loginSection.style.display = "none";
  if (loadingEl) loadingEl.style.display = "block";

  // whoami でユーザー情報を取得
  const res = await callApi("whoami");

  if (loadingEl) loadingEl.style.display = "none";

  if (res.ok) {
    console.log("[app] whoami 成功:", res.data);
    if (appSection) appSection.style.display = "block";
    renderUserInfo(res.data);
  } else {
    console.error("[app] whoami 失敗:", res.error);
    // ログイン画面に戻す
    if (loginSection) loginSection.style.display = "block";
    alert("ログイン処理に失敗しました: " + res.error);
  }
}

/**
 * ログアウト時に auth.js から呼ばれる。
 * アプリ画面を隠し、ログイン画面に戻す。
 */
function onSignOut() {
  const loginSection = document.getElementById("login-section");
  const appSection = document.getElementById("app-section");
  if (appSection) appSection.style.display = "none";
  if (loginSection) loginSection.style.display = "block";
  console.log("[app] onSignOut — ログイン画面に戻りました");
}

/**
 * whoami レスポンスからユーザー情報を画面に表示する（最小実装）。
 * Phase 1 以降で本格的なダッシュボード描画に差し替える。
 * @param {{ email, display_name, role, team_id }} user
 */
function renderUserInfo(user) {
  const el = document.getElementById("user-info");
  if (!el) return;
  el.textContent =
    `${user.display_name}（${user.email}）— ロール: ${user.role}` +
    (user.team_id ? ` / チーム: ${user.team_id}` : "");
}
