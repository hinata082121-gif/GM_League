/**
 * api_transfer.gs — Phase 3: 移籍 の action ハンドラ
 *
 * チームオーナー向け:
 *   getTransferOptions — 市場状況・自チームの使える予算・形態別コストの見積り
 *   requestTransfer    — 移籍申請
 *   respondTransfer    — 売り手として同意 / 拒否
 *
 * 主催者向け:
 *   registerAuction    — オークション結果の登録（入札はツール外）
 *   listTransfers      — 移籍一覧
 *   getTransferLog     — 移籍ログ（承認済みを全員に）
 *   approveTransfer    — 承認（Rosters 移動 + BudgetTx 計上）
 *   approveTransfers   — まとめて承認（100件を超えても1回で済む）
 *   rejectTransfer     — 差戻
 *
 * ⚠️ 設計原則（SPEC.md §3）
 *   2. 割引時間帯の判定は必ず GAS の now() を使う。クライアント時刻は受け取らない。
 *   3. 予算残高はカラムを持たず BudgetTx の SUM で算出する。
 *   4. cost_to_buyer と payout_to_seller は別カラムで持つ。
 *   5. Rosters と BudgetTx が動くのは「承認」の瞬間だけ。
 *   補助. 金額・率・人数はすべて Config 参照。コードに直書きしない。
 *
 * 承認フロー（SPEC.md §4.7）
 *   交渉移籍  : 申請 → 売り手承認待ち → 主催者承認待ち → 承認
 *   特別/無効化: 申請 → 主催者承認待ち → 承認（売り手の同意を挟まない）
 *   オークション: 主催者が登録 → 主催者承認待ち → 承認
 */

// =============================================================================
// 定数
// =============================================================================

/** Transfers.status */
var TX_SELLER_PENDING = "売り手承認待ち";
var TX_ORG_PENDING = "主催者承認待ち";
var TX_APPROVED = "承認";
var TX_SELLER_REJECTED = "売り手拒否";
var TX_REJECTED = "差戻";

/** まだ確定していない（予算・人数を押さえる対象の）status */
var TX_PENDING_STATUSES = [TX_SELLER_PENDING, TX_ORG_PENDING];

/** 移籍形態 */
var METHOD_FULL = "完全移籍";
var METHOD_HALF = "半期期限付き";
var METHOD_FULL_TERM = "全期期限付き";
var METHOD_SPECIAL = "特別";
var METHOD_OVERRIDE = "無効化特別";
var METHOD_AUCTION = "オークション";

var TRANSFER_METHODS = [
  METHOD_FULL,
  METHOD_HALF,
  METHOD_FULL_TERM,
  METHOD_SPECIAL,
  METHOD_OVERRIDE,
  METHOD_AUCTION,
];

/** 売り手との交渉が必要な形態（売り手承認ステップを挟む） */
var NEGOTIATED_METHODS = [METHOD_FULL, METHOD_HALF, METHOD_FULL_TERM];

/** 期限付きで、当該シーズン終了時に離脱する形態 */
var EXPIRING_METHODS = [METHOD_HALF, METHOD_FULL_TERM, METHOD_AUCTION];

/** シーズン status と移籍市場ウィンドウ番号の対応 */
var MARKET_WINDOW = { "移籍市場1": 1, "移籍市場2": 2 };

// =============================================================================
// 時刻ヘルパ（サーバー時刻のみ・原則2）
// =============================================================================

/**
 * Config の時刻値を { h, m } に正規化する。
 *
 * Google Sheets は "22:00" と入力すると時刻値（Date）に自動変換してしまうため、
 * 文字列と Date の両方を受け取れるようにしている。
 * どちらでもない場合は null を返す。
 *
 * @param {*} v
 * @returns {{h: number, m: number}|null}
 */
function _parseHourMinute(v) {
  if (v === null || v === undefined || v === "") return null;

  if (v instanceof Date) {
    return { h: v.getHours(), m: v.getMinutes() };
  }

  var s = String(v).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;

  return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
}

/**
 * 2つの Date が同じ日（年月日）かどうかを返す。
 *
 * @param {Date} a
 * @param {Date} b
 * @returns {boolean}
 */
function _isSameDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 市場の日付まわり。開幕日時（windowN_open_at）から決める。
 *
 *   lastDay  — 市場最終日の 0:00（開幕日 + market_days − 1 日）
 *   closeAt  — 新規の獲得申請を締め切る時刻。最終日の翌日 0:00（日付が変わった瞬間）
 *   graceEnd — 売り手の同意・主催者の承認を受ける期限。閉鎖の翌日いっぱい
 *              （transfer_response_grace_days 日。既定1）
 *
 * 開幕日時が未設定なら null。その場合は時刻による締切を一切かけず、
 * シーズンの状態（移籍市場1/2）だけで開閉する従来の動きになる。
 *
 * @param {Object} season
 * @param {number} windowNo 1 または 2
 * @returns {{lastDay: Date, closeAt: Date, graceEnd: Date}|null}
 */
function _marketTimes(season, windowNo) {
  var openRaw = windowNo === 2 ? season.window2_open_at : season.window1_open_at;
  if (!(openRaw instanceof Date)) {
    if (!openRaw) return null;
    openRaw = new Date(openRaw);
    if (isNaN(openRaw.getTime())) return null;
  }

  var days = Math.max(1, getConfigNum("market_days", 3));
  var grace = Math.max(0, getConfigNum("transfer_response_grace_days", 1));

  var lastDay = new Date(openRaw.getTime());
  lastDay.setDate(lastDay.getDate() + (days - 1));
  lastDay.setHours(0, 0, 0, 0);

  var closeAt = new Date(lastDay.getTime());
  closeAt.setDate(closeAt.getDate() + 1);

  var graceEnd = new Date(closeAt.getTime());
  graceEnd.setDate(graceEnd.getDate() + grace);

  return { lastDay: lastDay, closeAt: closeAt, graceEnd: graceEnd };
}

/** "HH:mm" 形式にそろえる */
function _hmText(hm) {
  return (hm.h < 10 ? "0" : "") + hm.h + ":" + (hm.m < 10 ? "0" : "") + hm.m;
}

