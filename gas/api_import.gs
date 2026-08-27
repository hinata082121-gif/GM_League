/**
 * api_import.gs — 過去シーズンのチームを取り込む（主催者専用）
 *
 *   importRoster  — チームのスカッドを名前で一括登録する
 *   adjustBudget  — 予算を任意の理由で増減する
 *
 * 何のための機能か
 *   ツールを使い始める前から続いている大会を取り込むための入口。
 *   通常の在籍データは「エントリー提出 → 承認」か「移籍承認」でしか作られないが、
 *   過去シーズンのスカッドはそのどちらの手順も踏めない。
 *   - エントリーは自クラブの選手に限られるが、過去の移籍で他クラブの選手を持っている
 *   - 新規チームは28名ちょうどだが、実際の人数はそれとは限らない
 *   そこで、主催者が名簿をそのまま流し込める道を用意する。
 *
 * 注意 これは移行用であって、通常運用では使わない。
 *   シーズンが動き出したら、在籍は移籍の承認を通して動かす。
 *   人数制限（22〜35名）もかけない。過去の記録をありのまま入れるため。
 *   ただし外れている場合は warnings で知らせる。
 *
 * 注意 設計原則
 *   1. 書き込みは必ず GAS 経由
 *   3. 予算は BudgetTx の SUM。adjustBudget も行を1本足すだけ
 */

/** 予算調整の理由（既定） */
var REASON_BUDGET_ADJUST = "予算調整";

/** 取り込みで作った在籍の既定の獲得種別 */
var ACQ_INITIAL = "初期";

// =============================================================================
// スカッドの取り込み
// =============================================================================

