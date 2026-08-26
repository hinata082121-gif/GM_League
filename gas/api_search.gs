/**
 * api_search.gs — 選手を探すための読み取り API
 *
 *   getTeamRoster  — チームのエントリーリストとエントリー外選手を分けて返す
 *   searchPlayers  — 参加13クラブの選手を条件で絞り込む
 *
 * 何のための機能か
 *   移籍の交渉相手を探すとき、エントリーの入れ替えを考えるとき、
 *   補填で誰を取るか決めるとき——いずれも「あのクラブに誰がいるか」を
 *   一覧で見たい。スカッドだけを出す画面ではその半分しか見えない。
 *
 *   エントリーリスト   = そのシーズンに登録されている在籍選手
 *   エントリー外選手   = 同じ現実クラブの選手で、そのチームの登録に入っていない人
 *
 * 注意 ここは読み取り専用。書き込みは一切しない。
 *   ただし公開エンドポイント（getPublicData）には足さない。
 *   ログイン済みの参加者だけが見られれば十分で、
 *   誰が誰を狙っているかの材料を league の外に出す必要はない。
 */

/**
 * 保有状況。**見る人のチームから見た関係**で決まる。
 *
 * 同じ選手でも、ガンバのGMから見れば「自チーム」、
 * 柏のGMから見れば「他チーム保有」になる。
 * 誰にとっての話かが決まらないと意味を持たない値なので、
 * 判定には必ず基準チームを渡す。
 */
var HOLD_MINE = "自チーム";
var HOLD_OTHER = "他チーム保有";
var HOLD_FREE = "未保有";

// =============================================================================
// チームの選手リスト
// =============================================================================

/**
 * チームのエントリーリストとエントリー外選手を分けて返す。
 *
 * エントリー外選手には保有チーム名を添える。
 * 「自クラブなのに他のGMに押さえられている」ことが分かると、
 * 交渉に行くべき相手がその場で見える。
 *
 * payload: { team_id: string, season_id?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getTeamRoster(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var teamId = _str(payload.team_id);
  if (!teamId) return { ok: false, error: "team_id は必須です。" };

  var seasonId = _str(payload.season_id) || _latestSeasonId();

  var squadRes = getTeamSquad(token, { team_id: teamId, season_id: seasonId });
  if (!squadRes.ok) return squadRes;

  var team = findRow("Teams", "team_id", teamId);
  if (!team) return { ok: false, error: "チームが見つかりません。" };

  // 使用クラブはチーム名と同じ。参加者は現実のクラブ名でチームを持つ
  var clubName = _str(team.name);

  var held = _heldPlayerMap(seasonId);
  var teamNames = _teamNameMap();

  var inEntry = {};
  squadRes.data.squad.forEach(function (s) { inEntry[s.player_id] = true; });

  var outside = [];
  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;
    if (_str(p.real_club) !== clubName) return;
    if (inEntry[pid]) return;

    var holder = held[pid] || "";

    outside.push({
      player_id:       pid,
      name:            _str(p.name),
      position:        _str(p.position),
      detail_position: _str(p.detail_position),
      age:             _num(p.age),
      nationality:     _normalizeNationality(p.nationality),
      foreign:         _isForeign(p.nationality),
      real_club:       _str(p.real_club),
      eligible:        _toBool(p.eligible),
      held_by:         holder,
      held_by_name:    holder ? (teamNames[holder] || holder) : "",
      hold_status:     holder ? HOLD_OTHER : HOLD_FREE,
    });
  });

  outside.sort(_comparePlayers);

  var freeCount = outside.filter(function (o) {
    return o.hold_status === HOLD_FREE;
  }).length;

  return {
    ok: true,
    data: {
      team_id:         teamId,
      team_name:       clubName,
      season_id:       seasonId,
      entry:           squadRes.data,
      outside:         outside,
      outside_total:   outside.length,
      outside_free:    freeCount,
      outside_held:    outside.length - freeCount,
    },
  };
}

/**
 * そのシーズンに保有されている選手 → 保有チームID の対応。
 *
 * 申請中も保有として扱う。承認待ちの選手を「空いている」と見せると、
 * 二重に狙わせてしまう。
 *
 * @param {string} seasonId
 * @returns {Object}
 */
function _heldPlayerMap(seasonId) {
  var held = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    var st = _str(r.status);
    if (st !== ROSTER_ACTIVE && st !== ROSTER_PENDING) return;
    held[_str(r.player_id)] = _str(r.team_id);
  });
  return held;
}

// =============================================================================
// 選手検索
// =============================================================================

/** 検索が一度に返す上限。画面が固まらないようにする */
var SEARCH_LIMIT = 300;

