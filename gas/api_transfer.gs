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
 *   approveTransfer    — 承認（Rosters 移動 + BudgetTx 計上）
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
 * 指定日時が最終日割引の時間帯に入っているか判定する（SPEC.md §7.4）。
 *
 * 条件:
 *   - 市場最終日（windowN_open_at + 2日）と同じ日であること
 *   - 時刻が discount_start 以上 discount_end 以下であること
 *
 * 時刻はすべてサーバー（GAS）側の値で判定する。
 *
 * @param {Object} season   Seasons の行
 * @param {number} windowNo 1 または 2
 * @param {Date}   at       判定したい日時（通常は now()）
 * @returns {boolean}
 */
function _isDiscountWindow(season, windowNo, at) {
  var openRaw = windowNo === 2 ? season.window2_open_at : season.window1_open_at;
  if (!(openRaw instanceof Date)) {
    if (!openRaw) return false;
    openRaw = new Date(openRaw);
    if (isNaN(openRaw.getTime())) return false;
  }

  // 市場は3日間。最終日 = 開幕日 + 2日
  var lastDay = new Date(openRaw.getTime());
  lastDay.setDate(lastDay.getDate() + 2);

  if (!_isSameDate(at, lastDay)) return false;

  var start = _parseHourMinute(getConfig("discount_start", "22:00"));
  var end = _parseHourMinute(getConfig("discount_end", "23:00"));
  if (!start || !end) return false;

  var mins = at.getHours() * 60 + at.getMinutes();
  var startMins = start.h * 60 + start.m;
  var endMins = end.h * 60 + end.m;

  return mins >= startMins && mins <= endMins;
}

// =============================================================================
// コスト算出（SPEC.md §5.3 / §5.4）
// =============================================================================

/**
 * 移籍形態からコストを算出する。
 *
 * 金額はすべて Config 参照。割引は特別ルールのみ（無効化には適用しない）。
 *
 * @param {string} method    移籍形態
 * @param {number} grossFee  交渉額・落札額（固定額の形態では無視）
 * @param {Object} season    Seasons の行
 * @param {number} windowNo  1 または 2
 * @param {Date}   at        サーバー時刻
 * @returns {{gross: number, cost: number, payout: number, discounted: boolean}}
 */
function _calcTransferCost(method, grossFee, season, windowNo, at) {
  var fee = Math.max(0, Math.floor(_num(grossFee)));
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
      payout: Math.round(fee * rate),
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
    // 無効化特別ルールに割引は無い（SPEC.md §5.3）
    var amt = getConfigNum(w === 2 ? "override_w2" : "override_w1", 0);
    var orate = Number(getConfig("seller_rate_override", 0.7));
    return {
      gross: amt,
      cost: amt,
      payout: Math.round(amt * orate),
      discounted: false,
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
  var balance = 0;
  getSheetData("BudgetTx").forEach(function (t) {
    if (_str(t.team_id) === teamId) balance += _num(t.amount);
  });

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

  // 形態別のコスト見積り（交渉額に依存する形態は gross_fee=0 で返す）
  var estimates = TRANSFER_METHODS.map(function (m) {
    var c = _calcTransferCost(m, 0, season, windowNo || 1, at);
    return {
      method: m,
      fixed_cost: c.cost,
      payout: c.payout,
      discounted: c.discounted,
      needs_fee: NEGOTIATED_METHODS.indexOf(m) !== -1 || m === METHOD_AUCTION,
      needs_seller_approval: NEGOTIATED_METHODS.indexOf(m) !== -1,
    };
  });

  var data = {
    season_id: seasonId,
    season_status: _str(season.status),
    window: windowNo,
    market_open: windowNo > 0,
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

  var targets = [];
  var freeAgents = [];

  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;

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

  var player = findRow("Players", "player_id", playerId);
  if (!player) return { ok: false, error: "選手が見つかりません。" };

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

  var at = now();
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