/**
 * チームのスカッドを一括登録する。主催者専用。
 *
 * 選手は名前とポジションで照合し、選手マスタに無ければ作る。
 * 名簿を書き写すだけで済むように、player_id を用意させない。
 *
 * payload: {
 *   season_id, team_id, replace?,
 *   players: [{ name, position, age?, nationality?, real_club?,
 *               acquisition_type?, acquired_cost?, expires_season? }]
 * }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function importRoster(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  var list = payload.players || [];

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "team_id は必須です。" };
  if (list.length === 0) return { ok: false, error: "選手が1人も指定されていません。" };

  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }
  if (!findRow("Teams", "team_id", teamId)) {
    return { ok: false, error: "チームが見つかりません。" };
  }

  // 先に全件を検証する。1件でも駄目なら何も書かない。
  // 途中まで登録された状態で失敗すると、どこまで入ったのか分からなくなる
  var parsed = [];
  for (var i = 0; i < list.length; i++) {
    var row = _parseImportRow(list[i], i);
    if (row.error) return { ok: false, error: row.error };
    parsed.push(row);
  }

  var dup = _findDuplicateNames(parsed);
  if (dup) {
    return { ok: false, error: "名簿の中で " + dup + " が重複しています。" };
  }

  return withLock(function () {
    var at = now();

    // 既存の選手マスタを 名前+ポジション で引けるようにする
    var byKey = {};
    getSheetData("Players").forEach(function (p) {
      byKey[_pairKey(p.name, p.position)] = p;
    });

    // 同じシーズンで他チームが持っている選手（入替のときは自チーム分を除く）
    var heldBy = {};
    getSheetData("Rosters").forEach(function (r) {
      if (_str(r.season_id) !== seasonId) return;
      var st = _str(r.status);
      if (st !== ROSTER_ACTIVE && st !== ROSTER_PENDING) return;
      heldBy[_str(r.player_id)] = _str(r.team_id);
    });

    var teamNames = _teamNameMap();
    var conflicts = [];
    var createdPlayers = [];
    var resolved = [];

    parsed.forEach(function (row) {
      var key = _pairKey(row.name, row.position);
      var player = byKey[key];

      if (!player) {
        var pid = generateId("p_");
        appendRow("Players", {
          player_id: pid,
          name:      row.name,
          position:  row.position,
          detail_position: row.detail_position,
          age:         row.age,
          nationality: row.nationality,
          real_club: row.real_club,
          eligible:  true,
        });
        player = { player_id: pid, name: row.name, position: row.position };
        byKey[key] = player;
        createdPlayers.push(row.name);
      }

      var playerId = _str(player.player_id);

      // 既にいる選手で未設定の項目を、名簿の表記で埋める。
      // 大分類しか入っていない古いデータを、取り込みのたびに育てられる。
      // 既に値があるものは上書きしない。名簿によって粒度が違うので、
      // 後から来た薄い名簿で厚いデータを潰さないようにする
      var fill = {};
      if (row.detail_position && !_str(player.detail_position)) {
        fill.detail_position = row.detail_position;
      }
      if (row.age && !_num(player.age)) fill.age = row.age;
      if (row.nationality && !_str(player.nationality)) {
        fill.nationality = row.nationality;
      }

      if (Object.keys(fill).length > 0) {
        updateRow("Players", "player_id", playerId, fill);
        Object.keys(fill).forEach(function (k) { player[k] = fill[k]; });
      }

      var holder = heldBy[playerId];

      if (holder && holder !== teamId) {
        conflicts.push(row.name + "（" + (teamNames[holder] || holder) + "）");
      }

      resolved.push({ row: row, player_id: playerId });
    });

    if (conflicts.length > 0) {
      return {
        ok: false,
        error: "他のチームが既に保有しています: " + conflicts.join(" / "),
      };
    }

    // 入れ替えなら、このシーズンのこのチームの在籍・申請中を先に消す。
    // 離脱の履歴は残す
    var removed = 0;
    if (_toBool(payload.replace)) {
      removed = _deleteRostersByStatus(seasonId, teamId, [ROSTER_PENDING, ROSTER_ACTIVE]);
    }

    var rows = [];
    var added = 0;
    var skipped = [];

    resolved.forEach(function (r) {
      if (!_toBool(payload.replace) && heldBy[r.player_id] === teamId) {
        skipped.push(r.row.name);
        return;
      }

      rows.push({
        roster_id:        generateId("rs_"),
        season_id:        seasonId,
        team_id:          teamId,
        player_id:        r.player_id,
        status:           ROSTER_ACTIVE,
        acquisition_type: r.row.acquisition_type,
        acquired_cost:    r.row.acquired_cost,
        acquired_at:      at,
        expires_season:   r.row.expires_season,
      });
      added++;
    });

    _appendRowsBatch("Rosters", rows);

    return {
      ok: true,
      data: {
        season_id:       seasonId,
        team_id:         teamId,
        team_name:       teamNames[teamId] || teamId,
        added:           added,
        removed:         removed,
        skipped:         skipped,
        created_players: createdPlayers,
        warnings:        _squadWarnings(added),
      },
    };
  });
}

/**
 * 名簿の1行を検証して整える。
 *
 * @param {Object} raw
 * @param {number} index 0起点。エラー文で何行目かを示す
 * @returns {Object} error があれば失敗
 */
function _parseImportRow(raw, index) {
  var no = (index + 1) + "人目";
  var name = _str(raw.name).trim();

  if (!name) return { error: no + ": 選手名が空です。" };

  // position に LSB や CMF のような詳細が入っていても受ける。
  // エントリーリストの表記をそのまま渡せるようにするため
  var rawPos = _str(raw.position);
  var isDetail = !!_positionOfDetail(rawPos);
  var pos = _resolvePosition(
    isDetail ? "" : rawPos,
    _str(raw.detail_position) || (isDetail ? rawPos : "")
  );

  if (pos.error) return { error: no + "（" + name + "）: " + pos.error };

  var position = pos.position;

  var acq = _str(raw.acquisition_type).trim() || ACQ_INITIAL;
  if (acq !== ACQ_INITIAL && TRANSFER_METHODS.indexOf(acq) === -1) {
    return {
      error: no + "（" + name + "）: 獲得種別は " + ACQ_INITIAL + " / " +
        TRANSFER_METHODS.join(" / ") + " のいずれかにしてください。",
    };
  }

  var cost = Math.round(_num(raw.acquired_cost));
  if (cost < 0) return { error: no + "（" + name + "）: 獲得額は0以上にしてください。" };

  var age = _parseAge(raw.age);
  if (age.error) return { error: no + "（" + name + "）: " + age.error };

  return {
    name:             name,
    position:         position,
    detail_position:  pos.detail,
    age:              age.age,
    nationality:      _str(raw.nationality).trim(),
    real_club:        _str(raw.real_club).trim(),
    acquisition_type: acq,
    acquired_cost:    cost,
    expires_season:   _str(raw.expires_season).trim(),
  };
}

