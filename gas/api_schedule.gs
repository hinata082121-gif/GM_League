/**
 * api_schedule.gs — 日程表
 *
 * 全ロール:
 *   getSeasonSchedule    — シーズンの日程と「次の予定」
 *
 * 主催者:
 *   getScheduleTemplate  — ひな型の取得
 *   saveScheduleTemplate — ひな型の保存（丸ごと差し替え）
 *   generateSchedule     — 開幕日を指定してひな型から日程を生成
 *   upsertScheduleItem   — 1件の追加・修正
 *   deleteScheduleItem   — 1件の削除
 *
 * ▶ 考え方
 *   毎シーズンの日程はほぼ同じで、日付だけがずれる。
 *   そこで **リーグ戦開幕日を 0 とした相対日数（day_offset）** でひな型を持ち、
 *   開幕日を1つ入れれば全部の日付が決まるようにしている。
 *
 *   生成した後は SeasonSchedule 側を自由に編集できる。
 *   処理が重なった年だけ1日ずらす、といった調整はここで行う。
 *   ひな型自体を直せば、翌シーズン以降に反映される。
 *
 * ⚠️ 設計原則
 *   1. 書き込みは必ず GAS 経由
 *   2. 「今日」の判定はサーバー側の now() で行う
 */

// =============================================================================
// ひな型
// =============================================================================

/**
 * 日程表のひな型を返す。主催者専用。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getScheduleTemplate(token) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  return { ok: true, data: { rows: _templateRows() } };
}

/**
 * ScheduleTemplate を並べ替えて返す。
 *
 * @returns {Object[]}
 */
function _templateRows() {
  var rows;
  try {
    rows = getSheetData("ScheduleTemplate");
  } catch (e) {
    Logger.log("[_templateRows] ScheduleTemplate 読み取りエラー: " + e.message);
    return [];
  }

  return rows
    .filter(function (r) { return _str(r.label); })
    .map(function (r) {
      return {
        sort_order: _num(r.sort_order),
        day_offset: _num(r.day_offset),
        label:      _str(r.label),
        note:       _str(r.note),
      };
    })
    .sort(function (a, b) {
      if (a.day_offset !== b.day_offset) return a.day_offset - b.day_offset;
      return a.sort_order - b.sort_order;
    });
}

/**
 * ひな型を丸ごと差し替える。主催者専用。
 *
 * 部分更新にしないのは、並べ替えと削除を1回の操作で反映したいため。
 *
 * payload: { rows: [{ day_offset, label, note? }] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function saveScheduleTemplate(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var input = payload.rows || [];
  var rows = [];

  for (var i = 0; i < input.length; i++) {
    var label = _str(input[i].label).trim();
    if (!label) continue;

    var offset = Math.round(_num(input[i].day_offset));
    if (!isFinite(offset)) {
      return { ok: false, error: "「" + label + "」の日数が数値ではありません。" };
    }

    rows.push([rows.length + 1, offset, label, _str(input[i].note)]);
  }

  if (rows.length === 0) {
    return { ok: false, error: "少なくとも1件は必要です。" };
  }

  return withLock(function () {
    var sheet = getSheet("ScheduleTemplate");
    var last = sheet.getLastRow();
    if (last >= 2) sheet.deleteRows(2, last - 1);

    sheet.getRange(2, 1, rows.length, 4).setValues(rows);

    return { ok: true, data: { count: rows.length } };
  });
}

// =============================================================================
// 生成
// =============================================================================

/**
 * ひな型から、そのシーズンの日程を作る。主催者専用。
 *
 * 開幕日（day_offset = 0 の日）を指定すると、他の予定の日付が全部決まる。
 *
 * 既に日程がある場合は overwrite=true でないと拒否する。
 * 手で調整した内容をうっかり消さないため。
 *
 * payload: { season_id, opening_date, overwrite? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
/**
 * 作成した日程のうち、今日より前になっている件数を数える。
 *
 * 準備期間は開幕の23日前から始まるので、開幕日を近くに置きすぎると
 * 募集や申告の締切が過去日になる。**エラーにはしない**。
 * 途中から使い始める場合や、過ぎた分を記録として残す場合があるため。
 * 件数だけ返して、画面に注意を出す判断は呼び出し側に任せる。
 *
 * @param {Object[]} rows
 * @returns {number}
 */