/** "M月D日" 形式にする */
function _mdText(d) {
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/**
 * 指定時刻での市場の開閉と割引の状態。時刻はすべてサーバー側の値で判定する。
 *
 *   closed         — 日付が変わって市場が完全に閉まった。新規の獲得申請は受けない
 *   special_closed — 特別・無効化特別の受付が終わった（最終日の special_deadline 以降、
 *                    または市場が閉まった後）
 *   discount       — 最終日の discount_start 以上 discount_end 未満（特別・無効化特別の値下げ）
 *
 * 23:00 ちょうどは終わった側に倒す。「22:00〜23:00」を 22:00:00 以上 23:00:00 未満と読む。
 * 以前は 23:00 台の1分間が割引のまま残っていた。
 *
 * @param {Object} season
 * @param {number} windowNo
 * @param {Date}   at
 * @returns {Object}
 */
function _marketClock(season, windowNo, at) {
  var out = {
    known: false, closed: false, special_closed: false, discount: false,
    last_day: null, closes_at: null, response_until: null, special_deadline_text: "",
  };

  var tm = _marketTimes(season, windowNo);
  var deadline = _parseHourMinute(getConfig("special_deadline", "23:00")) || { h: 23, m: 0 };
  out.special_deadline_text = _hmText(deadline);
  if (!tm) return out;

  out.known = true;
  out.last_day = tm.lastDay;
  out.closes_at = tm.closeAt;
  out.response_until = tm.graceEnd;
  out.closed = at.getTime() >= tm.closeAt.getTime();

  var secs = at.getHours() * 3600 + at.getMinutes() * 60 + at.getSeconds();
  var onLastDay = _isSameDate(at, tm.lastDay);
  var deadlineSecs = deadline.h * 3600 + deadline.m * 60;

  out.special_closed = out.closed || (onLastDay && secs >= deadlineSecs);

  var start = _parseHourMinute(getConfig("discount_start", "22:00"));
  var end = _parseHourMinute(getConfig("discount_end", "23:00"));
  if (start && end && onLastDay && !out.special_closed) {
    out.discount = secs >= start.h * 3600 + start.m * 60 && secs < end.h * 3600 + end.m * 60;
  }

  return out;
}

/**
 * 指定日時が最終日割引の時間帯に入っているか判定する（SPEC.md §7.4）。
 * 特別・無効化特別の値下げに使う。
 *
 * @param {Object} season   Seasons の行
 * @param {number} windowNo 1 または 2
 * @param {Date}   at       判定したい日時（通常は now()）
 * @returns {boolean}
 */
function _isDiscountWindow(season, windowNo, at) {
  return _marketClock(season, windowNo, at).discount;
}

/**
 * 新規の獲得申請を受け付けられない理由。受け付けられるなら空文字。
 *
 * 市場は日付が変わった瞬間に完全に閉まる。特別・無効化特別は最終日の
 * special_deadline（既定23:00）で終わる。売り手の同意と主催者の承認は
 * ここでは止めない（閉鎖の翌日いっぱいまで可能）。
 *
 * @param {Object} clock _marketClock の結果
 * @param {string} method 移籍形態
 * @returns {string}
 */
function _applicationClosedReason(clock, method) {
  if (!clock.known) return "";

  if (clock.closed) {
    return "移籍市場は" + _mdText(clock.last_day) + "いっぱいで終了しました。" +
      "新しい獲得申請は受け付けていません（売り手の同意と主催者の承認は引き続き可能です）。";
  }

  if ((method === METHOD_SPECIAL || method === METHOD_OVERRIDE) && clock.special_closed) {
    return "特別ルール・無効化特別ルールの受付は、最終日の " +
      clock.special_deadline_text + " で終了しました。";
  }

  return "";
}

// =============================================================================
// コスト算出（SPEC.md §5.3 / §5.4）
// =============================================================================

/**
 * 移籍形態からコストを算出する。
 *
 * 金額はすべて Config 参照。割引は最終日の 22:00〜23:00 に、特別と無効化特別へ適用する。
 * 無効化特別の割引額は override_w1_discount / override_w2_discount。0 や未設定なら割引なし。
 *
 * @param {string} method    移籍形態
 * @param {number} grossFee  交渉額・落札額（固定額の形態では無視）
 * @param {Object} season    Seasons の行
 * @param {number} windowNo  1 または 2
 * @param {Date}   at        サーバー時刻
 * @returns {{gross: number, cost: number, payout: number, discounted: boolean}}
 */
function _calcTransferCost(method, grossFee, season, windowNo, at) {
  // 交渉額も10万の位で四捨五入して100万円単位にそろえる
  // （40万以下は切り捨て、50万以上は切り上げ）
  var fee = Math.max(0, _roundMoney(_num(grossFee)));
  var w = windowNo === 2 ? 2 : 1;

  if (
    method === METHOD_FULL ||
    method === METHOD_HALF ||
    method === METHOD_FULL_TERM
  ) {
    var rate = Number(getConfig("seller_rate_normal", 0.9));
    return {
      gross: fee,
      cost: fee,
      payout: _roundMoney(fee * rate),
      discounted: false,
    };
  }

  if (method === METHOD_SPECIAL) {
    var normalKey = w === 2 ? "special_w2" : "special_w1";
    var discountKey = w === 2 ? "special_w2_discount" : "special_w1_discount";
    var isDiscount = _isDiscountWindow(season, w, at);
    var amount = getConfigNum(isDiscount ? discountKey : normalKey, 0);

    // 特別ルールは放出側が受け取れない（原則4：別カラムで持つ理由そのもの）
    return { gross: amount, cost: amount, payout: 0, discounted: isDiscount };
  }

  if (method === METHOD_OVERRIDE) {
    // 特別と同じ時間帯に値下げする。金額が未設定（0）なら割引は無いものとして扱う。
    // 売り手の受取は値下げ後の額にかける（買い手が払う額の70%）
    var oDiscount = _isDiscountWindow(season, w, at)
      ? getConfigNum(w === 2 ? "override_w2_discount" : "override_w1_discount", 0)
      : 0;
    var oUse = oDiscount > 0;
    var amt = oUse ? oDiscount : getConfigNum(w === 2 ? "override_w2" : "override_w1", 0);
    var orate = Number(getConfig("seller_rate_override", 0.7));
    return {
      gross: amt,
      cost: amt,
      payout: _roundMoney(amt * orate),
      discounted: oUse,
    };
  }

  if (method === METHOD_AUCTION) {
    // 売却側なし（プールからの獲得）
    return { gross: fee, cost: fee, payout: 0, discounted: false };
  }

  return { gross: 0, cost: 0, payout: 0, discounted: false };
}

// =============================================================================
// 予約（申請中の移籍で予算と人数を押さえる）
// =============================================================================

/**
 * 指定シーズンの未確定（申請中）移籍をすべて返す。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _pendingTransfers(seasonId) {
  return getSheetData("Transfers").filter(function (t) {
    return (
      _str(t.season_id) === seasonId &&
      TX_PENDING_STATUSES.indexOf(_str(t.status)) !== -1
    );
  });
}

/**
 * チームの使える予算を返す。
 *
 * 使える予算 = BudgetTx の合計 − 申請中の移籍で押さえている cost_to_buyer の合計
 *
 * 残高そのものはカラムに持たず毎回 SUM する（原則3）。
 * 申請中を差し引くのは、承認待ちが複数あるときの予算超過を防ぐため。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {Object[]} [pending] 事前に取得済みの申請中一覧（省略時は再取得）
 * @returns {{ balance: number, reserved: number, available: number }}
 */
function _teamAvailableBudget(seasonId, teamId, pending) {
  // **そのシーズンの取引だけを数える。** 前シーズンぶんは
  // 終了処理の「次シーズンへ繰越」で1本にまとめて入ってくる（api_season.gs）
  var balance = _seasonBalance(seasonId, teamId);

  var list = pending || _pendingTransfers(seasonId);
  var reserved = 0;
  list.forEach(function (t) {
    if (_str(t.to_team) === teamId) reserved += _num(t.cost_to_buyer);
  });

  return { balance: balance, reserved: reserved, available: balance - reserved };
}

/**
 * チームのスカッド人数を返す。
 *
 * 確定人数（在籍）に加え、申請中の増減を織り込んだ見込み人数も返す。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {Object[]} [pending]
 * @returns {{ active: number, incoming: number, outgoing: number, projected: number }}
 */
function _teamSquadCount(seasonId, teamId, pending) {
  var active = 0;
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.team_id) !== teamId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;
    active++;
  });

  var list = pending || _pendingTransfers(seasonId);
  var incoming = 0;
  var outgoing = 0;

  list.forEach(function (t) {
    if (_str(t.to_team) === teamId) incoming++;
    if (_str(t.from_team) === teamId) outgoing++;
  });

  return {
    active: active,
    incoming: incoming,
    outgoing: outgoing,
    projected: active + incoming - outgoing,
  };
}

