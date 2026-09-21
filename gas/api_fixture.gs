/**
 * api_fixture.gs — 対戦表（誰と誰がいつ当たるか）
 *
 * 主催者向け:
 *   generateFixtures — 総当たりで自動生成（上書き可）
 *   upsertFixture    — 1件の追加・修正
 *   swapFixtureSides — ホームとアウェイを入れ替える
 *   deleteFixture    — 1件削除
 *
 * 全ロール:
 *   getFixtures — 対戦表の取得
 *
 * ▶ なぜ Matches と分けるのか
 *   Matches は「実際に行われた試合」で、申請されて初めて行ができる（SPEC.md §7.5）。
 *   こちらは**予定**で、開幕前に全節ぶんが並ぶ。
 *
 *   1つの表にまとめて status で分けると、未実施の行が順位表に混ざる事故が起きる。
 *   順位表は status=承認 の Matches だけを見る作りなので（設計原則5）、
 *   予定はそもそも別の場所に置いて、集計の経路に入れない。
 *
 * ⚠️ 対戦表は集計に一切使わない。
 *   試合結果の報告画面で「節を選んだら相手が入る」ための下敷きにすぎない。
 *   対戦表と違う相手と対戦しても、報告そのものは通る。
 */

// =============================================================================
// 読み取り
// =============================================================================

/**
 * 対戦表を返す。
 *
 * payload: { season_id?, stage?, division? }
 *   season_id 省略時は進行中のシーズン
 *   stage     省略時はリーグ戦
 *   division  省略時は全ディビジョン
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getFixtures(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id) || _latestSeasonId();
  if (!seasonId) return { ok: false, error: "シーズンが見つかりません。" };

  var stage = _str(payload.stage) || STAGE_LEAGUE;
  var division = _str(payload.division);

  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  var rows = [];
  getSheetData("Fixtures").forEach(function (f) {
    if (_str(f.season_id) !== seasonId) return;
    if (_str(f.stage) !== stage) return;
    if (division && _str(f.division) !== division) return;

    var home = _str(f.home_team);
    var away = _str(f.away_team);

    rows.push({
      fixture_id:     _str(f.fixture_id),
      division:       _str(f.division),
      round:          _str(f.round),
      sort_order:     _num(f.sort_order),
      home_team:      home,
      home_team_name: teamNames[home] || home,
      away_team:      away,
      away_team_name: teamNames[away] || away,
      note:           _str(f.note),
    });
  });

  rows.sort(function (a, b) {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    if (a.division !== b.division) return a.division < b.division ? -1 : 1;
    return a.home_team_name < b.home_team_name ? -1 : 1;
  });

  // 節の一覧。画面のプルダウンはこれをそのまま使う
  var rounds = [];
  var seen = {};
  rows.forEach(function (r) {
    if (seen[r.round]) return;
    seen[r.round] = true;
    rounds.push({ round: r.round, sort_order: r.sort_order });
  });

  return {
    ok: true,
    data: {
      season_id: seasonId,
      stage:     stage,
      my_team:   _str(auth.data.team_id),
      rounds:    rounds,
      fixtures:  rows,
    },
  };
}

// =============================================================================
// 生成
// =============================================================================

/**
 * 総当たりの対戦表を作る。主催者専用。
 *
 * ディビジョンごとに別々に組む。二部制なら GM1 と GM2 で
 * それぞれ総当たりになり、ディビジョンをまたぐ対戦は作らない。
 *
 * 作ったあとは upsertFixture / swapFixtureSides で自由に直せる。
 * 自動生成はあくまで叩き台で、確定は主催者が行う。
 *
 * payload: { season_id, stage?, legs?, replace? }
 *   legs 省略時はシーズンの leg_enabled に従う（true なら2巡）
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function generateFixtures(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var stage = _str(payload.stage) || STAGE_LEAGUE;
  if (MATCH_STAGES.indexOf(stage) === -1) {
    return { ok: false, error: "stage が不正です: " + stage };
  }

  var legs = payload.legs === undefined
    ? (_toBool(season.leg_enabled) ? 2 : 1)
    : Math.max(1, Math.min(2, Math.floor(_num(payload.legs))));

  // 参加チームはシーズン名簿から取る。名簿が無ければ今 active なチーム
  var d = _divisionsOf(seasonId);
  var roster = d.roster.slice();

  if (roster.length === 0) {
    getSheetData("Teams").forEach(function (t) {
      if (_toBool(t.active)) roster.push(_str(t.team_id));
    });
  }

  if (roster.length < 2) {
    return { ok: false, error: "参加チームが2つ以上必要です。先に参加チームを登録してください。" };
  }

  // ディビジョンごとに分ける
  var byDivision = {};
  roster.forEach(function (tid) {
    var div = d.twoDivision ? _divisionOf(d.map, tid) : "";
    if (!byDivision[div]) byDivision[div] = [];
    byDivision[div].push(tid);
  });

  var divisions = Object.keys(byDivision);
  for (var i = 0; i < divisions.length; i++) {
    if (byDivision[divisions[i]].length < 2) {
      return {
        ok: false,
        error: (divisions[i] || "リーグ") + " のチームが1つしかありません。割り当てを見直してください。",
      };
    }
  }

  return withLock(function () {
    var existing = _fixtureRows(seasonId, stage);

    if (existing.length > 0 && !_toBool(payload.replace)) {
      return {
        ok: false,
        error: "この大会には既に " + existing.length +
          " 件の対戦が登録されています。作り直す場合は上書きを選んでください。",
      };
    }

    if (existing.length > 0) _deleteFixtureRows(seasonId, stage);

    var rows = [];
    var maxRounds = 0;

    divisions.forEach(function (div) {
      var schedule = _roundRobin(byDivision[div], legs);
      if (schedule.length > maxRounds) maxRounds = schedule.length;

      schedule.forEach(function (pairs, idx) {
        var no = idx + 1;
        pairs.forEach(function (p) {
          rows.push({
            fixture_id: generateId("fx_"),
            season_id:  seasonId,
            stage:      stage,
            division:   div,
            round:      "第" + no + "節",
            sort_order: no,
            home_team:  p.home,
            away_team:  p.away,
            note:       "",
          });
        });
      });
    });

    _appendRowsBatch("Fixtures", rows);

    return {
      ok: true,
      data: {
        season_id:  seasonId,
        stage:      stage,
        legs:       legs,
        divisions:  divisions.length,
        rounds:     maxRounds,
        added:      rows.length,
        removed:    existing.length,
      },
    };
  });
}

/**
 * 総当たりの組み合わせを作る（円卓法）。
 *
 * 奇数チームのときは空席を1つ足す。空席と当たった節は
 * そのチームが試合なし（bye）になる。7チームなら1巡7節で、
 * 毎節どこか1チームが休む。
 *
 * ホームとアウェイは節ごとに入れ替えて、どちらかに寄らないようにする。
 *
 * @param {string[]} teams
 * @param {number} legs 1 なら1巡、2 ならホームアウェイを入れ替えて2巡
 * @returns {Array<Array<{home: string, away: string}>>} 節ごとの対戦
 */