/**
 * 参加クラブの選手を条件で絞り込む。
 *
 * エントリー済みかどうかを問わず、選手マスタ全体から探す。
 * 条件は**すべて任意**で、1つだけ指定しても、何も指定しなくても動く。
 * 指定した条件は AND でつながる。
 *
 * payload: {
 *   season_id?,
 *   team_id?,         保有状況の基準。省略時は見ている人のチーム
 *   name?,            部分一致。空白・中黒・ヴの揺れを吸収する
 *   position?,        大分類 GK/DF/MF/FW
 *   detail_position?, 詳細 CB/CMF など
 *   age_min?, age_max?,
 *   real_club?,
 *   hold_status?,     自チーム / 他チーム保有 / 未保有
 *   foreign?,         "1"=外国籍のみ / "0"=日本国籍のみ
 *   limit?
 * }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function searchPlayers(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var q = _parseSearchQuery(payload);
  if (q.error) return { ok: false, error: q.error };

  var held = _heldPlayerMap(q.seasonId);
  var teamNames = _teamNameMap();

  // 「自チーム」がどこかの基準。指定が無ければ見ている人のチーム。
  // 主催者はチームを持たないので、その場合は自チーム扱いになる選手がいない
  var baseTeam = _str(payload.team_id) || _str(auth.data.team_id);

  var hits = [];
  var total = 0;

  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;

    var age = _num(p.age);
    var holder = held[pid] || "";
    var status = _holdStatus(holder, baseTeam);

    if (q.name && _normalizeName(p.name).indexOf(q.name) === -1) return;
    if (q.position && _str(p.position) !== q.position) return;
    if (q.detail && _str(p.detail_position) !== q.detail) return;
    if (q.club && _str(p.real_club) !== q.club) return;
    if (q.holdStatus && status !== q.holdStatus) return;

    // 年齢は未入力（0）を範囲の判定から外す。
    // 0歳として弾くと、名簿がまだ届いていない選手が全部消える
    if (q.ageMin !== null) { if (!age || age < q.ageMin) return; }
    if (q.ageMax !== null) { if (!age || age > q.ageMax) return; }

    if (q.foreign !== null && _isForeign(p.nationality) !== q.foreign) return;

    total++;
    if (hits.length >= q.limit) return;

    hits.push({
      player_id:       pid,
      name:            _str(p.name),
      position:        _str(p.position),
      detail_position: _str(p.detail_position),
      age:             age,
      nationality:     _normalizeNationality(p.nationality),
      foreign:         _isForeign(p.nationality),
      real_club:       _str(p.real_club),
      eligible:        _toBool(p.eligible),
      held_by:         holder,
      held_by_name:    holder ? (teamNames[holder] || holder) : "",
      hold_status:     status,
    });
  });

  hits.sort(_comparePlayers);

  return {
    ok: true,
    data: {
      season_id: q.seasonId,
      base_team: baseTeam,
      total:     total,
      shown:     hits.length,
      truncated: total > hits.length,
      limit:     q.limit,
      players:   hits,
    },
  };
}

/**
 * 基準チームから見た保有状況。
 *
 * @param {string} holder 保有チームID。空なら誰も持っていない
 * @param {string} baseTeam 基準になるチームID。空なら自チームは無い
 * @returns {string}
 */
function _holdStatus(holder, baseTeam) {
  if (!holder) return HOLD_FREE;
  if (baseTeam && holder === baseTeam) return HOLD_MINE;
  return HOLD_OTHER;
}

/**
 * 検索条件を整える。
 *
 * 指定が無い条件は「絞らない」を意味する null / 空文字にする。
 * ここで弾くのは、明らかに検索として成り立たない指定だけ。
 *
 * @param {Object} payload
 * @returns {Object} error があれば失敗
 */
function _parseSearchQuery(payload) {
  var ageMin = _str(payload.age_min) === "" ? null : Math.round(_num(payload.age_min));
  var ageMax = _str(payload.age_max) === "" ? null : Math.round(_num(payload.age_max));

  if (ageMin !== null && ageMax !== null && ageMin > ageMax) {
    return { error: "年齢の下限が上限を超えています。" };
  }
  if (ageMin !== null && ageMin < 0) return { error: "年齢の下限は0以上にしてください。" };
  if (ageMax !== null && ageMax < 0) return { error: "年齢の上限は0以上にしてください。" };

  var position = _str(payload.position).toUpperCase();
  var detail = _str(payload.detail_position).toUpperCase();

  // 詳細だけ指定されたら大分類は要らない。両方来たら食い違いを弾く
  if (detail) {
    var from = _positionOfDetail(detail);
    if (!from) return { error: "詳細ポジションが不正です: " + detail };
    if (position && position !== from) {
      return { error: detail + " は " + from + " の詳細です（" + position + " と一致しません）" };
    }
    position = "";
  } else if (position && POSITIONS.indexOf(position) === -1) {
    return { error: "ポジションが不正です: " + position };
  }

  var hold = _str(payload.hold_status);
  if (hold && [HOLD_MINE, HOLD_OTHER, HOLD_FREE].indexOf(hold) === -1) {
    return { error: "保有状況が不正です: " + hold };
  }

  var foreignRaw = _str(payload.foreign);
  var foreign = foreignRaw === "" ? null : _toBool(foreignRaw);

  var limit = Math.round(_num(payload.limit)) || SEARCH_LIMIT;
  if (limit < 1) limit = SEARCH_LIMIT;
  if (limit > SEARCH_LIMIT) limit = SEARCH_LIMIT;

  return {
    seasonId:   _str(payload.season_id) || _latestSeasonId(),
    name:       _normalizeName(payload.name),
    position:   position,
    detail:     detail,
    club:       _str(payload.real_club),
    holdStatus: hold,
    ageMin:     ageMin,
    ageMax:     ageMax,
    foreign:    foreign,
    limit:      limit,
  };
}