/**
 * 当該シーズンに、その選手がどの形態で動いたかを集める。
 *
 * 正は**承認済みの移籍記録**。シーズンで区切られているので、
 * 「今シーズン動いたか」をそのまま判定できる。
 *
 * ⚠️ 在籍の acquisition_type は「今シーズン動いた証拠」にならない。
 *   引継ぎ（_carryOverRosters）が acquisition_type を次シーズンへ保持するため
 *   （補填金の母数になるので意図的にそうしている）。
 *   前シーズンに特別ルールで獲った選手は、翌シーズンの在籍にも
 *   acquisition_type=特別 のまま残る。これを「今シーズン動いた」と読むと、
 *   一度強奪された選手が永久に強奪されなくなってしまう。
 *
 *   期限付き・オークションだけは在籍からも拾う。
 *   この3形態はシーズン末に必ず離脱するので引継ぎに残りようがなく、
 *   在籍に出ているなら今シーズン作られた行だと確定できる。
 *   移行で取り込んだ在籍のように移籍記録が無いものを拾うのが狙い。
 *
 * @param {string} seasonId
 * @returns {Object} player_id → { 形態: true }
 */
function _seasonMethodMap(seasonId) {
  var map = {};

  var mark = function (pid, method) {
    if (!pid || !method) return;
    if (!map[pid]) map[pid] = {};
    map[pid][method] = true;
  };

  getSheetData("Transfers").forEach(function (t) {
    if (_str(t.season_id) !== seasonId) return;
    if (_str(t.status) !== TX_APPROVED) return;
    mark(_str(t.player_id), _str(t.method));
  });

  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;

    var type = _str(r.acquisition_type);
    if (EXPIRING_METHODS.indexOf(type) === -1) return;
    mark(_str(r.player_id), type);
  });

  return map;
}

/**
 * 特別ルール / 無効化特別ルールで獲得できない理由を返す。獲得できるなら空文字。
 *
 * ▶ なぜ制限するのか
 *   期限付き・オークションは**当該シーズン限りの契約**で、シーズン末に手元を離れる。
 *   そこから更に強奪できると、借りた側は代価を払ったのに一度も使えないまま失う。
 *
 *   特別・無効化特別で既に動いた選手を除くのは、強奪の連鎖を止めるため。
 *   金額を出せるチームが同じ選手を何度も奪い合う展開になり、
 *   最初に奪われたチームだけが一方的に損をする。
 *
 *   **プロテクトはここでは見ない。** 無効化特別はプロテクトを破るための形態で、
 *   プロテクトの判定は呼び出し側に分けてある。
 *
 * @param {Object} methods _seasonMethodMap の該当選手の値（無ければ null）
 * @returns {string} 理由。獲得できるなら空文字
 */
function _specialRuleBlock(methods) {
  if (!methods) return "";

  for (var i = 0; i < EXPIRING_METHODS.length; i++) {
    if (methods[EXPIRING_METHODS[i]]) {
      return "この選手は今シーズン「" + EXPIRING_METHODS[i] +
        "」で移籍しています。期限付き・オークションで動いた選手は特別ルールの対象にできません。";
    }
  }

  if (methods[METHOD_SPECIAL] || methods[METHOD_OVERRIDE]) {
    return "この選手は今シーズン既に特別ルールで移籍しています。同じシーズンに二度は使えません。";
  }

  return "";
}

/**
 * 日時を並べ替え用の数値にする。読めなければ 0。
 *
 * Sheets から来る値は Date だが、取り込みの経路によっては文字列のことがある。
 * 文字列のまま比較すると書式しだいで順番が崩れるので、必ず数値に寄せる。
 *
 * @param {*} v
 * @returns {number} エポックミリ秒
 */
function _timeValue(v) {
  if (v === null || v === undefined || v === "") return 0;
  var ms = new Date(v).getTime();
  return isNaN(ms) ? 0 : ms;
}

/**
 * 選手が指定シーズン・ウィンドウでプロテクトされているか判定する。
 * Protections シートは Phase 4 で書き込まれる。空なら常に false。
 *
 * @param {string} seasonId
 * @param {number} windowNo
 * @param {string} playerId
 * @returns {boolean}
 */
function _isProtected(seasonId, windowNo, playerId) {
  var rows = getSheetData("Protections");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].season_id) !== seasonId) continue;
    if (_num(rows[i].window) !== windowNo) continue;
    if (_str(rows[i].player_id) === playerId) return true;
  }
  return false;
}

/**
 * 指定シーズンで選手が在籍しているチームを返す。いなければ空文字。
 *
 * @param {string} seasonId
 * @param {string} playerId
 * @returns {string} team_id
 */
function _currentTeamOf(seasonId, playerId) {
  var rows = getSheetData("Rosters");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].season_id) !== seasonId) continue;
    if (_str(rows[i].player_id) !== playerId) continue;
    if (_str(rows[i].status) !== ROSTER_ACTIVE) continue;
    return _str(rows[i].team_id);
  }
  return "";
}

/**
 * 現在の移籍市場ウィンドウ番号を返す。市場期間外なら 0。
 *
 * @param {Object} season
 * @returns {number} 1 / 2 / 0
 */