function _countPastRows(rows) {
  var today = now();
  today.setHours(0, 0, 0, 0);

  var n = 0;
  rows.forEach(function (r) {
    if (r.date && r.date.getTime() < today.getTime()) n++;
  });
  return n;
}

function generateSchedule(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }

  var opening = _parseDateInput(payload.opening_date);
  if (!opening) {
    return { ok: false, error: "リーグ戦の開幕日を指定してください。" };
  }

  var template = _templateRows();
  if (template.length === 0) {
    return {
      ok: false,
      error: "日程表のひな型が空です。先にひな型を作成してください。",
    };
  }

  return withLock(function () {
    var existing = _scheduleRows(seasonId);

    if (existing.length > 0 && !_toBool(payload.overwrite)) {
      return {
        ok: false,
        error: "このシーズンには既に " + existing.length +
          " 件の日程があります。作り直す場合は上書きを選んでください。",
      };
    }

    if (existing.length > 0) _deleteScheduleRows(seasonId);

    var rows = template.map(function (t, i) {
      return {
        schedule_id: generateId("sc_"),
        season_id:   seasonId,
        date:        _addDays(opening, t.day_offset),
        label:       t.label,
        note:        t.note,
        sort_order:  i + 1,
        done:        false,
      };
    });

    _appendRowsBatch("SeasonSchedule", rows);

    return {
      ok: true,
      data: {
        season_id:    seasonId,
        opening_date: _iso(opening),
        count:        rows.length,
        first_date:   _iso(rows[0].date),
        last_date:    _iso(rows[rows.length - 1].date),
        past_count:   _countPastRows(rows),
      },
    };
  });
}

/**
 * 日付に日数を足した新しい Date を返す。
 *
 * 時刻は 0:00 に揃える。日付だけを扱いたいので、
 * 生成元の時刻が残っていると比較がぶれる。
 *
 * @param {Date} base
 * @param {number} days
 * @returns {Date}
 */
function _addDays(base, days) {
  var d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + Math.round(days));
  return d;
}

// =============================================================================
// 取得
// =============================================================================

/**
 * シーズンの日程を返す。ログイン済みなら誰でも見られる。
 *
 * 「今日」と「次の予定」も一緒に返すので、画面側で計算しなくてよい。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSeasonSchedule(token, payload) {
  if (token !== PUBLIC_ACCESS) {
    var auth = _requireUser(token);
    if (!auth.ok) return auth;
  }

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  return { ok: true, data: _buildScheduleView(seasonId) };
}

/**
 * 日程の一覧と、今日を基準にした位置づけを組み立てる。
 *
 * @param {string} seasonId
 * @returns {Object}
 */
function _buildScheduleView(seasonId) {
  var today = _todayDate();
  var rows = _scheduleRows(seasonId);

  var items = rows.map(function (r) {
    var d = _asDate(r.date);
    var diff = d ? _dayDiff(today, d) : null;

    return {
      schedule_id: _str(r.schedule_id),
      date:        _iso(r.date),
      date_label:  _formatDate(d),
      weekday:     _weekdayLabel(d),
      label:       _str(r.label),
      note:        _str(r.note),
      done:        _toBool(r.done),
      sort_order:  _num(r.sort_order),
      days_left:   diff,
      is_today:    diff === 0,
      is_past:     diff !== null && diff < 0,
    };
  });

  items.sort(function (a, b) {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
    return a.sort_order - b.sort_order;
  });

  // 次の予定 = 今日以降で、まだ消化していないもの
  var upcoming = items.filter(function (i) {
    return !i.is_past && !i.done;
  });

  return {
    season_id:   seasonId,
    items:       items,
    count:       items.length,
    today:       _iso(today),
    today_items: items.filter(function (i) { return i.is_today; }),
    next:        upcoming.length > 0 ? upcoming[0] : null,
    upcoming:    upcoming.slice(0, 5),
  };
}