/**
 * 名簿の中で重複している名前を1つ返す。
 *
 * @param {Object[]} rows
 * @returns {string} 無ければ空文字
 */
function _findDuplicateNames(rows) {
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var key = _pairKey(rows[i].name, rows[i].position);
    if (seen[key]) return rows[i].name;
    seen[key] = true;
  }
  return "";
}

/**
 * 人数がスカッド制約から外れていれば知らせる。
 *
 * エラーにはしない。過去シーズンの記録をそのまま入れるための機能なので、
 * 当時の人数が今の制約に収まっているとは限らない。
 *
 * @param {number} count
 * @returns {string[]}
 */
function _squadWarnings(count) {
  var min = getConfigNum("squad_min", 22);
  var max = getConfigNum("squad_max", 35);
  var out = [];

  if (count < min) out.push(count + "名です。最小人数（" + min + "名）を下回っています。");
  if (count > max) out.push(count + "名です。最大人数（" + max + "名）を超えています。");

  return out;
}

// =============================================================================
// 試合結果の取り込み
// =============================================================================

/**
 * 過去シーズンの試合結果を一括で取り込む。主催者専用。
 *
 * 何のための機能か
 *   ツールを使う前のシーズンには、順位表の元になる試合が1件も無い。
 *   順位表は試合から毎回導出する作りなので（設計原則5）、
 *   表の数字だけを保存する逃げ道は作らず、試合そのものを入れる。
 *
 * 通常の申請（submitMatchResult）と分けている理由:
 *   - 得点者の合計とスコアの一致を求めない。
 *     移行元に得点者の記録が無くても順位表は作れる
 *   - シーズンの状態を問わない。終了したシーズンにも入れられる
 *   - チームを**名前で**指定できる。対戦表をそのまま流し込める
 *
 * 注意 これは移行用。シーズンが動き出したら通常の申請・承認を使う。
 *
 * payload: {
 *   season_id, stage?, replace?,
 *   matches: [{ round, home, away, home_score, away_score, home_pk?, away_pk? }]
 * }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function importMatches(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var stage = _str(payload.stage) || STAGE_LEAGUE;
  var list = payload.matches || [];

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (list.length === 0) return { ok: false, error: "試合が1件も指定されていません。" };
  if (MATCH_STAGES.indexOf(stage) === -1) {
    return { ok: false, error: "stage が不正です: " + stage };
  }
  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }

  // チーム名から ID を引けるようにする。対戦表はチーム名で書かれている
  var idByName = {};
  getSheetData("Teams").forEach(function (t) {
    var name = _str(t.name);
    if (name) idByName[name] = _str(t.team_id);
  });

  // 先に全件を検証する。1件でも駄目なら何も書かない
  var parsed = [];
  for (var i = 0; i < list.length; i++) {
    var row = _parseImportMatch(list[i], i, idByName);
    if (row.error) return { ok: false, error: row.error };
    parsed.push(row);
  }

  return withLock(function () {
    var at = now();
    var removed = 0;

    if (_toBool(payload.replace)) {
      removed = _deleteMatchesOf(seasonId, stage);
    }

    var rows = parsed.map(function (m) {
      return {
        match_id:    generateId("m_"),
        season_id:   seasonId,
        stage:       stage,
        round:       m.round,
        tie_id:      "",
        leg:         "",
        home_team:   m.home,
        away_team:   m.away,
        home_score:  m.hs,
        away_score:  m.as,
        home_pk:     m.hpk,
        away_pk:     m.apk,
        status:      MATCH_APPROVED,
        reported_by: _str(auth.data.user_id),
        created_at:  at,
      };
    });

    _appendRowsBatch("Matches", rows);

    return {
      ok: true,
      data: {
        season_id: seasonId,
        stage:     stage,
        added:     rows.length,
        removed:   removed,
      },
    };
  });
}

/**
 * 取り込む試合1件を検証して整える。
 *
 * @param {Object} raw
 * @param {number} index 0起点
 * @param {Object} idByName チーム名 → team_id
 * @returns {Object} error があれば失敗
 */