function _currentWindow(season) {
  return MARKET_WINDOW[_str(season.status)] || 0;
}

// =============================================================================
// 読み取り
// =============================================================================

/**
 * 移籍申請画面に必要な情報をまとめて返す。
 *
 * - 現在の市場ウィンドウと申請可否
 * - 自チームの使える予算・スカッド人数
 * - 形態別のコスト見積り（割引が効いているかも含む）
 * - 獲得可能な選手（他チーム在籍 + フリー）
 *
 * payload: { season_id: string, team_id?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getTransferOptions(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var windowNo = _currentWindow(season);
  var at = now();
  var clock = _marketClock(season, windowNo || 1, at);

  // 形態別のコスト見積り（交渉額に依存する形態は gross_fee=0 で返す）
  var estimates = TRANSFER_METHODS.map(function (m) {
    var c = _calcTransferCost(m, 0, season, windowNo || 1, at);
    var closedReason = windowNo > 0 ? _applicationClosedReason(clock, m) : "";
    return {
      method: m,
      fixed_cost: c.cost,
      payout: c.payout,
      discounted: c.discounted,
      needs_fee: NEGOTIATED_METHODS.indexOf(m) !== -1 || m === METHOD_AUCTION,
      needs_seller_approval: NEGOTIATED_METHODS.indexOf(m) !== -1,
      closed: !!closedReason,
      closed_reason: closedReason,
    };
  });

  // 市場が開いているのは、状態が市場期間で、かつ日付が変わっていないあいだ。
  // 閉まったあとも一覧は見られ、売り手の同意・主催者の承認はできる
  var marketClosedReason = "";
  if (windowNo === 0) {
    marketClosedReason = "現在は移籍市場の期間外です（シーズン状態: " + _str(season.status) + "）。";
  } else if (clock.closed) {
    marketClosedReason = _applicationClosedReason(clock, METHOD_FULL);
  }

  var data = {
    season_id: seasonId,
    season_status: _str(season.status),
    window: windowNo,
    market_open: windowNo > 0 && !clock.closed,
    market_closed_reason: marketClosedReason,
    response_until: clock.response_until ? _iso(clock.response_until) : "",
    is_discount_time: windowNo > 0 ? _isDiscountWindow(season, windowNo, at) : false,
    server_time: _iso(at),
    squad_min: getConfigNum("squad_min", 22),
    squad_max: getConfigNum("squad_max", 35),
    seller_rate_normal: Number(getConfig("seller_rate_normal", 0.9)),
    methods: estimates,
    team_id: teamId,
    budget: null,
    squad: null,
  };

  var pending = _pendingTransfers(seasonId);

  if (teamId) {
    data.budget = _teamAvailableBudget(seasonId, teamId, pending);
    data.squad = _teamSquadCount(seasonId, teamId, pending);
  }

  var lists = _collectTransferTargets(seasonId, teamId, windowNo, pending);
  data.targets = lists.targets;
  data.free_agents = lists.freeAgents;

  return { ok: true, data: data };
}

/**
 * 移籍申請の2段プルダウン用に、獲得候補と フリー選手 を集める。
 *
 * targets     : 他チームに在籍中の選手（交渉移籍・特別・無効化の対象）
 * freeAgents  : どのチームにも在籍していない選手（オークションの対象）
 *
 * 承認待ちの申請が既にある選手には pending フラグを立て、画面側で
 * 選べないようにする。プロテクト状況も返し、特別ルールの可否を表示できるようにする。
 *
 * @param {string} seasonId
 * @param {string} myTeamId  自チーム（除外対象）。空なら除外しない
 * @param {number} windowNo
 * @param {Object[]} pending
 * @returns {{ targets: Object[], freeAgents: Object[] }}
 */
function _collectTransferTargets(seasonId, myTeamId, windowNo, pending) {
  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  // 在籍中の選手 → 所属チーム
  var ownerOf = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;
    ownerOf[_str(r.player_id)] = _str(r.team_id);
  });

  // 承認待ちの申請がある選手
  var pendingOf = {};
  (pending || []).forEach(function (t) {
    pendingOf[_str(t.player_id)] = true;
  });

  // プロテクト中の選手（当該ウィンドウ）
  var protectedOf = {};
  getSheetData("Protections").forEach(function (p) {
    if (_str(p.season_id) !== seasonId) return;
    if (_num(p.window) !== windowNo) return;
    protectedOf[_str(p.player_id)] = true;
  });

  // 今シーズン既に動いていて、強奪の対象にできない選手
  var methodMap = _seasonMethodMap(seasonId);

  var targets = [];
  var freeAgents = [];

  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;

    // 現実移籍で大会対象外になった選手は移籍させられない（SPEC.md §6.5）
    if (!_toBool(p.eligible)) return;

    var owner = ownerOf[pid];
    var base = {
      player_id: pid,
      name:      _str(p.name),
      position:  _str(p.position),
      real_club: _str(p.real_club),
      pending:   !!pendingOf[pid],
    };

    if (!owner) {
      freeAgents.push(base);
      return;
    }
    if (myTeamId && owner === myTeamId) return;

    base.team_id = owner;
    base.team_name = teamNames[owner] || owner;
    base.protected = !!protectedOf[pid];

    // 画面で理由を出せるようにしておく。実際の拒否は _createTransfer 側
    var blocked = _specialRuleBlock(methodMap[pid]);
    base.special_blocked = !!blocked;
    base.special_reason = blocked;

    targets.push(base);
  });

  targets.sort(_comparePlayers);
  freeAgents.sort(_comparePlayers);

  return { targets: targets, freeAgents: freeAgents };
}

