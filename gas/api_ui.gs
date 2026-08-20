/**
 * api_ui.gs — 画面に何を出すかの判定
 *
 *   getUiState — 参加者に見せるタブの一覧
 *
 * ▶ 何をする機能か
 *   移籍市場や監督申告のように**期間が決まっているもの**は、期間外に
 *   タブが並んでいても押せるだけで何もできない。参加者が「今できること」を
 *   探しにくくなるので、期間外は画面から消す。
 *
 *   **機能そのものは残っている。** 消えるのはタブだけで、
 *   主催者は代理入力のためにいつでも操作できる。
 *
 * ⚠️ これは見た目の整理であって、権限の仕組みではない。
 *   タブを隠しても API は叩けるので、**期間の検証は各 action 側で必ず行う**。
 *   ここを消し忘れても、期間外の書き込みは元々拒否される。
 *
 * ⚠️ 設計原則
 *   2. 期間の判定はサーバー側の now() で行う。端末の時計は見ない
 */

// =============================================================================
// タブの判定
// =============================================================================

/**
 * 参加者に見せるタブを返す。
 *
 * 主催者にはすべて開いた状態で返す。期限を過ぎた参加者の代わりに
 * 入力することがあるため、隠してしまうと運用が回らない。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getUiState(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var isOrganizer = _str(user.role) === "organizer";

  // シーズンが指定されていなければ一番下の行（最新）を使う
  if (!seasonId) {
    var seasons = getSheetData("Seasons").filter(function (s) {
      return _str(s.season_id);
    });
    if (seasons.length > 0) seasonId = _str(seasons[seasons.length - 1].season_id);
  }

  var season = seasonId ? findRow("Seasons", "season_id", seasonId) : null;
  var at = now();

  var tabs = isOrganizer
    ? _allTabsOpen()
    : _participantTabs(season, _str(user.team_id), at);

  return {
    ok: true,
    data: {
      season_id:     seasonId,
      season_status: season ? _str(season.status) : "",
      role:          _str(user.role),
      always_open:   isOrganizer,
      tabs:          tabs,
      server_time:   _iso(at),
    },
  };
}

/**
 * 主催者向け。すべて開いた状態。
 *
 * @returns {Object}
 */
function _allTabsOpen() {
  var out = {};
  _periodTabs().forEach(function (key) {
    out[key] = { open: true, reason: "主催者は常に表示されます。" };
  });
  return out;
}

/**
 * 期間で出し入れするタブの一覧。
 *
 * ここに無いタブ（ダッシュボード・チーム閲覧・試合・順位・日程）は常に表示する。
 * 期限に関係なく、いつ見てもよい情報だから。
 *
 * @returns {string[]}
 */
function _periodTabs() {
  return ["entry", "transfer", "protect", "manager", "claims"];
}

/**
 * 参加者向け。今の時点で開いているタブだけを true にする。
 *
 * @param {Object|null} season
 * @param {string} teamId
 * @param {Date} at
 * @returns {Object}
 */
function _participantTabs(season, teamId, at) {
  return {
    entry:    _entryTabState(season),
    transfer: _transferTabState(season),
    protect:  _protectTabState(season, at),
    manager:  _managerTabState(),
    claims:   _claimsTabState(season, teamId),
  };
}

/**
 * エントリー — シーズンが「エントリー受付」のときだけ。
 *
 * @param {Object|null} season
 * @returns {Object}
 */
function _entryTabState(season) {
  if (!season) return { open: false, reason: "シーズンがありません。" };

  var status = _str(season.status);
  if (status === SEASON_ENTRY_OPEN) {
    return { open: true, reason: "エントリー受付中です。" };
  }

  return { open: false, reason: "エントリーの受付期間ではありません。" };
}

/**
 * 移籍 — シーズンが「移籍市場1」「移籍市場2」のときだけ。
 *
 * @param {Object|null} season
 * @returns {Object}
 */
function _transferTabState(season) {
  if (!season) return { open: false, reason: "シーズンがありません。" };

  var w = MARKET_WINDOW[_str(season.status)] || 0;
  if (w > 0) {
    return { open: true, reason: "第" + w + "次移籍市場が開いています。" };
  }

  return { open: false, reason: "移籍市場の期間ではありません。" };
}

/**
 * プロテクト — 無料期または有料期のときだけ。
 *
 * シーズンの状態ではなく**現在時刻**から判定する。
 * 無料期・有料期は状態をまたぐため（SPEC.md §7.3）。
 *
 * @param {Object|null} season
 * @param {Date} at
 * @returns {Object}
 */
function _protectTabState(season, at) {
  if (!season) return { open: false, reason: "シーズンがありません。" };

  var ph = _currentProtectionPhase(season, at);

  if (ph.phase === PROTECT_PHASE_FREE) {
    return { open: true, reason: "第" + ph.window + "次の無料プロテクト期間です。" };
  }
  if (ph.phase === PROTECT_PHASE_PAID) {
    return { open: true, reason: "第" + ph.window + "次の有料プロテクト期間です。" };
  }

  return { open: false, reason: "プロテクトの設定期間ではありません。" };
}

/**
 * 使用監督 — 受付が第一次か第二次のときだけ。
 *
 * @returns {Object}
 */
function _managerTabState() {
  var round = _managerRound();

  if (round === MG_ROUND_FIRST) {
    return { open: true, reason: "第一次の申告を受け付けています。" };
  }
  if (round === MG_ROUND_SECOND) {
    return { open: true, reason: "第二次（先着）の申告を受け付けています。" };
  }

  return { open: false, reason: "使用監督の申告期間ではありません。" };
}

/**
 * 補填の選択 — 自分に未精算の請求があり、かつ選択期限内のときだけ。
 *
 * 請求が無ければそもそも用がないので出さない。
 * 期限を過ぎたら消える。以降は主催者が代理で入力する。
 *
 * @param {Object|null} season
 * @param {string} teamId
 * @returns {Object}
 */
function _claimsTabState(season, teamId) {
  if (!season) return { open: false, reason: "シーズンがありません。" };
  if (!teamId) return { open: false, reason: "チームが割り当てられていません。" };

  var pending = 0;
  _claimsOf(_str(season.season_id)).forEach(function (c) {
    if (_str(c.team_id) !== teamId) return;
    var st = _str(c.status);
    if (st === CLAIM_SETTLED || st === CLAIM_VOID) return;
    pending++;
  });

  if (pending === 0) {
    return { open: false, reason: "補填の対象はありません。" };
  }

  if (!_isClaimWindowOpen(season)) {
    return { open: false, reason: "補填の選択期限を過ぎています。" };
  }

  return { open: true, reason: pending + " 件の補填を選べます。", count: pending };
}
