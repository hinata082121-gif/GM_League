/**
 * auth.gs — トークン検証・whoami
 *
 * 役割:
 *   - Google ID トークン（JWT）を検証してユーザー情報を取得する
 *   - Users シートでメールアドレスを引き、role / team_id を返す
 *   - whoami action の実装
 *
 * ⚠️ 時刻判定はサーバー側（SPEC.md §3 原則2）。
 *    クライアントから送られた時刻は信用しない。
 */

/**
 * ID トークンを検証し、Users シートからユーザー情報を返す。
 * GAS は Google 内部で動くため tokeninfo エンドポイントで簡易検証する。
 *
 * @param {string} token - フロントから受け取った Google ID トークン (JWT)
 * @returns {{ ok: boolean, data?: UserInfo, error?: string }}
 *
 * @typedef {{ user_id: string, email: string, display_name: string, role: string, team_id: string }} UserInfo
 *
 * エラー種別:
 *   'invalid_token'  — tokeninfo 検証失敗・期限切れ・aud 不一致
 *   'unregistered'   — Users シートに email が存在しない
 */
function whoami(token) {
  var email = _verifyToken(token);
  if (!email) {
    return { ok: false, error: 'invalid_token' };
  }

  var user = _findUserByEmail(email);
  if (!user) {
    // フロントは error === 'unregistered' で「未登録」メッセージを表示する
    return { ok: false, error: 'unregistered' };
  }

  return { ok: true, data: user };
}

/**
 * ID トークンを Google の tokeninfo エンドポイントで検証し、email を返す。
 * 検証失敗・期限切れの場合は null を返す。
 *
 * NOTE: Phase 0 では簡易実装。
 *   本番では client_id との一致確認も追加するとより堅牢になる。
 *
 * @param {string} token
 * @returns {string|null} email
 */
function _verifyToken(token) {
  if (!token) return null;

  try {
    var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

    if (res.getResponseCode() !== 200) {
      Logger.log("[_verifyToken] tokeninfo エラー: " + res.getContentText());
      return null;
    }

    var info = JSON.parse(res.getContentText());

    // aud（audience）が自プロジェクトのクライアント ID と一致するか確認
    // Config シートから取ってもよいが、ここでは定数を使う
    // （クライアント ID は公開情報なのでコードに書いても問題なし）
    var EXPECTED_AUD = "1078761144028-uor0b4ukacklepi7g6u4i6jn90q33qc0.apps.googleusercontent.com";
    if (info.aud !== EXPECTED_AUD) {
      Logger.log("[_verifyToken] aud 不一致: " + info.aud);
      return null;
    }

    // exp（有効期限）を確認
    var now = Math.floor(new Date().getTime() / 1000);
    if (info.exp && parseInt(info.exp) < now) {
      Logger.log("[_verifyToken] トークン期限切れ");
      return null;
    }

    return info.email || null;

  } catch (err) {
    Logger.log("[_verifyToken] 例外: " + err.message);
    return null;
  }
}

/**
 * Users シートからメールアドレスでユーザーを検索する。
 * シートが存在しない・読み取り失敗の場合は null を返す（例外を握り潰す）。
 *
 * @param {string} email
 * @returns {UserInfo|null}
 */
function _findUserByEmail(email) {
  var data;
  try {
    data = getSheetData("Users"); // lib.gs
  } catch (e) {
    Logger.log("[_findUserByEmail] Users シート読み取りエラー: " + e.message);
    return null;
  }
  // data = [{ user_id, email, display_name, role, team_id }, ...]

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    // email は大文字小文字を無視して照合（Google アカウントは小文字が多いが念のため）
    if (String(row.email).toLowerCase() === email.toLowerCase()) {
      return {
        user_id:      String(row.user_id      || ""),
        email:        String(row.email        || ""),
        display_name: String(row.display_name || email),
        role:         String(row.role         || "team"),
        team_id:      String(row.team_id      || ""),
      };
    }
  }
  return null;
}