/**
 * 移籍一覧を返す。
 *
 * team ロールは自チームが関与する移籍のみ。organizer は全件。
 * payload.pending_only が true なら未確定のものだけ返す。
 *
 * payload: { season_id: string, pending_only?: boolean }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listTransfers(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var pendingOnly = _toBool(payload.pending_only);
  var myTeam = _str(user.team_id);
  var isOrganizer = user.role === "organizer";

  var playerNames = {};
  getSheetData("Players").forEach(function (p) {
    playerNames[_str(p.player_id)] = _str(p.name);
  });

  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  var rows = [];
  getSheetData("Transfers").forEach(function (t) {
    if (_str(t.season_id) !== seasonId) return;

    var status = _str(t.status);
    if (pendingOnly && TX_PENDING_STATUSES.indexOf(status) === -1) return;

    var from = _str(t.from_team);
    var to = _str(t.to_team);

    if (!isOrganizer && myTeam !== from && myTeam !== to) return;

    rows.push({
      transfer_id:      _str(t.transfer_id),
      window:           _num(t.window),
      player_id:        _str(t.player_id),
      player_name:      playerNames[_str(t.player_id)] || _str(t.player_id),
      from_team:        from,
      from_team_name:   from ? (teamNames[from] || from) : "",
      to_team:          to,
      to_team_name:     teamNames[to] || to,
      method:           _str(t.method),
      gross_fee:        _num(t.gross_fee),
      cost_to_buyer:    _num(t.cost_to_buyer),
      payout_to_seller: _num(t.payout_to_seller),
      registered_at:    _iso(t.registered_at),
      status:           status,
      // 自分が今アクションできるか（画面のボタン出し分け用）
      can_respond:      status === TX_SELLER_PENDING && (isOrganizer || myTeam === from),
      can_approve:      status === TX_ORG_PENDING && isOrganizer,
    });
  });

  rows.reverse();
  return { ok: true, data: rows };
}

/**
 * 移籍ログ。承認済みの移籍を新しい順に返す。
 *
 * ▶ listTransfers と何が違うか
 *   listTransfers は「自分が関与する申請の進行状況」を見るためのもので、
 *   参加者には自チーム分しか返さない。こちらは**リーグ全体で誰がどこへ動いたか**を
 *   全員が同じものとして見るための一覧なので、チームで絞らない。
 *
 *   代わりに承認済みだけを返す（原則5）。承認前の申請が混ざると
 *   「成立していない移籍」が成立したものとして読まれる。
 *
 * 返す項目は選手名・移籍元・移籍先・金額・移籍形態に絞っている。
 * 交渉額の内訳や売り手の受取額まで出すと、当事者しか知らないはずの
 * 交渉の中身が全チームに見えてしまう。
 *
 * payload: { season_id?: string }  省略時は進行中のシーズン
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getTransferLog(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id) || _latestSeasonId();
  if (!seasonId) return { ok: false, error: "シーズンが見つかりません。" };

  var playerNames = {};
  getSheetData("Players").forEach(function (p) {
    playerNames[_str(p.player_id)] = _str(p.name);
  });

  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  var rows = [];
  getSheetData("Transfers").forEach(function (t) {
    if (_str(t.season_id) !== seasonId) return;
    if (_str(t.status) !== TX_APPROVED) return;

    var pid = _str(t.player_id);
    var from = _str(t.from_team);
    var to = _str(t.to_team);

    rows.push({
      window:         _num(t.window),
      at:             _iso(t.registered_at),
      _ms:            _timeValue(t.registered_at),
      player_name:    playerNames[pid] || pid,
      from_team_name: from ? (teamNames[from] || from) : "",
      to_team_name:   to ? (teamNames[to] || to) : "",
      amount:         _num(t.cost_to_buyer),
      method:         _str(t.method),
    });
  });

  // 新しい順。文字列ではなく時刻の値で比べる。
  // ISO 以外の書式で入っていると、文字列比較では曜日から並んでしまう
  rows.sort(function (a, b) {
    return b._ms - a._ms;
  });

  rows.forEach(function (r) { delete r._ms; });

  return { ok: true, data: { season_id: seasonId, rows: rows } };
}

// =============================================================================
// 申請
// =============================================================================

/**
 * 移籍を申請する。
 *
 * payload: {
 *   season_id: string,
 *   to_team?: string,     省略時はログインユーザーの所属チーム
 *   player_id: string,
 *   method: string,
 *   gross_fee?: number    交渉額（固定額の形態では無視される）
 * }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function requestTransfer(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var toTeam = _str(payload.to_team) || _str(user.team_id);
  var playerId = _str(payload.player_id);
  var method = _str(payload.method);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!toTeam) return { ok: false, error: "獲得チームが特定できません。" };
  if (!playerId) return { ok: false, error: "player_id は必須です。" };

  try {
    _assertEnum("method", method, TRANSFER_METHODS);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (method === METHOD_AUCTION) {
    return { ok: false, error: "オークションは registerAuction から登録してください。" };
  }

  var access = _checkTeamAccess(user, toTeam);
  if (!access.ok) return access;

  return withLock(function () {
    return _createTransfer({
      seasonId: seasonId,
      toTeam: toTeam,
      playerId: playerId,
      method: method,
      grossFee: payload.gross_fee,
      requireFreeAgent: false,
    });
  });
}

/**
 * オークション結果を登録する。主催者専用。
 *
 * 入札はツール外で行い、確定した「選手・落札チーム・落札額」を記録する。
 *
 * payload: { season_id, to_team, player_id, gross_fee }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function registerAuction(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var toTeam = _str(payload.to_team);
  var playerId = _str(payload.player_id);

  if (!seasonId || !toTeam || !playerId) {
    return { ok: false, error: "season_id / to_team / player_id は必須です。" };
  }
  if (_num(payload.gross_fee) <= 0) {
    return { ok: false, error: "落札額を入力してください。" };
  }

  return withLock(function () {
    return _createTransfer({
      seasonId: seasonId,
      toTeam: toTeam,
      playerId: playerId,
      method: METHOD_AUCTION,
      grossFee: payload.gross_fee,
      requireFreeAgent: true,
    });
  });
}

/**
 * 移籍申請の実処理。requestTransfer と registerAuction の共通部分。
 * 呼び出し元で withLock 済みであること。
 *
 * @param {Object} args
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function _createTransfer(args) {
  var seasonId = args.seasonId;
  var toTeam = args.toTeam;
  var playerId = args.playerId;
  var method = args.method;

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var windowNo = _currentWindow(season);
  if (windowNo === 0) {
    return {
      ok: false,
      error: "現在は移籍市場の期間外です（状態: " + _str(season.status) + "）。",
    };
  }

  // 日付が変わったら市場は完全に閉まる。特別・無効化特別は最終日の23:00まで。
  // オークションは主催者が場外の結果を登録するものなので、この締切の対象にしない
  var at = now();
  if (method !== METHOD_AUCTION) {
    var closedReason = _applicationClosedReason(_marketClock(season, windowNo, at), method);
    if (closedReason) return { ok: false, error: closedReason };
  }

  var player = findRow("Players", "player_id", playerId);
  if (!player) return { ok: false, error: "選手が見つかりません。" };

  if (!_toBool(player.eligible)) {
    return {
      ok: false,
      error: _str(player.name) +
        " は大会対象外です（大会に参加していないクラブへ移籍済み）。移籍の対象にできません。",
    };
  }

  var buyer = findRow("Teams", "team_id", toTeam);
  if (!buyer) return { ok: false, error: "獲得チームが見つかりません。" };

  var fromTeam = _currentTeamOf(seasonId, playerId);

  if (args.requireFreeAgent) {
    if (fromTeam) {
      return {
        ok: false,
        error: "この選手は既に在籍中のためオークション対象になりません。",
      };
    }
  } else {
    if (!fromTeam) {
      return { ok: false, error: "この選手はどのチームにも在籍していません。" };
    }
    if (fromTeam === toTeam) {
      return { ok: false, error: "自チームの選手は獲得できません。" };
    }
  }

  // 同じ選手に対する申請中の移籍が既にないか
  var pending = _pendingTransfers(seasonId);
  for (var i = 0; i < pending.length; i++) {
    if (_str(pending[i].player_id) === playerId) {
      return { ok: false, error: "この選手には既に承認待ちの移籍申請があります。" };
    }
  }

  // 特別ルールはプロテクトされた選手を獲得できない（無効化特別は可）
  if (method === METHOD_SPECIAL && _isProtected(seasonId, windowNo, playerId)) {
    return {
      ok: false,
      error: "この選手はプロテクトされているため特別ルールでは獲得できません。",
    };
  }

  // 期限付き・オークション・特別で既に動いた選手は強奪の対象外。
  // プロテクトと違い、無効化特別でも破れない
  if (method === METHOD_SPECIAL || method === METHOD_OVERRIDE) {
    var blocked = _specialRuleBlock(_seasonMethodMap(seasonId)[playerId]);
    if (blocked) return { ok: false, error: blocked };
  }

  var calc = _calcTransferCost(method, args.grossFee, season, windowNo, at);

  if (calc.cost <= 0) {
    return {
      ok: false,
      error: "コストが 0 です。交渉額、または Config の固定額を確認してください。",
    };
  }

  // 予算チェック（申請中の分も差し引いた「使える予算」で判定）
  var budget = _teamAvailableBudget(seasonId, toTeam, pending);
  if (budget.available < calc.cost) {
    return {
      ok: false,
      error:
        "予算が不足しています。必要 " + calc.cost.toLocaleString() +
        " / 使える予算 " + budget.available.toLocaleString() +
        "（残高 " + budget.balance.toLocaleString() +
        " − 承認待ち " + budget.reserved.toLocaleString() + "）",
    };
  }

  // 人数チェック（申請中の増減を織り込む）
  var squadMin = getConfigNum("squad_min", 22);
  var squadMax = getConfigNum("squad_max", 35);

  var buyerSquad = _teamSquadCount(seasonId, toTeam, pending);
  if (buyerSquad.projected + 1 > squadMax) {
    return {
      ok: false,
      error:
        "獲得側のスカッドが上限 " + squadMax + " 名を超えます（承認待ちを含めて " +
        buyerSquad.projected + " 名）。",
    };
  }

  if (fromTeam) {
    var sellerSquad = _teamSquadCount(seasonId, fromTeam, pending);
    if (sellerSquad.projected - 1 < squadMin) {
      return {
        ok: false,
        error:
          "放出側のスカッドが下限 " + squadMin + " 名を下回ります（承認待ちを含めて " +
          sellerSquad.projected + " 名）。",
      };
    }
  }

  // 交渉移籍だけ売り手の同意を挟む
  var status =
    NEGOTIATED_METHODS.indexOf(method) !== -1 ? TX_SELLER_PENDING : TX_ORG_PENDING;

  var transferId = generateId("tr_");

  appendRow("Transfers", {
    transfer_id:      transferId,
    season_id:        seasonId,
    window:           windowNo,
    player_id:        playerId,
    from_team:        fromTeam,
    to_team:          toTeam,
    method:           method,
    gross_fee:        calc.gross,
    cost_to_buyer:    calc.cost,
    payout_to_seller: calc.payout,
    registered_at:    at,
    status:           status,
  });

  return {
    ok: true,
    data: {
      transfer_id:      transferId,
      status:           status,
      window:           windowNo,
      cost_to_buyer:    calc.cost,
      payout_to_seller: calc.payout,
      discounted:       calc.discounted,
    },
  };
}

// =============================================================================
// 売り手の応答
// =============================================================================

/**
 * 売り手として移籍に同意 / 拒否する。
 *
 * payload: { transfer_id: string, agree: boolean }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function respondTransfer(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var transferId = _str(payload.transfer_id);
  if (!transferId) return { ok: false, error: "transfer_id は必須です。" };

  var agree = _toBool(payload.agree);

  return withLock(function () {
    var tr = findRow("Transfers", "transfer_id", transferId);
    if (!tr) return { ok: false, error: "移籍申請が見つかりません。" };

    if (_str(tr.status) !== TX_SELLER_PENDING) {
      return {
        ok: false,
        error: "売り手承認待ちの申請のみ応答できます（現在: " + _str(tr.status) + "）。",
      };
    }

    var access = _checkTeamAccess(user, _str(tr.from_team));
    if (!access.ok) return { ok: false, error: "この移籍の売り手チームではありません。" };

    var next = agree ? TX_ORG_PENDING : TX_SELLER_REJECTED;
    updateRow("Transfers", "transfer_id", transferId, { status: next });

    return { ok: true, data: { transfer_id: transferId, status: next } };
  });
}

// =============================================================================
// 承認・差戻（主催者専用）
// =============================================================================

/**
 * 移籍を承認する。
 *
 * ここで初めて Rosters と BudgetTx が動く:
 *   - 放出側の Rosters 行を 離脱 に
 *   - 獲得側に Rosters 行を 在籍 で追加
 *   - 買い手に −cost_to_buyer（移籍金支出）
 *   - 売り手に +payout_to_seller（移籍金収入。0 なら計上しない）
 *
 * payload: { transfer_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function approveTransfer(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var transferId = _str(payload.transfer_id);
  if (!transferId) return { ok: false, error: "transfer_id は必須です。" };

  return withLock(function () {
    var tr = findRow("Transfers", "transfer_id", transferId);
    if (!tr) return { ok: false, error: "移籍申請が見つかりません。" };

    if (_str(tr.status) !== TX_ORG_PENDING) {
      return {
        ok: false,
        error: "主催者承認待ちの申請のみ承認できます（現在: " + _str(tr.status) + "）。",
      };
    }

    var seasonId = _str(tr.season_id);
    var fromTeam = _str(tr.from_team);
    var toTeam = _str(tr.to_team);
    var playerId = _str(tr.player_id);
    var method = _str(tr.method);
    var cost = _num(tr.cost_to_buyer);
    var payout = _num(tr.payout_to_seller);

    // 念のため承認時にも予算を確認する。
    // 申請時に予約しているので通常は通るが、罰金などで残高が減った場合に備える。
    var others = _pendingTransfers(seasonId).filter(function (p) {
      return _str(p.transfer_id) !== transferId;
    });
    var budget = _teamAvailableBudget(seasonId, toTeam, others);
    if (budget.available < cost) {
      return {
        ok: false,
        error:
          "承認できません。獲得側の予算が不足しています（必要 " +
          cost.toLocaleString() + " / 使える予算 " + budget.available.toLocaleString() + "）。",
      };
    }

    var at = now();

    // 放出側を離脱にする
    if (fromTeam) {
      _leaveRoster(seasonId, fromTeam, playerId);
    }

    // 獲得側に追加する
    appendRow("Rosters", {
      roster_id:        generateId("r_"),
      season_id:        seasonId,
      team_id:          toTeam,
      player_id:        playerId,
      acquisition_type: method,
      acquired_cost:    cost,
      acquired_at:      at,
      expires_season:   EXPIRING_METHODS.indexOf(method) !== -1 ? seasonId : "",
      status:           ROSTER_ACTIVE,
    });

    // 予算を動かす（買い手支出と売り手受取は別々に計上する・原則4）
    appendRow("BudgetTx", {
      tx_id:      generateId("tx_"),
      season_id:  seasonId,
      team_id:    toTeam,
      amount:     -cost,
      reason:     "移籍金支出",
      ref:        transferId,
      created_at: at,
    });

    if (fromTeam && payout > 0) {
      appendRow("BudgetTx", {
        tx_id:      generateId("tx_"),
        season_id:  seasonId,
        team_id:    fromTeam,
        amount:     payout,
        reason:     "移籍金収入",
        ref:        transferId,
        created_at: at,
      });
    }

    updateRow("Transfers", "transfer_id", transferId, { status: TX_APPROVED });

    return {
      ok: true,
      data: {
        transfer_id: transferId,
        status: TX_APPROVED,
        cost_to_buyer: cost,
        payout_to_seller: payout,
      },
    };
  });
}

/** 一括承認で1回に受け付ける件数の上限 */
var BULK_APPROVE_MAX = 300;

