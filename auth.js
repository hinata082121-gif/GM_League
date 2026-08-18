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

/** トークンの有効期限（エポックミリ秒）。未ログインなら 0。 */
let _idTokenExp = 0;

/** 期限切れ予告タイマーの ID */
let _expiryTimer = null;

/**
 * 期限切れとみなす猶予（ミリ秒）。
 * 通信中に切れるのを避けるため、実際の exp より少し早めに切れた扱いにする。
 */
const TOKEN_SKEW_MS = 60 * 1000;

/** 期限の何ミリ秒前に警告バナーを出すか */
const TOKEN_WARN_BEFORE_MS = 5 * 60 * 1000;

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
  _idTokenExp = _parseJwtExp(_idToken);

  var rest = Math.round((_idTokenExp - Date.now()) / 60000);
  console.log("[auth] ログイン成功。トークン有効期限まで約 " + rest + " 分。");

  _scheduleExpiryWarning();
  onSignIn(_idToken); // app.js 側のハンドラへ渡す（app.js で定義）
}

/**
 * JWT の exp クレーム（秒）を読み、エポックミリ秒で返す。
 * 解析できない場合は 0 を返す。
 *
 * 署名の検証はしない。ここでの用途は「いつ切れるか」を知るためだけで、
 * 正当性の判定は必ず GAS 側（auth.gs の _verifyToken）で行う。
 *
 * @param {string} token
 * @returns {number} エポックミリ秒。不明なら 0
 */
function _parseJwtExp(token) {
  try {
    var payload = token.split(".")[1];
    var base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    var json = decodeURIComponent(
      atob(base64)
        .split("")
        .map(function (c) {
          return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join("")
    );
    var exp = JSON.parse(json).exp;
    return exp ? exp * 1000 : 0;
  } catch (e) {
    console.warn("[auth] exp の解析に失敗しました:", e.message);
    return 0;
  }
}

/**
 * 期限の TOKEN_WARN_BEFORE_MS 前に警告バナーを出すタイマーを仕掛ける。
 * すでに残り時間が少ない場合は即座に警告する。
 */
function _scheduleExpiryWarning() {
  if (_expiryTimer) clearTimeout(_expiryTimer);
  if (!_idTokenExp) return;

  var delay = _idTokenExp - Date.now() - TOKEN_WARN_BEFORE_MS;
  if (delay < 0) delay = 0;

  _expiryTimer = setTimeout(function () {
    if (typeof onTokenExpiring === "function") onTokenExpiring();
  }, delay);
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
 * トークンが期限切れ（またはまもなく切れる）かどうかを返す。
 * exp が読めなかった場合は false（＝サーバー判定に委ねる）。
 *
 * @returns {boolean}
 */
function isTokenExpired() {
  if (!_idToken) return true;
  if (!_idTokenExp) return false;
  return Date.now() >= _idTokenExp - TOKEN_SKEW_MS;
}

/**
 * トークンの残り有効時間（分）を返す。不明なら null。
 * @returns {number|null}
 */
function getTokenMinutesLeft() {
  if (!_idTokenExp) return null;
  return Math.max(0, Math.round((_idTokenExp - Date.now()) / 60000));
}

/**
 * 再ログインを促す。
 * One Tap が出せる状況なら自動で再認証を試み、
 * 出せない場合はログイン画面に戻す。
 */
function requestReauth() {
  console.log("[auth] 再認証を要求します。");
  try {
    google.accounts.id.prompt(function (notification) {
      // One Tap が表示されない・スキップされた場合はログイン画面に戻す
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        signOut();
      }
    });
  } catch (e) {
    signOut();
  }
}

/**
 * ログアウト処理。
 * トークンをクリアし、Google アカウントの選択をリセットする。
 */
function signOut() {
  _idToken = null;
  _idTokenExp = 0;
  if (_expiryTimer) {
    clearTimeout(_expiryTimer);
    _expiryTimer = null;
  }
  google.accounts.id.disableAutoSelect();
  console.log("[auth] ログアウトしました。");
  onSignOut(); // app.js 側のハンドラへ通知（app.js で定義）
}
