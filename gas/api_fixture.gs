/**
 * api_fixture.gs — 対戦表（誰と誰がいつ当たるか）
 *
 * 主催者向け:
 *   generateFixtures — 総当たりで自動生成（上書き可）。GMリーグ杯はトーナメント表を作る
 *   generateCupBracket / swapCupTeams — GMリーグ杯のトーナメント表と抽選の手直し
 *   upsertFixture    — 1件の追加・修正
 *   swapFixtureSides — ホームとアウェイを入れ替える
 *   deleteFixture    — 1件削除
 *
 * 全ロール:
 *   getFixtures   — 対戦表の取得（GMリーグ杯はトーナメント表のレグ、スーパーカップは保存したカード）
 *   getCupBracket — GMリーグ杯のトーナメント表
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

  // GMリーグ杯はトーナメント表から、スーパーカップは保存したカードから作る。
  // 報告画面は「自分の出る試合」をここから選ぶので、出場しないチームには何も出ない
  if (stage === STAGE_TOURNAMENT) {
    var cup = _cupFixtures(seasonId);
    if (cup) return { ok: true, data: Object.assign({ season_id: seasonId, stage: stage, my_team: _str(auth.data.team_id) }, cup) };
  }
  if (stage === STAGE_SUPERCUP) {
    return { ok: true, data: Object.assign({ season_id: seasonId, stage: stage, my_team: _str(auth.data.team_id) }, _superCupFixtures(seasonId)) };
  }

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

  // GMリーグ杯は総当たりではなくトーナメント。以前はここで総当たりを作ってしまい、
  // リーグ戦の対戦表として出ていた
  if (stage === STAGE_TOURNAMENT) return generateCupBracket(token, payload);
  if (stage === STAGE_SUPERCUP) {
    return { ok: false, error: "GMスーパーカップの対戦カードは「GMスーパーカップ」の欄で保存してください。" };
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

    // GMリーグ杯は2レグを1組で入れ替える。片方だけ入れ替えると両レグとも同じホームになる
    if (_str(f.stage) === STAGE_TOURNAMENT && _str(f.tie_id)) {
      if (_cupHasReports(_str(f.season_id))) {
        return { ok: false, error: "GMリーグ杯の試合結果が既に報告されているため、組み合わせは動かせません。" };
      }
      if (!_str(f.away_team)) return { ok: false, error: "シードの枠は入れ替えられません。" };
      _fixtureRows(_str(f.season_id), STAGE_TOURNAMENT).forEach(function (x) {
        if (_str(x.tie_id) !== _str(f.tie_id)) return;
        updateRow("Fixtures", "fixture_id", _str(x.fixture_id), {
          home_team: _str(x.away_team),
          away_team: _str(x.home_team),
        });
      });
      return { ok: true, data: { fixture_id: fixtureId, tie_id: _str(f.tie_id) } };
    }

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

// =============================================================================
// GMリーグ杯（トーナメント表）
// =============================================================================
//
// ▶ 何を保存するか
//   Fixtures には**1回戦だけ**を置く。2回戦以降は、1回戦の並びと承認済みの
//   試合結果から毎回組み立てる（_cupBracket）。勝ち上がりを別に保存すると、
//   結果を訂正したときに次のラウンドとの食い違いが残るため（設計原則5と同じ考え）。
//
//   1回戦の1タイ = 2レグなら2行（tie_id 共通・leg 1 / 2）、1試合なら1行（leg 空）。
//   シード（1回戦免除）は相手なしの1行（away_team 空）。
//
// ▶ 組み合わせ
//   シードは前シーズンの GMリーグ杯の成績順（優勝 → 準優勝 → ベスト4 …）。残りは抽選。主催者は
//   swapCupTeams で2チームの位置を入れ替え、swapFixtureSides でH/Aを入れ替えて手直しする。
//   決勝だけ1試合（Config cup_final_legs、既定1）。それ以外のラウンドは
//   シーズンの leg_enabled が true なら2レグ。

/** シードの行の備考 */
var CUP_BYE_NOTE = "シード（1回戦免除）";