/**
 * 移籍をまとめて承認する。主催者専用。
 *
 * ▶ なぜ approveTransfer を繰り返さないのか
 *   1件ずつだと、そのたびに在籍・予算・移籍の表を読み直して1行ずつ書く。
 *   100件を超えると GAS の実行時間の上限に近づき、途中で止まると
 *   どこまで承認されたか分からなくなる。表は最初に1回だけ読み、
 *   予算は手元で引き算しながら判定し、書き込みは最後にまとめて行う。
 *
 * ▶ 判定は1件ずつ
 *   予算が足りない・既に処理済み、などの申請は飛ばして残りを承認する。
 *   飛ばしたものは理由つきで返すので、個別に見直せる。
 *   申請の古い順に処理するので、予算が足りないときは先に出した申請が優先される。
 *
 * payload: { transfer_ids?: string[], season_id?: string, all_pending?: boolean }
 *   all_pending=true なら、そのシーズンの「主催者承認待ち」をすべて対象にする
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function approveTransfers(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var allPending = _toBool(payload.all_pending);
  var seasonFilter = _str(payload.season_id);
  if (allPending && !seasonFilter) {
    return { ok: false, error: "すべて承認するときは season_id が必要です。" };
  }

  var wanted = {};
  var ids = [];
  (payload.transfer_ids || []).forEach(function (v) {
    var id = _str(v);
    if (id && !wanted[id]) { wanted[id] = true; ids.push(id); }
  });

  if (!allPending && ids.length === 0) {
    return { ok: false, error: "承認する移籍を選んでください。" };
  }

  return withLock(function () {
    var at = now();

    // --- 移籍（1回だけ読む）---
    var txSheet = getSheet("Transfers");
    var txValues = txSheet.getDataRange().getValues();
    var th = txValues[0];
    var c = {};
    ["transfer_id", "season_id", "player_id", "from_team", "to_team", "method",
     "cost_to_buyer", "payout_to_seller", "registered_at", "status"].forEach(function (k) {
      c[k] = th.indexOf(k);
    });

    var byId = {};
    var reserved = {};
    for (var i = 1; i < txValues.length; i++) {
      var r = txValues[i];
      var id = String(r[c.transfer_id]);
      if (!id) continue;
      byId[id] = i;
      if (TX_PENDING_STATUSES.indexOf(String(r[c.status])) !== -1) {
        var rk = String(r[c.season_id]) + "|" + String(r[c.to_team]);
        reserved[rk] = (reserved[rk] || 0) + _num(r[c.cost_to_buyer]);
      }
    }

    if (allPending) {
      Object.keys(byId).forEach(function (id) {
        var r = txValues[byId[id]];
        if (String(r[c.season_id]) !== seasonFilter) return;
        if (String(r[c.status]) !== TX_ORG_PENDING) return;
        if (!wanted[id]) { wanted[id] = true; ids.push(id); }
      });
    }

    if (ids.length === 0) {
      return { ok: true, data: { approved: [], failed: [], approved_count: 0, failed_count: 0 } };
    }
    if (ids.length > BULK_APPROVE_MAX) {
      return { ok: false, error: "一度に承認できるのは " + BULK_APPROVE_MAX + " 件までです（" + ids.length + " 件）。" };
    }

    // 申請の古い順。予算が足りないときに先に出した申請を優先する
    ids.sort(function (a, b) {
      var ra = byId[a] ? _timeValue(txValues[byId[a]][c.registered_at]) : 0;
      var rb = byId[b] ? _timeValue(txValues[byId[b]][c.registered_at]) : 0;
      if (ra !== rb) return ra - rb;
      return (byId[a] || 0) - (byId[b] || 0);
    });

    // 今回まとめて承認する申請の予約は外しておく。1件ずつ承認するたびに
    // 残高から引くので、まだ順番が来ていない申請に先の申請が塞がれないようにする
    ids.forEach(function (id) {
      var bi = byId[id];
      if (!bi) return;
      var br = txValues[bi];
      if (TX_PENDING_STATUSES.indexOf(String(br[c.status])) === -1) return;
      var brk = String(br[c.season_id]) + "|" + String(br[c.to_team]);
      reserved[brk] = (reserved[brk] || 0) - _num(br[c.cost_to_buyer]);
    });

    // --- 予算（1回だけ読む）---
    var balance = {};
    getSheetData("BudgetTx").forEach(function (t) {
      var bk = _str(t.season_id) + "|" + _str(t.team_id);
      balance[bk] = (balance[bk] || 0) + _num(t.amount);
    });

    // --- 在籍（1回だけ読む）---
    var rsSheet = getSheet("Rosters");
    var rsValues = rsSheet.getDataRange().getValues();
    var rh = rsValues[0];
    var rSeason = rh.indexOf("season_id");
    var rTeam = rh.indexOf("team_id");
    var rPlayer = rh.indexOf("player_id");
    var rStatus = rh.indexOf("status");

    var activeAt = {};
    for (var j = 1; j < rsValues.length; j++) {
      if (String(rsValues[j][rStatus]) !== ROSTER_ACTIVE) continue;
      activeAt[String(rsValues[j][rSeason]) + "|" + String(rsValues[j][rTeam]) + "|" +
        String(rsValues[j][rPlayer])] = j;
    }

    var playerNames = {};
    getSheetData("Players").forEach(function (p) { playerNames[_str(p.player_id)] = _str(p.name); });
    var teamNames = _teamNameMap();

    var approved = [];
    var failed = [];
    var newRosters = [];
    var newTx = [];
    var rosterChanged = false;

    ids.forEach(function (id) {
      var idx = byId[id];
      if (!idx) {
        failed.push({ transfer_id: id, reason: "移籍申請が見つかりません" });
        return;
      }
      var r = txValues[idx];
      var seasonId = String(r[c.season_id]);
      var fromTeam = String(r[c.from_team] || "");
      var toTeam = String(r[c.to_team]);
      var playerId = String(r[c.player_id]);
      var method = String(r[c.method]);
      var cost = _num(r[c.cost_to_buyer]);
      var payout = _num(r[c.payout_to_seller]);
      var label = {
        transfer_id: id,
        player_name: playerNames[playerId] || playerId,
        from_team_name: fromTeam ? (teamNames[fromTeam] || fromTeam) : "",
        to_team_name: teamNames[toTeam] || toTeam,
        method: method,
        cost_to_buyer: cost,
        payout_to_seller: payout,
      };

      if (String(r[c.status]) !== TX_ORG_PENDING) {
        label.reason = "主催者承認待ちではありません（現在: " + String(r[c.status]) + "）";
        failed.push(label);
        return;
      }

      // 承認時の予算確認。今回の対象外で承認待ちの申請の分は差し引いて判定する
      var bk = seasonId + "|" + toTeam;
      var available = (balance[bk] || 0) - (reserved[bk] || 0);
      if (available < cost) {
        label.reason = "獲得側の予算が不足しています（必要 " + formatYen_(cost) +
          " / 使える予算 " + formatYen_(available) + "）";
        failed.push(label);
        return;
      }

      if (fromTeam) {
        var ak = seasonId + "|" + fromTeam + "|" + playerId;
        if (activeAt[ak]) {
          rsValues[activeAt[ak]][rStatus] = ROSTER_LEFT;
          delete activeAt[ak];
          rosterChanged = true;
        }
      }

      newRosters.push({
        roster_id:        generateId("r_"),
        season_id:        seasonId,
        team_id:          toTeam,
        player_id:        playerId,
        acquisition_type: method,
        acquired_cost:    cost,
        acquired_at:      at,
        expires_season:   EXPIRING_METHODS.indexOf(method) !== -1 ? seasonId : "",
        status:           ROSTER_ACTIVE,
      });

      newTx.push({
        tx_id: generateId("tx_"), season_id: seasonId, team_id: toTeam,
        amount: -cost, reason: "移籍金支出", ref: id, created_at: at,
      });
      if (fromTeam && payout > 0) {
        newTx.push({
          tx_id: generateId("tx_"), season_id: seasonId, team_id: fromTeam,
          amount: payout, reason: "移籍金収入", ref: id, created_at: at,
        });
        var sk = seasonId + "|" + fromTeam;
        balance[sk] = (balance[sk] || 0) + payout;
      }

      balance[bk] = (balance[bk] || 0) - cost;

      r[c.status] = TX_APPROVED;
      approved.push(label);
    });

    // --- まとめて書く ---
    if (rosterChanged && rsValues.length > 1) {
      var statusCol = rsValues.slice(1).map(function (row) { return [row[rStatus]]; });
      rsSheet.getRange(2, rStatus + 1, statusCol.length, 1).setValues(statusCol);
    }
    _appendRowsBatch("Rosters", newRosters);
    _appendRowsBatch("BudgetTx", newTx);

    if (approved.length > 0) {
      var txCol = txValues.slice(1).map(function (row) { return [row[c.status]]; });
      txSheet.getRange(2, c.status + 1, txCol.length, 1).setValues(txCol);
    }

    var totalCost = 0;
    var totalPayout = 0;
    approved.forEach(function (a) { totalCost += a.cost_to_buyer; totalPayout += a.payout_to_seller; });

    return {
      ok: true,
      data: {
        approved: approved,
        failed: failed,
        approved_count: approved.length,
        failed_count: failed.length,
        total_cost: totalCost,
        total_payout: totalPayout,
      },
    };
  });
}

/**
 * エラー文用の金額表記（例: 1億5000万円）。
 *
 * @param {number} n
 * @returns {string}
 */