function _parseImportMatch(raw, index, idByName) {
  var no = (index + 1) + "件目";

  var homeName = _str(raw.home);
  var awayName = _str(raw.away);
  if (!homeName || !awayName) return { error: no + ": チーム名が空です。" };

  var home = idByName[homeName];
  var away = idByName[awayName];
  if (!home) return { error: no + ": チームが見つかりません: " + homeName };
  if (!away) return { error: no + ": チームが見つかりません: " + awayName };
  if (home === away) return { error: no + ": 同じチーム同士の対戦になっています: " + homeName };

  var hs = Math.floor(_num(raw.home_score));
  var as = Math.floor(_num(raw.away_score));
  if (hs < 0 || as < 0) return { error: no + ": スコアに負の数は入力できません。" };

  return {
    round: _str(raw.round),
    home:  home,
    away:  away,
    hs:    hs,
    as:    as,
    hpk:   _str(raw.home_pk) === "" ? "" : Math.floor(_num(raw.home_pk)),
    apk:   _str(raw.away_pk) === "" ? "" : Math.floor(_num(raw.away_pk)),
  };
}

/**
 * そのシーズン・その大会の試合を、子テーブルごと削除する。
 *
 * 取り込みをやり直せるようにするためのもの。
 * 通常運用では使わない（試合は訂正で直す）。
 *
 * @param {string} seasonId
 * @param {string} stage
 * @returns {number} 消した試合数
 */
function _deleteMatchesOf(seasonId, stage) {
  var ids = [];
  getSheetData("Matches").forEach(function (m) {
    if (_str(m.season_id) !== seasonId) return;
    if (_str(m.stage) !== stage) return;
    ids.push(_str(m.match_id));
  });

  if (ids.length === 0) return 0;

  ids.forEach(function (id) { _deleteMatchChildren(id); });

  var sheet = getSheet("Matches");
  var values = sheet.getDataRange().getValues();
  var iId = values[0].indexOf("match_id");

  // 後ろから消す。前から消すと行がずれる
  for (var i = values.length - 1; i >= 1; i--) {
    if (ids.indexOf(String(values[i][iId])) !== -1) sheet.deleteRow(i + 1);
  }

  return ids.length;
}

// =============================================================================
// 予算の調整
// =============================================================================

/**
 * 予算を任意の理由で増減する。主催者専用。
 *
 * 前シーズンからの繰越を入れるために使う。
 * 残高を書き換えるのではなく、取引を1本足す（設計原則3）。
 * 履歴に残るので、後から「なぜこの額なのか」を追える。
 *
 * payload: { season_id, team_id, amount, reason?, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function adjustBudget(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  var amount = Math.round(_num(payload.amount));

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "team_id は必須です。" };
  if (!amount) return { ok: false, error: "金額を0以外で入力してください。" };

  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }
  if (!findRow("Teams", "team_id", teamId)) {
    return { ok: false, error: "チームが見つかりません。" };
  }

  var reason = _str(payload.reason).trim() || REASON_BUDGET_ADJUST;

  return withLock(function () {
    var at = now();
    _addBudgetTx(seasonId, teamId, amount, reason, _str(payload.note), at);

    return {
      ok: true,
      data: {
        season_id: seasonId,
        team_id:   teamId,
        amount:    amount,
        reason:    reason,
        balance:   _budgetBalance(seasonId, teamId),
      },
    };
  });
}

/**
 * そのシーズンのそのチームの残高。取引の合計で出す（設計原則3）。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number}
 */
function _budgetBalance(seasonId, teamId) {
  var sum = 0;
  getSheetData("BudgetTx").forEach(function (t) {
    if (_str(t.team_id) !== teamId) return;
    if (_str(t.season_id) !== seasonId) return;
    sum += _num(t.amount);
  });
  return sum;
}