/** スーパーカップの試合の節名。1試合しかないので固定する */
var SUPERCUP_ROUND = "GMスーパーカップ";

/**
 * ラウンド名。決勝から数えて名付ける。
 *
 * @param {number} r     1始まりのラウンド番号
 * @param {number} total ラウンド数
 * @returns {string}
 */
function _cupRoundName(r, total) {
  var fromFinal = total - r;
  if (fromFinal === 0) return "決勝";
  if (fromFinal === 1) return "準決勝";
  if (fromFinal === 2) return "準々決勝";
  return r + "回戦";
}

/**
 * そのラウンドのレグ数。決勝は cup_final_legs、それ以外は leg_enabled で決まる。
 *
 * @param {Object} season
 * @param {number} r
 * @param {number} total
 * @returns {number} 1 または 2
 */
function _cupLegsOf(season, r, total) {
  if (r === total) return Math.min(2, Math.max(1, Math.floor(getConfigNumOr("cup_final_legs", 1))));
  return season && _toBool(season.leg_enabled) ? 2 : 1;
}

/** 2レグなら [1st, 2nd]、1試合なら [""] */
function _cupLegKeys(legs) {
  return legs === 2 ? ["1", "2"] : [""];
}

function _pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

/**
 * トーナメント表を組み立てる。1回戦が無ければ null。
 *
 * 承認済みの試合だけで勝ち上がりを決める（設計原則5）。
 * 申請中の試合は reported として印だけ付け、報告画面で同じレグを選べないようにする。
 *
 * @param {string} seasonId
 * @returns {Object|null}
 */
function _cupBracket(seasonId) {
  // 終了処理の賞金計算などからも呼ばれる。Fixtures が無い環境でも止めない
  var rows;
  try {
    rows = _fixtureRows(seasonId, STAGE_TOURNAMENT).filter(function (f) {
      return _str(f.tie_id) !== "";
    });
  } catch (e) {
    return null;
  }
  if (rows.length === 0) return null;

  var season = findRow("Seasons", "season_id", seasonId);
  var names = _teamNameMap();

  // 試合結果を「tie_id|leg」で引けるようにする
  var approved = {};
  var reported = {};
  getSheetData("Matches").forEach(function (m) {
    if (_str(m.season_id) !== seasonId) return;
    if (_str(m.stage) !== STAGE_TOURNAMENT) return;
    var status = _str(m.status);
    if (status === MATCH_REJECTED) return;
    var key = _str(m.tie_id) + "|" + _normalizeLeg(m.leg);
    reported[key] = m;
    if (status === MATCH_APPROVED) approved[key] = m;
  });

  // 1回戦
  var byId = {};
  var first = [];
  rows.forEach(function (f) {
    var id = _str(f.tie_id);
    if (!byId[id]) {
      byId[id] = { tie_id: id, slot: _num(f.sort_order), round: _str(f.round), rows: [] };
      first.push(byId[id]);
    }
    byId[id].rows.push(f);
  });
  first.sort(function (a, b) { return a.slot - b.slot; });

  var size = 2;
  while (size < first.length * 2) size *= 2;
  var total = Math.round(Math.log(size) / Math.log(2));

  var rounds = [];

  var r1 = first.map(function (t, i) {
    t.rows.sort(function (a, b) { return _normalizeLeg(a.leg) < _normalizeLeg(b.leg) ? -1 : 1; });
    var lead = t.rows[0];
    var bye = !_str(lead.away_team);
    return _cupTie({
      tie_id: t.tie_id, round_no: 1, round: t.round || _cupRoundName(1, total), slot: i + 1,
      team_a: _str(lead.home_team), team_b: bye ? "" : _str(lead.away_team), bye: bye,
      legs: bye ? [] : t.rows.map(function (f) {
        return {
          leg: _normalizeLeg(f.leg), home: _str(f.home_team), away: _str(f.away_team),
          fixture_id: _str(f.fixture_id),
        };
      }),
    }, approved, reported, names);
  });
  rounds.push({ round_no: 1, round: r1.length ? r1[0].round : _cupRoundName(1, total), ties: r1 });

  var prev = r1;
  for (var r = 2; r <= total; r++) {
    var legs = _cupLegsOf(season, r, total);
    var list = [];
    for (var k = 0; k < prev.length / 2; k++) {
      var a = prev[2 * k].winner;
      var b = prev[2 * k + 1].winner;
      var tieId = "R" + r + "-" + _pad2(k + 1);
      list.push(_cupTie({
        tie_id: tieId, round_no: r, round: _cupRoundName(r, total), slot: k + 1,
        team_a: a, team_b: b, bye: false,
        from: [prev[2 * k].tie_id, prev[2 * k + 1].tie_id],
        legs: _cupLegKeys(legs).map(function (leg) {
          // 1stレグ（または1試合）は上の山の勝者がホーム
          var home = leg === "2" ? b : a;
          var away = leg === "2" ? a : b;
          return { leg: leg, home: home, away: away, fixture_id: "" };
        }),
      }, approved, reported, names));
    }
    rounds.push({ round_no: r, round: _cupRoundName(r, total), ties: list });
    prev = list;
  }

  var final = prev.length === 1 ? prev[0] : null;

  return {
    season_id:     seasonId,
    size:          size,
    total_rounds:  total,
    rounds:        rounds,
    champion:      final && final.winner ? final.winner : "",
    champion_name: final && final.winner ? (names[final.winner] || final.winner) : "",
  };
}

