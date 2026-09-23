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

  // 報告済みの試合を「節＋対戦の組み合わせ」で引けるようにする
  var reported = _reportedMatchMap(seasonId, stage);

  var rows = [];
  getSheetData("Fixtures").forEach(function (f) {
    if (_str(f.season_id) !== seasonId) return;
    if (_str(f.stage) !== stage) return;
    if (division && _str(f.division) !== division) return;

    var home = _str(f.home_team);
    var away = _str(f.away_team);
    var hit = reported[_fixtureKey(_str(f.round), home, away)];

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
      reported:       !!hit,
      match_status:   hit ? hit.status : "",
      score:          hit ? hit.score : "",
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
 * 総当たりの組み合わせを作る。
 *
 * ▶ 守ること
 *   - 同じ相手とは1巡に1回。2巡なら1回ずつホームとアウェイを入れ替える
 *   - **2巡目は1巡目と違う並びにする。** 節の順番を並べ替え、
 *     どの節も1巡目の同じ位置の節と重ならないようにする。
 *     1巡目の最終節と2巡目の第1節で同じ相手と連戦にもしない
 *   - **ホームは最大3節連続、アウェイは最大2節連続**
 *     （Config の fixture_max_home_streak / fixture_max_away_streak）。
 *     試合なし（bye）の節は数えずに詰めて判定する。休みを挟んでも
 *     続けてホームならホームが続いているとみなすほうが厳しく、安全なため
 *
 * ▶ 作り方
 *   1. チームの並びをシャッフルして円卓法で1巡分の組み合わせを作り、節の順番も混ぜる
 *   2. 2巡目の節の順番を、上の条件を満たすように並べ替える
 *   3. 各対戦のホームをランダムに決め、連続の上限を破っているチームがあれば
 *      その試合のホームとアウェイを入れ替えて、破れがなくなるまで詰める
 *      （1巡目で入れ替えると2巡目の同じ組み合わせも自動で入れ替わる）
 *   うまくいかなければ組み合わせから作り直す。毎回違う対戦表になる。
 *
 * 奇数チームのときは空席を1つ足す。空席と当たった節はそのチームが試合なし。
 *
 * @param {string[]} teams
 * @param {number} legs 1 なら1巡、2 なら2巡
 * @param {Function} [rng] 0以上1未満を返す乱数。テストで固定するため
 * @returns {Array<Array<{home: string, away: string}>>} 節ごとの対戦
 */
function _roundRobin(teams, legs, rng) {
  var rand = rng || Math.random;
  var maxHome = _fixtureStreakLimit("fixture_max_home_streak", 3);
  var maxAway = _fixtureStreakLimit("fixture_max_away_streak", 2);

  for (var attempt = 0; attempt < 300; attempt++) {
    var leg1 = _fxShuffle(_circleRounds(_fxShuffle(teams, rand)), rand);
    var order = _secondLegOrder(leg1, legs, rand);
    if (!order) continue;

    var result = _assignVenues(teams, leg1, order, maxHome, maxAway, rand);
    if (result) return result;
  }

  throw new Error("対戦表を作れませんでした。連続の上限を見直してください。");
}

/**
 * Config の連続上限を読む。キーが無ければ既定値。
 *
 * getConfigNum はキーが無いと0を返すので使わない。
 *
 * @param {string} key
 * @param {number} def
 * @returns {number}
 */
function _fixtureStreakLimit(key, def) {
  var raw = _str(getConfig(key, "")).trim();
  var n = Number(raw);
  if (raw === "" || isNaN(n) || n < 1) return def;
  return Math.floor(n);
}

/**
 * 円卓法で1巡分の組み合わせを作る。ホームはまだ決めない。
 *
 * @param {string[]} teams
 * @returns {Array<Array<string[]>>} 節ごとの [チームA, チームB]
 */
function _circleRounds(teams) {
  var list = teams.slice();
  if (list.length % 2 === 1) list.push("");

  var n = list.length;
  var rounds = [];

  for (var r = 0; r < n - 1; r++) {
    var pairs = [];
    for (var i = 0; i < n / 2; i++) {
      var a = list[i];
      var b = list[n - 1 - i];
      if (a && b) pairs.push([a, b]);
    }
    rounds.push(pairs);

    var fixed = list[0];
    var rest = list.slice(1);
    rest.unshift(rest.pop());
    list = [fixed].concat(rest);
  }

  return rounds;
}

/**
 * 全節の並び（1巡目の節番号の列）を返す。2巡なら2巡目の並びを後ろに足す。
 *
 * 2巡目はどの位置も1巡目と別の節にし、境目で同じ相手と連戦にしない。
 * 見つからなければ null。
 *
 * @param {Array<Array<string[]>>} leg1
 * @param {number} legs
 * @param {Function} rand
 * @returns {number[]|null}
 */
function _secondLegOrder(leg1, legs, rand) {
  var n = leg1.length;
  var base = [];
  for (var i = 0; i < n; i++) base.push(i);
  if (legs < 2) return base;
  if (n === 1) return base.concat(base);

  var lastKeys = {};
  leg1[n - 1].forEach(function (p) { lastKeys[_fxPairKey(p)] = true; });

  for (var k = 0; k < 500; k++) {
    var perm = _fxShuffle(base, rand);
    var same = false;
    for (var j = 0; j < n; j++) {
      if (perm[j] === j) { same = true; break; }
    }
    if (same) continue;

    var clash = leg1[perm[0]].some(function (p) { return lastKeys[_fxPairKey(p)]; });
    if (clash) continue;

    return base.concat(perm);
  }
  return null;
}

/**
 * ホームとアウェイを決める。連続の上限を守れなければ null。
 *
 * @param {string[]} teams
 * @param {Array<Array<string[]>>} leg1
 * @param {number[]} order 全節の並び（1巡目の節番号）
 * @param {number} maxHome
 * @param {number} maxAway
 * @param {Function} rand
 * @returns {Array<Array<{home: string, away: string}>>|null}
 */
function _assignVenues(teams, leg1, order, maxHome, maxAway, rand) {
  var n = leg1.length;

  // 1巡目の対戦に通し番号を振る。flip[m]=1 なら2つ目のチームが1巡目のホーム
  var matches = [];
  var idOf = [];
  leg1.forEach(function (pairs, r) {
    idOf[r] = [];
    pairs.forEach(function (p) {
      idOf[r].push(matches.length);
      matches.push(p);
    });
  });

  var flip = matches.map(function () { return rand() < 0.5 ? 1 : 0; });

  // チームごとに、出る試合を時系列で持つ
  var seqOf = {};
  teams.forEach(function (t) { seqOf[t] = []; });
  order.forEach(function (r, pos) {
    var second = pos >= n;
    idOf[r].forEach(function (m) {
      var p = matches[m];
      seqOf[p[0]].push({ m: m, side: 0, second: second });
      seqOf[p[1]].push({ m: m, side: 1, second: second });
    });
  });

  var isHome = function (e) {
    var homeSide = flip[e.m];
    if (e.second) homeSide = 1 - homeSide;
    return e.side === homeSide;
  };

  var excessOf = function (t) {
    var h = 0;
    var a = 0;
    var x = 0;
    seqOf[t].forEach(function (e) {
      if (isHome(e)) {
        h++; a = 0;
        if (h > maxHome) x++;
      } else {
        a++; h = 0;
        if (a > maxAway) x++;
      }
    });
    return x;
  };

  var total = function () {
    var s = 0;
    teams.forEach(function (t) { s += excessOf(t); });
    return s;
  };

  var score = total();
  for (var it = 0; it < 5000 && score > 0; it++) {
    var bad = teams.filter(function (t) { return excessOf(t) > 0; });
    var t = bad[Math.floor(rand() * bad.length)];
    var seq = seqOf[t];
    var e = seq[Math.floor(rand() * seq.length)];

    flip[e.m] = 1 - flip[e.m];
    var next = total();
    if (next <= score || rand() < 0.05) score = next;
    else flip[e.m] = 1 - flip[e.m];
  }

  if (score > 0) return null;

  return order.map(function (r, pos) {
    var second = pos >= n;
    return idOf[r].map(function (m) {
      var p = matches[m];
      var homeSide = second ? 1 - flip[m] : flip[m];
      return { home: p[homeSide], away: p[1 - homeSide] };
    });
  });
}

/**
 * 組み合わせの向きを問わない鍵。
 *
 * @param {string[]} p
 * @returns {string}
 */
function _fxPairKey(p) {
  return p[0] < p[1] ? p[0] + "|" + p[1] : p[1] + "|" + p[0];
}

/**
 * 配列をシャッフルした複製を返す。
 *
 * @param {Array} list
 * @param {Function} rand
 * @returns {Array}
 */
function _fxShuffle(list, rand) {
  var a = list.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
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
 * 節と対戦の組み合わせからキーを作る。ホームとアウェイの順番は問わない。
 *
 * 対戦表では「ホーム 対 アウェイ」でも、報告は逆で出されることがある。
 * 順番で別物として扱うと、報告済みなのに未報告に見える。
 *
 * @param {string} round
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function _fixtureKey(round, a, b) {
  return round + "|" + (a < b ? a + "|" + b : b + "|" + a);
}

/**
 * 報告済みの試合を「節＋対戦」で引ける形にする。
 *
 * 差戻は含めない。差し戻された試合は出し直す必要があるので、
 * 報告済みとして節の選択肢から消すと再報告できなくなる。
 *
 * @param {string} seasonId
 * @param {string} stage
 * @returns {Object} key → { status, score }
 */
function _reportedMatchMap(seasonId, stage) {
  var map = {};

  getSheetData("Matches").forEach(function (m) {
    if (_str(m.season_id) !== seasonId) return;
    if (_str(m.stage) !== stage) return;

    var status = _str(m.status);
    if (status === MATCH_REJECTED) return;

    var key = _fixtureKey(_str(m.round), _str(m.home_team), _str(m.away_team));
    map[key] = {
      status: status,
      score:  _num(m.home_score) + " - " + _num(m.away_score),
    };
  });

  return map;
}

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