function _roundRobin(teams, legs) {
  var list = teams.slice();
  if (list.length % 2 === 1) list.push("");

  var n = list.length;
  var first = [];

  for (var r = 0; r < n - 1; r++) {
    var pairs = [];

    for (var i = 0; i < n / 2; i++) {
      var a = list[i];
      var b = list[n - 1 - i];
      if (!a || !b) continue;

      // 交互に入れ替える。全部 a をホームにすると先頭のチームが
      // ホームばかりになる
      if ((r + i) % 2 === 1) pairs.push({ home: b, away: a });
      else pairs.push({ home: a, away: b });
    }

    first.push(pairs);

    // 先頭を固定し、残りを1つずつ回す
    var fixed = list[0];
    var rest = list.slice(1);
    rest.unshift(rest.pop());
    list = [fixed].concat(rest);
  }

  if (legs < 2) return first;

  // 2巡目はホームとアウェイを入れ替える
  var second = first.map(function (pairs) {
    return pairs.map(function (p) {
      return { home: p.away, away: p.home };
    });
  });

  return first.concat(second);
}

// =============================================================================
// 編集
// =============================================================================

/**
 * 対戦を1件追加・修正する。主催者専用。
 *
 * fixture_id を渡せば修正、渡さなければ追加。
 *
 * payload: { fixture_id?, season_id, stage?, division?, round, sort_order?,
 *            home_team, away_team, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertFixture(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var round = _str(payload.round).trim();
  var home = _str(payload.home_team);
  var away = _str(payload.away_team);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!round) return { ok: false, error: "節を入力してください。" };
  if (!home || !away) return { ok: false, error: "対戦チームを選んでください。" };
  if (home === away) return { ok: false, error: "同じチーム同士の対戦は組めません。" };

  if (!findRow("Teams", "team_id", home)) return { ok: false, error: "ホームチームが見つかりません。" };
  if (!findRow("Teams", "team_id", away)) return { ok: false, error: "アウェイチームが見つかりません。" };

  var stage = _str(payload.stage) || STAGE_LEAGUE;
  if (MATCH_STAGES.indexOf(stage) === -1) {
    return { ok: false, error: "stage が不正です: " + stage };
  }

  var fixtureId = _str(payload.fixture_id);

  return withLock(function () {
    // 同じ節に同じチームが2回出てこないか。
    // 出てくると「節を選んだら相手が入る」が成立しなくなる
    var clash = null;
    _fixtureRows(seasonId, stage).forEach(function (f) {
      if (clash) return;
      if (_str(f.fixture_id) === fixtureId) return;
      if (_str(f.round) !== round) return;

      var h = _str(f.home_team);
      var a = _str(f.away_team);
      if (h === home || h === away || a === home || a === away) clash = f;
    });

    if (clash) {
      return {
        ok: false,
        error: "同じ節に既に登録されているチームがあります。1チームは1節に1試合までです。",
      };
    }

    var updates = {
      season_id:  seasonId,
      stage:      stage,
      division:   _str(payload.division),
      round:      round,
      sort_order: payload.sort_order === undefined
        ? _roundNumberOf(round)
        : Math.round(_num(payload.sort_order)),
      home_team:  home,
      away_team:  away,
      note:       _str(payload.note),
    };

    if (fixtureId && findRow("Fixtures", "fixture_id", fixtureId)) {
      updateRow("Fixtures", "fixture_id", fixtureId, updates);
      return { ok: true, data: { fixture_id: fixtureId, created: false } };
    }

    fixtureId = generateId("fx_");
    updates.fixture_id = fixtureId;
    appendRow("Fixtures", updates);

    return { ok: true, data: { fixture_id: fixtureId, created: true } };
  });
}

/**
 * ホームとアウェイを入れ替える。主催者専用。
 *
 * 自動生成の割り振りを1クリックで直せるようにするためのもの。
 *
 * payload: { fixture_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function swapFixtureSides(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var fixtureId = _str(payload.fixture_id);
  if (!fixtureId) return { ok: false, error: "fixture_id は必須です。" };

  return withLock(function () {
    var f = findRow("Fixtures", "fixture_id", fixtureId);
    if (!f) return { ok: false, error: "対戦が見つかりません。" };

    updateRow("Fixtures", "fixture_id", fixtureId, {
      home_team: _str(f.away_team),
      away_team: _str(f.home_team),
    });

    return {
      ok: true,
      data: {
        fixture_id: fixtureId,
        home_team:  _str(f.away_team),
        away_team:  _str(f.home_team),
      },
    };
  });
}

/**
 * 対戦を1件削除する。主催者専用。
 *
 * payload: { fixture_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function deleteFixture(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var fixtureId = _str(payload.fixture_id);
  if (!fixtureId) return { ok: false, error: "fixture_id は必須です。" };

  return withLock(function () {
    var sheet = getSheet("Fixtures");
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return { ok: false, error: "対戦が見つかりません。" };

    var iId = values[0].indexOf("fixture_id");

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iId]) !== fixtureId) continue;
      sheet.deleteRow(i + 1);
      return { ok: true, data: { fixture_id: fixtureId } };
    }

    return { ok: false, error: "対戦が見つかりません。" };
  });
}

// =============================================================================
// ヘルパ
// =============================================================================

/**
 * 指定シーズン・大会の対戦を返す。
 *
 * @param {string} seasonId
 * @param {string} stage
 * @returns {Object[]}
 */
function _fixtureRows(seasonId, stage) {
  return getSheetData("Fixtures").filter(function (f) {
    return _str(f.season_id) === seasonId && _str(f.stage) === stage;
  });
}

/**
 * 指定シーズン・大会の対戦をすべて消す。
 *
 * @param {string} seasonId
 * @param {string} stage
 * @returns {number} 消した件数
 */
function _deleteFixtureRows(seasonId, stage) {
  var sheet = getSheet("Fixtures");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iStage = headers.indexOf("stage");

  var count = 0;

  // 後ろから消す。前から消すと行がずれる
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][iSeason]) !== seasonId) continue;
    if (String(values[i][iStage]) !== stage) continue;
    sheet.deleteRow(i + 1);
    count++;
  }

  return count;
}

/**
 * "第12節" から 12 を取り出す。数字が無ければ 999。
 *
 * 並び順に使う。文字列のまま並べると "第10節" が "第2節" より前に来る。
 *
 * @param {string} round
 * @returns {number}
 */
function _roundNumberOf(round) {
  var m = _str(round).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}