/**
 * 1つのタイの結果を出す。2レグなら合計スコア、並んだら最後のレグのPK。
 *
 * @param {Object} t
 * @param {Object} approved tie_id|leg → 承認済みの試合
 * @param {Object} reported tie_id|leg → 差戻以外の試合
 * @param {Object} names
 * @returns {Object}
 */
function _cupTie(t, approved, reported, names) {
  var ready = !!(t.team_a && t.team_b);
  var aggA = 0;
  var aggB = 0;
  var pkA = null;
  var pkB = null;
  var done = 0;

  var legs = t.legs.map(function (l) {
    var key = t.tie_id + "|" + l.leg;
    var m = ready ? approved[key] : null;
    var rep = ready ? reported[key] : null;
    var out = {
      leg:         l.leg,
      fixture_id:  l.fixture_id || "",
      home:        l.home,
      home_name:   l.home ? (names[l.home] || l.home) : "",
      away:        l.away,
      away_name:   l.away ? (names[l.away] || l.away) : "",
      home_score:  null,
      away_score:  null,
      home_pk:     null,
      away_pk:     null,
      approved:    !!m,
      reported:    !!rep,
      match_status: rep ? _str(rep.status) : "",
      match_id:    rep ? _str(rep.match_id) : "",
    };
    if (!m) return out;

    // 表示は実際の試合のホーム・アウェイで出す（対戦表と逆で報告されても合うように）
    var mh = _str(m.home_team);
    out.home = mh;
    out.home_name = names[mh] || mh;
    out.away = _str(m.away_team);
    out.away_name = names[out.away] || out.away;
    out.home_score = _num(m.home_score);
    out.away_score = _num(m.away_score);
    out.home_pk = _str(m.home_pk) === "" ? null : _num(m.home_pk);
    out.away_pk = _str(m.away_pk) === "" ? null : _num(m.away_pk);

    if (mh === t.team_a) { aggA += out.home_score; aggB += out.away_score; }
    else { aggA += out.away_score; aggB += out.home_score; }

    if (out.home_pk !== null && out.away_pk !== null) {
      if (mh === t.team_a) { pkA = out.home_pk; pkB = out.away_pk; }
      else { pkA = out.away_pk; pkB = out.home_pk; }
    }
    done++;
    return out;
  });

  var winner = "";
  var decidedBy = "";
  if (t.bye) {
    winner = t.team_a;
    decidedBy = "シード";
  } else if (ready && legs.length > 0 && done === legs.length) {
    if (aggA > aggB) { winner = t.team_a; decidedBy = "合計スコア"; }
    else if (aggB > aggA) { winner = t.team_b; decidedBy = "合計スコア"; }
    else if (pkA !== null && pkB !== null && pkA !== pkB) {
      winner = pkA > pkB ? t.team_a : t.team_b;
      decidedBy = "PK戦";
    } else {
      decidedBy = "未決着";
    }
  }

  return {
    tie_id:      t.tie_id,
    round_no:    t.round_no,
    round:       t.round,
    slot:        t.slot,
    from:        t.from || [],
    bye:         !!t.bye,
    team_a:      t.team_a || "",
    team_a_name: t.team_a ? (names[t.team_a] || t.team_a) : "",
    team_b:      t.team_b || "",
    team_b_name: t.team_b ? (names[t.team_b] || t.team_b) : "",
    leg_count:   legs.length,
    legs:        legs,
    played:      done,
    agg_a:       done > 0 ? aggA : null,
    agg_b:       done > 0 ? aggB : null,
    pk_a:        pkA,
    pk_b:        pkB,
    winner:      winner,
    winner_name: winner ? (names[winner] || winner) : "",
    decided_by:  decidedBy,
  };
}

