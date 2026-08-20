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

    // ---- 公開（トークン不要）----
    // ここに追加する action は必ず読み取り専用にすること。
    case "getPublicData":
      return getPublicData(payload);

    case "getSignupInfo":
      return getSignupInfo();

    case "verifySignupCode":
      return verifySignupCode(payload);

    case "getSignupClubs":
      return getSignupClubs(token, payload);

    // ---- 日程表 ----
    case "getSeasonSchedule":
      return getSeasonSchedule(token, payload);

    case "getScheduleTemplate":
      return getScheduleTemplate(token);

    case "saveScheduleTemplate":
      return saveScheduleTemplate(token, payload);

    case "generateSchedule":
      return generateSchedule(token, payload);

    case "upsertScheduleItem":
      return upsertScheduleItem(token, payload);

    case "deleteScheduleItem":
      return deleteScheduleItem(token, payload);

    // ---- 参加登録（Google ログインのみ。Users 未登録でも可）----
    case "submitSignup":
      return submitSignup(token, payload);

    case "getMySignup":
      return getMySignup(token);

    // ---- 参加登録の承認（主催者専用）----
    case "listSignups":
      return listSignups(token, payload);

    case "approveSignup":
      return approveSignup(token, payload);

    case "rejectSignup":
      return rejectSignup(token, payload);

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

    case "updateMyProfile":
      return updateMyProfile(token, payload);

    // ---- Phase 2: エントリー ----
    case "getEntryStatus":
      return getEntryStatus(token, payload);

    case "submitEntryList":
      return submitEntryList(token, payload);

    case "listEntryLists":
      return listEntryLists(token, payload);

    case "approveEntryList":
      return approveEntryList(token, payload);

    case "rejectEntryList":
      return rejectEntryList(token, payload);

    case "listSeasonStatuses":
      return listSeasonStatuses(token);

    case "setSeasonStatus":
      return setSeasonStatus(token, payload);

    // ---- Phase 3: 移籍 ----
    case "getTransferOptions":
      return getTransferOptions(token, payload);

    case "listTransfers":
      return listTransfers(token, payload);

    case "requestTransfer":
      return requestTransfer(token, payload);

    case "respondTransfer":
      return respondTransfer(token, payload);

    case "registerAuction":
      return registerAuction(token, payload);

    case "approveTransfer":
      return approveTransfer(token, payload);

    case "rejectTransfer":
      return rejectTransfer(token, payload);

    // ---- チームオーナー向け（未実装） ----

    // ---- Phase 4: プロテクト ----
    case "getProtectionStatus":
      return getProtectionStatus(token, payload);

    case "setProtection":
      return setProtection(token, payload);

    case "getProtections":
      return getProtections(token, payload);

    // ---- Phase 5: 試合集計 ----
    case "getMatchOptions":
      return getMatchOptions(token, payload);

    case "listMatches":
      return listMatches(token, payload);

    case "getMatchDetail":
      return getMatchDetail(token, payload);

    case "submitMatchResult":
      return submitMatchResult(token, payload);

    // ---- 主催者向け（未実装） ----
    case "approveMatch":
      return approveMatch(token, payload);

    case "rejectMatch":
      return rejectMatch(token, payload);

    case "correctMatch":
      return correctMatch(token, payload);

    // ---- Phase 7: 経済周辺 & シーズン進行 ----
    case "getSeasonProgress":
      return getSeasonProgress(token, payload);

    case "addPenalty":
      return addPenalty(token, payload);

    case "addCompensation":
      return addCompensation(token, payload);

    case "applySponsorIncome":
      return applySponsorIncome(token, payload);

    case "advanceSeason":
      return advanceSeason(token, payload);

    case "closeSeason":
      return closeSeason(token, payload);

    case "upsertSeason":
      return upsertSeason(token, payload);

    // ---- 現実移籍の反映 ----
    case "getRealTransferTargets":
      return getRealTransferTargets(token, payload);

    case "applyRealTransfers":
      return applyRealTransfers(token, payload);

    case "restorePlayerEligible":
      return restorePlayerEligible(token, payload);

    case "withdrawTeam":
      return withdrawTeam(token, payload);

    // ---- 補填の請求（払い戻し / 入れ替え）----
    case "getMyClaims":
      return getMyClaims(token, payload);

    case "chooseClaim":
      return chooseClaim(token, payload);

    case "listClaims":
      return listClaims(token, payload);

    case "overrideClaim":
      return overrideClaim(token, payload);

    case "voidClaim":
      return voidClaim(token, payload);

    case "settleClaims":
      return settleClaims(token, payload);

    // ---- ディビジョン & スーパーカップ ----
    case "getSeasonDivisions":
      return getSeasonDivisions(token, payload);

    case "setSeasonDivisions":
      return setSeasonDivisions(token, payload);

    case "getSuperCup":
      return getSuperCup(token, payload);

    case "setSuperCup":
      return setSuperCup(token, payload);

    // ---- Phase 6: 集計表示 ----
    case "getStandings":
      return getStandings(token, payload);

    case "getTournament":
      return getTournament(token, payload);

    case "getRankings":
      return getRankings(token, payload);

    // ---- Phase 8: 過去大会記録 ----
    case "getHistory":
      return getHistory(token, payload);

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