/**
 * SeasonSchedule から該当シーズンの行を返す。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _scheduleRows(seasonId) {
  try {
    return getSheetData("SeasonSchedule").filter(function (r) {
      return _str(r.schedule_id) && _str(r.season_id) === seasonId;
    });
  } catch (e) {
    Logger.log("[_scheduleRows] SeasonSchedule 読み取りエラー: " + e.message);
    return [];
  }
}

/**
 * 該当シーズンの日程を全部削除する。
 *
 * @param {string} seasonId
 * @returns {number}
 */
function _deleteScheduleRows(seasonId) {
  var sheet = getSheet("SeasonSchedule");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var iSeason = values[0].indexOf("season_id");
  if (iSeason === -1) return 0;

  var count = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][iSeason]) !== seasonId) continue;
    sheet.deleteRow(i + 1);
    count++;
  }
  return count;
}

// =============================================================================
// 個別の編集
// =============================================================================

/**
 * 日程を1件追加または修正する。主催者専用。
 *
 * payload: { schedule_id?, season_id, date, label, note?, sort_order?, done? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertScheduleItem(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var label = _str(payload.label).trim();

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!label) return { ok: false, error: "予定の名前を入力してください。" };

  var date = _parseDateInput(payload.date);
  if (!date) return { ok: false, error: "日付を指定してください。" };

  var scheduleId = _str(payload.schedule_id);

  return withLock(function () {
    var updates = {
      season_id:  seasonId,
      date:       _addDays(date, 0),
      label:      label,
      note:       _str(payload.note),
      sort_order: payload.sort_order === undefined ? 999 : Math.round(_num(payload.sort_order)),
      done:       _toBool(payload.done),
    };

    if (scheduleId && findRow("SeasonSchedule", "schedule_id", scheduleId)) {
      updateRow("SeasonSchedule", "schedule_id", scheduleId, updates);
      return { ok: true, data: { schedule_id: scheduleId, created: false } };
    }

    scheduleId = generateId("sc_");
    updates.schedule_id = scheduleId;
    appendRow("SeasonSchedule", updates);

    return { ok: true, data: { schedule_id: scheduleId, created: true } };
  });
}

/**
 * 日程を1件削除する。主催者専用。
 *
 * payload: { schedule_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function deleteScheduleItem(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var scheduleId = _str(payload.schedule_id);
  if (!scheduleId) return { ok: false, error: "schedule_id は必須です。" };

  return withLock(function () {
    var sheet = getSheet("SeasonSchedule");
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return { ok: false, error: "日程が見つかりません。" };

    var iId = values[0].indexOf("schedule_id");

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iId]) !== scheduleId) continue;
      sheet.deleteRow(i + 1);
      return { ok: true, data: { schedule_id: scheduleId } };
    }

    return { ok: false, error: "日程が見つかりません。" };
  });
}

// =============================================================================
// 日付のヘルパ
// =============================================================================

/**
 * 今日の 0:00 を返す。サーバー時刻を使う（設計原則2）。
 *
 * @returns {Date}
 */
function _todayDate() {
  var n = now();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/**
 * 値を Date に寄せる。変換できなければ null。
 *
 * @param {*} v
 * @returns {Date|null}
 */
function _asDate(v) {
  if (!v) return null;
  var d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * from から to までの日数。同じ日なら 0、過去なら負。
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {number}
 */
function _dayDiff(from, to) {
  var ms = to.getTime() - from.getTime();
  return Math.round(ms / 86400000);
}

/**
 * 「5月18日」形式にする。
 *
 * @param {Date|null} d
 * @returns {string}
 */
function _formatDate(d) {
  if (!d) return "";
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/**
 * 曜日の1文字。
 *
 * @param {Date|null} d
 * @returns {string}
 */
function _weekdayLabel(d) {
  if (!d) return "";
  return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
}