function formatYen_(n) {
  var v = Math.round(_num(n));
  var sign = v < 0 ? "-" : "";
  v = Math.abs(v);
  var oku = Math.floor(v / 100000000);
  var man = Math.floor((v % 100000000) / 10000);
  if (oku > 0) return sign + oku + "億" + (man > 0 ? man + "万" : "") + "円";
  if (man > 0) return sign + man + "万円";
  return sign + v + "円";
}

/**
 * 移籍を差し戻す。主催者専用。
 * 未確定の申請（売り手承認待ち / 主催者承認待ち）が対象。
 *
 * payload: { transfer_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function rejectTransfer(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var transferId = _str(payload.transfer_id);
  if (!transferId) return { ok: false, error: "transfer_id は必須です。" };

  return withLock(function () {
    var tr = findRow("Transfers", "transfer_id", transferId);
    if (!tr) return { ok: false, error: "移籍申請が見つかりません。" };

    if (TX_PENDING_STATUSES.indexOf(_str(tr.status)) === -1) {
      return {
        ok: false,
        error: "未確定の申請のみ差し戻せます（現在: " + _str(tr.status) + "）。",
      };
    }

    updateRow("Transfers", "transfer_id", transferId, { status: TX_REJECTED });
    return { ok: true, data: { transfer_id: transferId, status: TX_REJECTED } };
  });
}

/**
 * 指定シーズン・チーム・選手の在籍行を「離脱」にする。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {string} playerId
 * @returns {boolean} 変更できたか
 */
function _leaveRoster(seasonId, teamId, playerId) {
  var sheet = getSheet("Rosters");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iTeam = headers.indexOf("team_id");
  var iPlayer = headers.indexOf("player_id");
  var iStatus = headers.indexOf("status");

  for (var i = 1; i < values.length; i++) {
    if (
      String(values[i][iSeason]) === seasonId &&
      String(values[i][iTeam]) === teamId &&
      String(values[i][iPlayer]) === playerId &&
      String(values[i][iStatus]) === ROSTER_ACTIVE
    ) {
      sheet.getRange(i + 1, iStatus + 1).setValue(ROSTER_LEFT);
      return true;
    }
  }
  return false;
}