/**
 * トーナメント表を返す。全ロール。
 *
 * payload: { season_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getCupBracket(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id) || _latestSeasonId();
  if (!seasonId) return { ok: false, error: "シーズンが見つかりません。" };

  var b = _cupBracket(seasonId);
  return {
    ok: true,
    data: b ? Object.assign({ exists: true, my_team: _str(auth.data.team_id) }, b)
            : { exists: false, season_id: seasonId, my_team: _str(auth.data.team_id), rounds: [] },
  };
}

/**
 * 前シーズンの GMリーグ杯の成績順にチームを並べる。シードの既定に使う。
 *
 * 優勝 → 準優勝 → 準決勝の敗者 → その前のラウンドの敗者 … の順。
 * 同じラウンドで敗れたチームどうしは、トーナメント表の並び（山の上から）で並べる。
 * リーグ戦の順位は使わない（シードは杯の成績で決めるのが大会の定義）。
 *
 * @param {string} prevSeasonId
 * @returns {string[]} team_id の並び。杯の記録が無ければ空
 */
function _cupFinishOrder(prevSeasonId) {
  var tr = getTournament(PUBLIC_ACCESS, { season_id: prevSeasonId, stage: STAGE_TOURNAMENT });
  if (!tr.ok || tr.data.ties.length === 0) return [];

  var ties = tr.data.ties;
  var final = ties[ties.length - 1];
  if (!final.winner) return [];

  var order = [];
  var add = function (t) { if (t && order.indexOf(t) === -1) order.push(t); };
  var loserOf = function (t) { return t.winner === t.team_a ? t.team_b : t.team_a; };

  add(final.winner);
  add(loserOf(final));

  // 決勝の前のラウンドから順にさかのぼる
  var rounds = [];
  ties.forEach(function (t) { if (rounds.indexOf(t.round) === -1) rounds.push(t.round); });
  for (var i = rounds.length - 2; i >= 0; i--) {
    ties.forEach(function (t) {
      if (t.round !== rounds[i] || !t.winner) return;
      add(loserOf(t));
    });
  }

  return order;
}

