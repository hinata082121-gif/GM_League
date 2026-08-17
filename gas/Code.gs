/**
 * Code.gs — doPost エントリポイント・action ルーティング
 *
 * 役割:
 *   - フロント（app.js の callApi）からの POST を受け取る
 *   - { action, token, payload } をパースし、対応するハンドラに委譲
 *   - { ok, data } / { ok:false, error } 形式で JSON を返す
 *
 * 規約（SPEC.md §8）:
 *   リクエスト: { action: string, token: string, payload: object }
 *   成功: { ok: true,  data: any }
 *   失敗: { ok: false, error: string }
 *
 * ⚠️ 設計原則（SPEC.md §3）を必ず守ること:
 *   1. 書き込みは必ずここを通す（クライアントから Sheets 直書き禁止）
 *   2. 時刻判定はこのサーバー側で new Date() を使う
 *   3. 予算残高は BudgetTx の SUM で算出（残高カラム禁止）
 *   4. 移籍は cost_to_buyer / payout_to_seller を別カラムで持つ
 *   5. 集計は status=承認 のデータのみ使う
 */

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * GAS Web App の POST ハンドラ。
 * フロントからのすべてのリクエストはここを通る。
 *
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  try {
    // リクエストボディをパース
    var body = JSON.parse(e.postData.contents);
    var action  = body.action  || "";
    var token   = body.token   || "";
    var payload = body.payload || {};

    // action ルーティング
    var result = _route(action, token, payload);
    return _jsonResponse(result);

  } catch (err) {
    Logger.log("[doPost] エラー: " + err.message);
    return _jsonResponse({ ok: false, error: "サーバーエラー: " + err.message });
  }
}

/**
 * action 名から対応するハンドラを呼び出す。
 * 未知の action は { ok:false, error } を返す。
 *
 * @param {string} action
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: any, error?: string }}
 */
function _route(action, token, payload) {
  switch (action) {

    // ---- 認証・共通 ----
    case "whoami":
      return whoami(token);

    // ---- Phase 1: マスタ読み取り（ログイン済みなら誰でも） ----
    case "listPlayers":
      return listPlayers(token, payload);

    case "listTeams":
      return listTeams(token, payload);

    case "listSeasons":
      return listSeasons(token);

    case "listClubs":
      return listClubs(token);

    case "getTeamSquad":
      return getTeamSquad(token, payload);

    case "getTeamBudget":
      return getTeamBudget(token, payload);

    case "getMyTeam":
      return getMyTeam(token, payload);

    // ---- Phase 1: マスタ書き込み（主催者専用） ----
    case "listUsers":
      return listUsers(token);

    case "listConfig":
      return listConfig(token);

    case "upsertPlayer":
      return upsertPlayer(token, payload);

    case "upsertTeam":
      return upsertTeam(token, payload);

    case "upsertUser":
      return upsertUser(token, payload);

    case "importPlayersCsv":
      return importPlayersCsv(token, payload);

    case "setConfig":
      return setConfig(token, payload);

    // ---- チームオーナー向け ----
    case "submitEntryList":
      return { ok: false, error: "submitEntryList は Phase 2 で実装します。" };

    case "requestTransfer":
      return { ok: false, error: "requestTransfer は Phase 3 で実装します。" };

    case "setProtection":
      return { ok: false, error: "setProtection は Phase 4 で実装します。" };

    case "submitMatchResult":
      return { ok: false, error: "submitMatchResult は Phase 5 で実装します。" };

    // ---- 主催者向け ----
    case "approveTransfer":
    case "rejectTransfer":
      return { ok: false, error: action + " は Phase 3 で実装します。" };

    case "approveMatch":
    case "rejectMatch":
    case "correctMatch":
      return { ok: false, error: action + " は Phase 5 で実装します。" };

    case "addPenalty":
    case "addCompensation":
    case "applySponsorIncome":
      return { ok: false, error: action + " は Phase 7 で実装します。" };

    case "advanceSeason":
    case "closeSeason":
      return { ok: false, error: action + " は Phase 7 で実装します。" };

    // ---- 読み取り（集計系・Phase 6） ----
    case "getStandings":
    case "getTournament":
    case "getRankings":
    case "getProtections":
    case "getHistory":
      return { ok: false, error: action + " は Phase 6 で実装します。" };

    // ---- 不明な action ----
    default:
      return { ok: false, error: "Unknown action: " + action };
  }
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/**
 * オブジェクトを JSON テキストレスポンスに変換する。
 * CORS ヘッダーは GAS Web App が自動付与するため不要。
 *
 * @param {Object} data
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
