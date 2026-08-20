/**
 * api_public.gs — 認証不要の公開データ
 *
 *   getPublicData — 順位表・移籍動向・参加者一覧をまとめて返す
 *
 * 大会の宣伝と、参加を検討している人が中身を見られるようにするための入口。
 * ログインもコードも要らない代わりに、**読み取り専用**で、
 * 個人を特定できる情報（email）は一切返さない。
 *
 * ⚠️ 設計原則
 *   1. 書き込みはここには置かない。読み取りだけ
 *   5. 集計は status=承認 のデータのみ（既存の集計関数をそのまま使う）
 *
 * 公開してよいもの / いけないもの
 *   公開する: チーム名・オーナーの表示名・X ID・順位表・承認済み移籍・日程表・確定した監督
 *   公開しない: email・申請中や差戻の移籍・未承認の試合・監督の申告中
 */

// =============================================================================
// 内部専用トークン
// =============================================================================

/**
 * 認証を通さずに集計関数を呼ぶための合鍵。
 *
 * オブジェクトなので、JSON で送られてくる token（必ず文字列）とは
 * 決して === にならない。外部から詐称できない。
 */
var PUBLIC_ACCESS = {};

// =============================================================================
// 公開データ
// =============================================================================

/**
 * 公開ページ用のデータを返す。トークン不要。
 *
 * payload: { season_id? }  省略時は最新シーズン
 *
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getPublicData(payload) {
  payload = payload || {};

  var seasons = getSheetData("Seasons")
    .filter(function (s) { return _str(s.season_id); })
    .map(function (s) {
      return {
        season_id: _str(s.season_id),
        name:      _str(s.name),
        status:    _str(s.status),
      };
    });

  if (seasons.length === 0) {
    return {
      ok: true,
      data: {
        seasons: [], season_id: "", participants: _publicParticipants(),
        standings: null, transfers: [], signup_open: _isSignupOpen(),
      },
    };
  }

  var seasonId = _str(payload.season_id);
  var found = seasons.filter(function (s) { return s.season_id === seasonId; });
  if (!seasonId || found.length === 0) {
    // 既定は一番下の行（最新シーズン）
    seasonId = seasons[seasons.length - 1].season_id;
  }

  var season = seasons.filter(function (s) { return s.season_id === seasonId; })[0];

  return {
    ok: true,
    data: {
      seasons:      seasons,
      season_id:    seasonId,
      season_name:  season ? season.name : "",
      season_status: season ? season.status : "",
      participants: _publicParticipants(),
      standings:    _publicStandings(seasonId),
      transfers:    _publicTransfers(seasonId),
      schedule:     _publicSchedule(seasonId),
      managers:     _publicManagers(seasonId),
      signup_open:  _isSignupOpen(),
      generated_at: _iso(now()),
    },
  };
}

/**
 * 参加チームの一覧を返す。
 *
 * チーム名・オーナーの表示名・X ID のみ。email は含めない。
 *
 * @returns {Object[]}
 */
function _publicParticipants() {
  var users = {};
  getSheetData("Users").forEach(function (u) {
    users[_str(u.user_id)] = {
      display_name: _str(u.display_name),
      x_id:         _str(u.x_id),
      role:         _str(u.role),
    };
  });

  return getSheetData("Teams")
    .filter(function (t) { return _str(t.team_id); })
    .map(function (t) {
      var owner = users[_str(t.owner_user_id)] || null;
      return {
        team_id:    _str(t.team_id),
        team_name:  _str(t.name),
        kind:       _str(t.kind),
        active:     _toBool(t.active),
        owner_name: owner ? owner.display_name : "",
        owner_x_id: owner ? owner.x_id : "",
      };
    })
    .sort(function (a, b) {
      // 参加中を先に、その中は名前順
      if (a.active !== b.active) return a.active ? -1 : 1;
      return String(a.team_name).localeCompare(String(b.team_name), "ja");
    });
}

/**
 * 順位表を返す。二部制のシーズンは GM1 / GM2 の2本を返す。
 *
 * @param {string} seasonId
 * @returns {Object|null}
 */
function _publicStandings(seasonId) {
  var gm1 = getStandings(PUBLIC_ACCESS, { season_id: seasonId, division: DIVISION_GM1 });
  if (!gm1.ok) return null;

  var result = {
    two_division: gm1.data.two_division,
    format:       gm1.data.format,
    gm1:          { division: DIVISION_GM1, match_count: gm1.data.match_count, table: gm1.data.table },
    gm2:          null,
  };

  if (gm1.data.two_division) {
    var gm2 = getStandings(PUBLIC_ACCESS, { season_id: seasonId, division: DIVISION_GM2 });
    if (gm2.ok) {
      result.gm2 = { division: DIVISION_GM2, match_count: gm2.data.match_count, table: gm2.data.table };
    }
  }

  return result;
}

/**
 * 日程表を返す。予定の名前と日付だけで、個人情報は含まれない。
 *
 * @param {string} seasonId
 * @returns {Object|null}
 */
function _publicSchedule(seasonId) {
  var view = _buildScheduleView(seasonId);
  if (view.count === 0) return null;
  return view;
}

/**
 * 確定した使用監督を返す。
 *
 * **申告中は含めない。** 第一次は締切まで伏せて行うため、
 * 公開ページから漏れては意味がない。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _publicManagers(seasonId) {
  var teamNames = _teamNameMap();

  var names = {};
  try {
    getSheetData("Managers").forEach(function (m) {
      names[_str(m.manager_id)] = { name: _str(m.name), club: _str(m.club) };
    });
  } catch (e) {
    return [];
  }

  var out = [];
  try {
    getSheetData("ManagerPicks").forEach(function (p) {
      if (_str(p.season_id) !== seasonId) return;
      if (_str(p.status) !== MG_FIXED) return;

      var m = names[_str(p.manager_id)] || { name: _str(p.manager_id), club: "" };
      out.push({
        team_id:      _str(p.team_id),
        team_name:    teamNames[_str(p.team_id)] || _str(p.team_id),
        manager_name: m.name,
        club:         m.club,
      });
    });
  } catch (e) {
    return [];
  }

  out.sort(function (a, b) {
    return String(a.team_name).localeCompare(String(b.team_name), "ja");
  });

  return out;
}

/**
 * 承認済みの移籍を新しい順に返す。
 *
 * 申請中・差戻は含めない（設計原則5）。
 * オークションは売り手がいないため from が空になる。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _publicTransfers(seasonId) {
  var teamNames = _teamNameMap();

  var playerNames = {};
  getSheetData("Players").forEach(function (p) {
    playerNames[_str(p.player_id)] = { name: _str(p.name), position: _str(p.position) };
  });

  var rows = getSheetData("Transfers")
    .filter(function (t) {
      if (_str(t.season_id) !== seasonId) return false;
      return _str(t.status) === TX_APPROVED;
    })
    .map(function (t) {
      var p = playerNames[_str(t.player_id)] || { name: _str(t.player_id), position: "" };
      return {
        transfer_id: _str(t.transfer_id),
        window:      _str(t.window),
        player_name: p.name,
        position:    p.position,
        from_team:   _str(t.from_team),
        from_name:   teamNames[_str(t.from_team)] || "",
        to_team:     _str(t.to_team),
        to_name:     teamNames[_str(t.to_team)] || "",
        method:      _str(t.method),
        fee:         _num(t.cost_to_buyer),
        at:          _iso(t.registered_at),
      };
    });

  rows.sort(function (a, b) {
    return String(b.at).localeCompare(String(a.at));
  });

  return rows;
}