/**
 * GMリーグ杯のトーナメント表（1回戦）を作る。主催者専用。
 *
 * payload: { season_id, seeds?: string[], replace? }
 *   seeds — 1回戦免除にするチーム。上から順にシード1, 2…。
 *           省略時は前シーズンの GMリーグ杯の成績順（_cupFinishOrder）で自動で選ぶ
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function generateCupBracket(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  // 出場はシーズン名簿の全チーム（GM1・GM2 合同）。名簿が無ければ今 active なチーム
  var teams = _divisionsOf(seasonId).roster.slice();
  if (teams.length === 0) {
    getSheetData("Teams").forEach(function (t) {
      if (_toBool(t.active)) teams.push(_str(t.team_id));
    });
  }
  if (teams.length < 2) return { ok: false, error: "出場チームが2つ以上必要です。" };

  var size = 2;
  while (size < teams.length) size *= 2;
  var byes = size - teams.length;
  var tieCount = size / 2;
  var total = Math.round(Math.log(size) / Math.log(2));

  // シード
  var seeds = [];
  if (byes > 0) {
    var given = (payload.seeds || []).map(_str).filter(function (x) { return x; });
    if (given.length > 0) {
      if (given.length !== byes) {
        return { ok: false, error: "シード（1回戦免除）は " + byes + " チーム選んでください（今 " + given.length + " チーム）。" };
      }
      for (var g = 0; g < given.length; g++) {
        if (teams.indexOf(given[g]) === -1) return { ok: false, error: "シードに出場していないチームが含まれています。" };
        if (given.indexOf(given[g]) !== g) return { ok: false, error: "シードに同じチームが2回入っています。" };
      }
      seeds = given;
    } else {
      var prev = _pastSeasons(seasonId)[0];
      var ranked = (prev ? _cupFinishOrder(prev.season_id) : []).filter(function (t) {
        return teams.indexOf(t) !== -1;
      });
      if (ranked.length < byes) {
        return {
          ok: false,
          error: (prev ? "前シーズン（" + prev.name + "）の GMリーグ杯の成績がツールにそろっていない" : "前シーズンがツールに無い") +
            "ため、シードを自動で決められません。1回戦免除にする " + byes + " チームを選んでください" +
            "（前シーズンの GMリーグ杯の優勝 → 準優勝 → ベスト4 の順）。",
        };
      }
      seeds = ranked.slice(0, byes);
    }
  }

  var rand = typeof payload.rng === "function" ? payload.rng : Math.random;

  return withLock(function () {
    var headerErr = _fixtureHeaderError();
    if (headerErr) return { ok: false, error: headerErr };

    var existing = _fixtureRows(seasonId, STAGE_TOURNAMENT);
    if (existing.length > 0 && !_toBool(payload.replace)) {
      return {
        ok: false,
        error: "GMリーグ杯の対戦表が既に " + existing.length + " 件あります。作り直す場合は上書きを選んでください。",
      };
    }
    if (_cupHasReports(seasonId)) {
      return { ok: false, error: "GMリーグ杯の試合結果が既に報告されているため、作り直せません。" };
    }
    if (existing.length > 0) _deleteFixtureRows(seasonId, STAGE_TOURNAMENT);

    // シードの位置は山の上下に散らす（シード1とシード2は決勝まで当たらない）
    var byeSlots = {};
    for (var i = 0; i < byes; i++) byeSlots[Math.floor(i * tieCount / byes)] = seeds[i];

    var rest = _fxShuffle(teams.filter(function (t) { return seeds.indexOf(t) === -1; }), rand);
    var legs = _cupLegsOf(season, 1, total);
    var roundName = _cupRoundName(1, total);
    var rows = [];

    for (var s = 0; s < tieCount; s++) {
      var tieId = "R1-" + _pad2(s + 1);
      var base = { season_id: seasonId, stage: STAGE_TOURNAMENT, division: "", round: roundName, sort_order: s + 1 };

      if (byeSlots.hasOwnProperty(s)) {
        rows.push(Object.assign({ fixture_id: generateId("fx_"), tie_id: tieId, leg: "",
          home_team: byeSlots[s], away_team: "", note: CUP_BYE_NOTE }, base));
        continue;
      }

      var a = rest.shift();
      var b = rest.shift();
      _cupLegKeys(legs).forEach(function (leg) {
        rows.push(Object.assign({ fixture_id: generateId("fx_"), tie_id: tieId, leg: leg,
          home_team: leg === "2" ? b : a, away_team: leg === "2" ? a : b, note: "" }, base));
      });
    }

    _appendRowsBatch("Fixtures", rows);

    return {
      ok: true,
      data: {
        season_id: seasonId,
        teams:     teams.length,
        size:      size,
        byes:      byes,
        seeds:     seeds,
        rounds:    total,
        first_round_legs: legs,
        added:     rows.length,
        removed:   existing.length,
      },
    };
  });
}

/**
 * 1回戦で2チームの位置を入れ替える。主催者専用。抽選の手直しに使う。
 *
 * シードのチームと入れ替えれば、シードもそのチームに移る。
 * 試合が1件でも報告されたら動かせない（勝ち上がりが崩れるため）。
 *
 * payload: { season_id, team_a, team_b }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function swapCupTeams(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var a = _str(payload.team_a);
  var b = _str(payload.team_b);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!a || !b) return { ok: false, error: "入れ替える2チームを選んでください。" };
  if (a === b) return { ok: false, error: "同じチームが選ばれています。" };

  return withLock(function () {
    if (_cupHasReports(seasonId)) {
      return { ok: false, error: "GMリーグ杯の試合結果が既に報告されているため、組み合わせは動かせません。" };
    }

    var rows = _fixtureRows(seasonId, STAGE_TOURNAMENT).filter(function (f) { return _str(f.tie_id); });
    var hitA = false;
    var hitB = false;
    rows.forEach(function (f) {
      var h = _str(f.home_team);
      var w = _str(f.away_team);
      if (h === a || w === a) hitA = true;
      if (h === b || w === b) hitB = true;
    });
    if (!hitA || !hitB) return { ok: false, error: "トーナメント表に無いチームが含まれています。" };

    var swap = function (x) { return x === a ? b : (x === b ? a : x); };
    rows.forEach(function (f) {
      var h = _str(f.home_team);
      var w = _str(f.away_team);
      if (swap(h) === h && swap(w) === w) return;
      updateRow("Fixtures", "fixture_id", _str(f.fixture_id), { home_team: swap(h), away_team: swap(w) });
    });

    return { ok: true, data: { season_id: seasonId, team_a: a, team_b: b } };
  });
}

/**
 * GMリーグ杯の試合（差戻以外）が1件でもあるか。
 *
 * @param {string} seasonId
 * @returns {boolean}
 */
