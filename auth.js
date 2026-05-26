/**
 * auth.js — Google Identity Services (GIS) ログイン処理
 *
 * 役割:
 *   - Google Sign-In ボタンの初期化
 *   - ID トークンの受け取りと保持
 *   - ログアウト処理
 *   - 他モジュールへのトークン提供（getIdToken）
 *
 * 依存:
 *   - config.js (GM_CONFIG.OAUTH_CLIENT_ID)
 *   - Google Identity Services SDK (https://accounts.google.com/gsi/client)
 *
 * 使い方:
 *   auth.js は index.html で <script> として読み込む。
 *   ログイン完了後に onSignIn(token) が呼ばれ、
 *   app.js の callApi がそのトークンを使って GAS に送る。
 */

/** 現在のログインユーザーの ID トークン（JWT）。未ログインなら null。 */
let _idToken = null;

/**
 * Google Identity Services を初期化してサインインボタンをレンダリングする。
 * index.html の <script onload> から呼ぶ。
 */
function initGoogleAuth() {
  google.accounts.id.initialize({
    client_id: GM_CONFIG.OAUTH_CLIENT_ID,
    callback: _handleCredentialResponse,
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  // #g_signin_button 要素にボタンをレンダリング
  const btnEl = document.getElementById("g_signin_button");
  if (btnEl) {
    google.accounts.id.renderButton(btnEl, {
      theme: "outline",
      size: "large",
      text: "signin_with",
      locale: "ja",
    });
  }

  // One Tap も表示（任意）
  google.accounts.id.prompt();
}

/**
 * GIS コールバック。credential.credential が ID トークン (JWT)。
 * @param {Object} response - GIS から渡されるクレデンシャルオブジェクト
 */
function _handleCredentialResponse(response) {
  _idToken = response.credential;
  console.log("[auth] ログイン成功。トークンを取得しました。");
  onSignIn(_idToken); // app.js 側のハンドラへ渡す（app.js で定義）
}

/**
 * 現在保持している ID トークンを返す。
 * ログインしていない場合は null。
 * @returns {string|null}
 */
function getIdToken() {
  return _idToken;
}

/**
 * ログアウト処理。
 * トークンをクリアし、Google アカウントの選択をリセットする。
 */
function signOut() {
  _idToken = null;
  google.accounts.id.disableAutoSelect();
  console.log("[auth] ログアウトしました。");
  onSignOut(); // app.js 側のハンドラへ通知（app.js で定義）
}