function _cupHasReports(seasonId) {
  return getSheetData("Matches").some(function (m) {
    return _str(m.season_id) === seasonId && _str(m.stage) === STAGE_TOURNAMENT &&
      _str(m.status) !== MATCH_REJECTED;
  });
}

/**
 * Fixtures シートに tie_id / leg 列があるか。無ければエラー文。
 *
 * 列が無いまま書くと、その値だけ黙って捨てられ、どの行がどのタイか分からなくなる。
 *
 * @returns {string}
 */
function _fixtureHeaderError() {
  var sheet = _sheetHandle("Fixtures");
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  var missing = ["tie_id", "leg"].filter(function (h) { return headers.indexOf(h) === -1; });
  return missing.length === 0 ? "" :
    "Fixtures シートに " + missing.join(" / ") + " 列がありません。GAS エディタで setupAll を実行してから作り直してください。";
}

/**
 * GMリーグ杯の報告を、トーナメント表のタイとレグに合わせる。
 *
 * トーナメント表が無いシーズンは何もしない（従来どおり tie_id / レグを手入力）。
 * 表があれば、対戦する2チームからタイを特定し、tie_id・レグ・ラウンド名を表の値にそろえる。
 * 表に無い対戦（勝ち上がっていないチーム同士など）は弾く。
 *
 * @param {Object} p _normalizeMatchPayload の結果（書き換える）
 * @returns {string|null} エラー文
 */
function _applyCupBracketRules(p) {
  var b = _cupBracket(p.seasonId);
  if (!b) return null;

  var tie = null;
  b.rounds.forEach(function (r) {
    r.ties.forEach(function (t) {
      if (tie || t.bye || !t.team_a || !t.team_b) return;
      var pair = (t.team_a === p.homeTeam && t.team_b === p.awayTeam) ||
                 (t.team_a === p.awayTeam && t.team_b === p.homeTeam);
      if (pair) tie = t;
    });
  });

  if (!tie) {
    return "GMリーグ杯のトーナメント表に無い対戦です。勝ち上がりが決まっていないか、組み合わせが違います。";
  }

  var leg = _normalizeLeg(p.leg);
  if (tie.leg_count === 2) {
    if (leg !== "1" && leg !== "2") {
      // レグの指定が無ければ、ホームのチームから決める
      var match = tie.legs.filter(function (l) { return l.home === p.homeTeam; })[0];
      leg = match ? match.leg : "";
    }
    if (leg !== "1" && leg !== "2") return "1stレグか2ndレグかを選んでください。";
  } else {
    leg = "";
  }

  p.tieId = tie.tie_id;
  p.leg = leg;
  p.round = tie.round;
  return null;
}

/**
 * GMスーパーカップの報告を、保存された対戦カードに合わせる。
 *
 * 出場できるのは主催者が保存した2チームだけ。1試合なのでレグは無い。
 *
 * @param {Object} p _normalizeMatchPayload の結果（書き換える）
 * @returns {string|null} エラー文
 */
function _applySuperCupRules(p) {
  var row = _superCupRow(p.seasonId);
  if (!row) return "GMスーパーカップの対戦カードがまだ保存されていません。主催者に確認してください。";

  var a = _str(row.team_a);
  var b = _str(row.team_b);
  var pair = (p.homeTeam === a && p.awayTeam === b) || (p.homeTeam === b && p.awayTeam === a);
  if (!pair) {
    var names = _teamNameMap();
    return "GMスーパーカップは " + (names[a] || a) + " と " + (names[b] || b) + " の対戦です。";
  }

  p.tieId = "";
  p.leg = "";
  p.round = SUPERCUP_ROUND;
  return null;
}

/**
 * 報告画面用に、トーナメント表のレグを対戦表の行の形で返す。表が無ければ null。
 *
 * 両チームが決まっているレグだけを出す。勝ち上がり待ちやシードは報告できないため。
 *
 * @param {string} seasonId
 * @returns {{rounds: Object[], fixtures: Object[]}|null}
 */
function _cupFixtures(seasonId) {
  var b = _cupBracket(seasonId);
  if (!b) return null;

  var fixtures = [];
  b.rounds.forEach(function (r) {
    r.ties.forEach(function (t) {
      if (t.bye || !t.team_a || !t.team_b) return;
      t.legs.forEach(function (l) {
        var label = t.round + (l.leg === "1" ? " 1stレグ" : (l.leg === "2" ? " 2ndレグ" : ""));
        fixtures.push({
          fixture_id:     t.tie_id + ":" + (l.leg || "0"),
          division:       "",
          round:          t.round,
          label:          label,
          sort_order:     r.round_no * 100 + t.slot,
          home_team:      l.home,
          home_team_name: l.home_name,
          away_team:      l.away,
          away_team_name: l.away_name,
          note:           "",
          tie_id:         t.tie_id,
          leg:            l.leg,
          reported:       l.reported,
          match_status:   l.match_status,
          score:          l.approved ? l.home_score + " - " + l.away_score : "",
        });
      });
    });
  });

  var rounds = [];
  var seen = {};
  fixtures.forEach(function (f) {
    if (seen[f.round]) return;
    seen[f.round] = true;
    rounds.push({ round: f.round, sort_order: f.sort_order });
  });

  return { rounds: rounds, fixtures: fixtures, bracket: true };
}

/**
 * スーパーカップの対戦カードを、対戦表の行の形で返す。保存されていなければ空。
 *
 * @param {string} seasonId
 * @returns {{rounds: Object[], fixtures: Object[]}}
 */
function _superCupFixtures(seasonId) {
  var row = _superCupRow(seasonId);
  if (!row) return { rounds: [], fixtures: [] };

  var names = _teamNameMap();
  var a = _str(row.team_a);
  var b = _str(row.team_b);
  var hit = null;
  getSheetData("Matches").forEach(function (m) {
    if (_str(m.season_id) !== seasonId || _str(m.stage) !== STAGE_SUPERCUP) return;
    if (_str(m.status) === MATCH_REJECTED) return;
    hit = m;
  });

  return {
    rounds: [{ round: SUPERCUP_ROUND, sort_order: 1 }],
    fixtures: [{
      fixture_id:     "supercup",
      division:       "",
      round:          SUPERCUP_ROUND,
      label:          SUPERCUP_ROUND,
      sort_order:     1,
      home_team:      a,
      home_team_name: names[a] || a,
      away_team:      b,
      away_team_name: names[b] || b,
      note:           _str(row.note),
      tie_id:         "",
      leg:            "",
      reported:       !!hit,
      match_status:   hit ? _str(hit.status) : "",
      score:          hit ? _num(hit.home_score) + " - " + _num(hit.away_score) : "",
    }],
  };
}
