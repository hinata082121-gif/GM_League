/**
 * api_signup.gs — 参加登録（新規ユーザーの導線）
 *
 * 誰でも（Users 未登録でも）呼べる:
 *   getSignupInfo     — 受付中かどうかだけを返す。コードは返さない
 *   getSignupClubs    — 選択できるクラブの一覧（カテゴリ別・使用済みフラグ付き）
 *   verifySignupCode  — 合言葉の照合
 *   submitSignup      — 参加申請の提出（Google ログイン必須）
 *   getMySignup       — 自分の申請状況
 *
 * 主催者専用:
 *   listSignups    — 申請一覧
 *   approveSignup  — 承認（Users + Teams を作る）
 *   rejectSignup   — 却下
 *
 * ⚠️ 設計原則
 *   1. 書き込みは必ず GAS 経由。合言葉の照合もサーバー側でのみ行う
 *   5. 承認前のデータを本体に混ぜない（Signups は Users とは別シート）
 *
 * 確定仕様
 *   - 合言葉は Config の signup_code。全員共通で、主催者がいつでも変更できる
 *   - signup_open が false のときは受付を閉じる
 *   - 申請はその場では有効にならず、主催者が承認して初めてログインできる
 *   - email はトークンから取る。ペイロードの email は信用しない
 *   - チーム名は自由記入ではなく **Clubs シートの実在クラブから選ぶ**
 *     選べるカテゴリは Config の signup_club_categories（既定 J1,J2）
 *     J3 は選択肢に出さないが、Clubs シートにはデータとして残す
 */

// =============================================================================
// 定数
// =============================================================================

var SIGNUP_PENDING = "申請中";
var SIGNUP_APPROVED = "承認";
var SIGNUP_REJECTED = "却下";
var SIGNUP_STATUSES = [SIGNUP_PENDING, SIGNUP_APPROVED, SIGNUP_REJECTED];

// =============================================================================
// 受付状態
// =============================================================================

/**
 * 参加登録の受付状態を返す。トークン不要。
 *
 * 合言葉そのものは**絶対に返さない**。受付中かどうかだけを伝える。
 *
 * @returns {{ ok: boolean, data: Object }}
 */
function getSignupInfo() {
  return {
    ok: true,
    data: {
      open: _isSignupOpen(),
    },
  };
}

/**
 * 受付中かどうか。合言葉が未設定なら受け付けない。
 *
 * @returns {boolean}
 */
function _isSignupOpen() {
  var code = _str(getConfig("signup_code", ""));
  if (!code) return false;
  return _toBool(getConfig("signup_open", false));
}

// =============================================================================
// 選べるクラブ
// =============================================================================

/**
 * 参加登録で選べるクラブの一覧を返す。トークン不要。
 *
 * チーム名は自由記入だと表記ゆれや重複が起きるため、実在の J クラブから選ばせる。
 * 既に使われているクラブは taken=true を立てて、フロント側で選べなくする。
 *
 * payload: { } （ログイン済みなら token から自分の申請を除外する）
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSignupClubs(token, payload) {
  var selfEmail = token ? _verifyToken(token) : null;
  var opts = _signupClubOptions(selfEmail);

  return {
    ok: true,
    data: {
      categories: opts.categories,
      clubs:      opts.grouped,
      available:  opts.availableCount,
      total:      opts.total,
    },
  };
}

/**
 * 選べるクラブを組み立てる。
 *
 * 使用済みの判定は2種類:
 *   登録済み — 既に Teams にそのクラブ名がある
 *   申請中   — 他の人が承認待ちで押さえている
 *
 * 申請中も塞ぐのは、2人が同じクラブで申請してしまうと
 * 片方が承認時にはじかれて出し直しになるため。先に見せて避けてもらう。
 *
 * @param {string|null} selfEmail 自分の申請は「使用済み」にしない
 * @returns {{categories: string[], grouped: Object, total: number, availableCount: number,
 *            allowed: Object}}
 */
function _signupClubOptions(selfEmail) {
  var allowedList = _str(getConfig("signup_club_categories", "J1,J2"))
    .split(",")
    .map(function (c) { return c.trim(); })
    .filter(function (c) { return c; });

  var allowedCategory = {};
  allowedList.forEach(function (c) { allowedCategory[c] = true; });

  // 使用済み: Teams に登録済み
  //
  // ただし**オーナーがいないチームは塞がない**。
  // 継続参加のチームは主催者が先にスカッドと予算を入れておくので、
  // 本人が申請する時点で Teams には既に行がある。
  // そこで塞いでしまうと、継続参加者が自分のクラブを選べなくなる。
  //
  // オーナーが決まって初めて「その人のもの」になる。
  // 承認時に既存のチームへ結び付ける（approveSignup）。
  //
  // 判定は owner_user_id が空かどうかだけで行う。
  // 参照先のユーザーが実在するかまでは見ない。値が入っている時点で
  // 誰かのものにする意図があったとみなすほうが、取り違えより安全。
  var takenBy = {};
  var claimable = {};

  getSheetData("Teams").forEach(function (t) {
    var name = _str(t.name);
    if (!name) return;

    if (_str(t.owner_user_id)) {
      takenBy[name] = "登録済み";
    } else {
      claimable[name] = true;
    }
  });

  // 使用済み: 他の人が申請中
  var self = String(selfEmail || "").toLowerCase();
  try {
    getSheetData("Signups").forEach(function (r) {
      if (_str(r.status) !== SIGNUP_PENDING) return;
      if (self && _str(r.email).toLowerCase() === self) return;
      var name = _str(r.team_name);
      if (name && !takenBy[name]) takenBy[name] = "申請中";
    });
  } catch (e) {
    Logger.log("[_signupClubOptions] Signups 読み取りエラー: " + e.message);
  }

  var rows = getSheetData("Clubs")
    .map(function (r) {
      return {
        category:   _str(r.category),
        club_name:  _str(r.club_name),
        sort_order: _num(r.sort_order),
      };
    })
    .filter(function (r) { return r.club_name && allowedCategory[r.category]; });

  rows.sort(function (a, b) { return a.sort_order - b.sort_order; });

  var categories = [];
  var grouped = {};
  var available = 0;

  rows.forEach(function (r) {
    if (!grouped[r.category]) {
      grouped[r.category] = [];
      categories.push(r.category);
    }
    var taken = takenBy[r.club_name] || "";
    if (!taken) available++;
    grouped[r.category].push({
      club_name:    r.club_name,
      taken:        !!taken,
      taken_reason: taken,
      // 継続参加のチーム。選べるが、承認すると既存のスカッドと予算を引き継ぐ
      continuing:   !taken && !!claimable[r.club_name],
    });
  });

  return {
    categories: categories,
    grouped: grouped,
    total: rows.length,
    availableCount: available,
    allowed: allowedCategory,
  };
}

/**
 * チーム名が「選べるクラブ」かどうかを検証する。
 *
 * フロントのプルダウンだけに頼らず、ここでも必ず確認する（設計原則1）。
 *
 * @param {string} teamName
 * @param {string|null} selfEmail
 * @returns {string|null} 問題なければ null、あればエラーメッセージ
 */
function _validateSignupClub(teamName, selfEmail) {
  var opts = _signupClubOptions(selfEmail);

  var found = null;
  opts.categories.forEach(function (cat) {
    opts.grouped[cat].forEach(function (c) {
      if (c.club_name === teamName) found = c;
    });
  });

  if (!found) {
    return "チームは一覧から選んでください（" +
      Object.keys(opts.allowed).join(" / ") + " のクラブのみ）。";
  }

  if (found.taken) {
    return teamName + " は既に " + found.taken_reason + " です。別のクラブを選んでください。";
  }

  return null;
}

/**
 * 合言葉を照合する。トークン不要。
 *
 * 照合は必ずここ（サーバー側）で行う。合言葉をフロントに置くと
 * ソースを見るだけで分かってしまうため。
 *
 * payload: { code }
 *
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function verifySignupCode(payload) {
  if (!_isSignupOpen()) {
    return { ok: false, error: "現在は参加登録を受け付けていません。" };
  }

  var input = _str(payload.code).trim();
  if (!input) return { ok: false, error: "合言葉を入力してください。" };

  var expected = _str(getConfig("signup_code", "")).trim();

  // 大文字小文字と全角空白は無視する（口頭・画像で伝えられることを想定）
  if (_normalizeCode(input) !== _normalizeCode(expected)) {
    return { ok: false, error: "合言葉が違います。主催者に確認してください。" };
  }

  return { ok: true, data: { verified: true } };
}

/**
 * 合言葉の比較用に正規化する。
 *
 * @param {string} v
 * @returns {string}
 */
function _normalizeCode(v) {
  return String(v || "")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

// =============================================================================
// 申請
// =============================================================================

/**
 * 参加申請を提出する。
 *
 * Google ログインは必須（email を確定させるため）だが、
 * Users に登録済みである必要はない。
 *
 * payload: { code, display_name, team_name, x_id?, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function submitSignup(token, payload) {
  var verify = verifySignupCode(payload);
  if (!verify.ok) return verify;

  // email はトークンから取る。payload の email は信用しない
  var email = _verifyToken(token);
  if (!email) return { ok: false, error: "invalid_token" };

  var displayName = _str(payload.display_name).trim();
  var teamName = _str(payload.team_name).trim();

  if (!displayName) return { ok: false, error: "表示名を入力してください。" };
  if (!teamName) return { ok: false, error: "チームを選んでください。" };
  if (displayName.length > 40) return { ok: false, error: "表示名は40文字以内で入力してください。" };

  // 一覧にある空きクラブかどうかをサーバー側で必ず確認する
  var clubError = _validateSignupClub(teamName, email);
  if (clubError) return { ok: false, error: clubError };

  var rawX = _str(payload.x_id).trim();
  var xId = normalizeXId(rawX);
  if (rawX && !xId) {
    return {
      ok: false,
      error: "X の ID として認識できません。英数字とアンダースコア15文字以内で入力してください（@やURLのままでも構いません）。",
    };
  }

  // 既に Users にいる人は申請不要
  if (_findUserByEmail(email)) {
    return { ok: false, error: "このアカウントは既に登録済みです。トップページからログインしてください。" };
  }

  return withLock(function () {
    var existing = _findSignupByEmail(email);

    if (existing && _str(existing.status) === SIGNUP_PENDING) {
      // 承認待ちの間は上書きを許す（入力ミスの訂正）
      updateRow("Signups", "signup_id", _str(existing.signup_id), {
        display_name: displayName,
        team_name:    teamName,
        x_id:         xId,
        note:         _str(payload.note),
        created_at:   now(),
      });
      return {
        ok: true,
        data: { signup_id: _str(existing.signup_id), status: SIGNUP_PENDING, updated: true },
      };
    }

    if (existing && _str(existing.status) === SIGNUP_REJECTED) {
      // 却下された人が再申請する場合は同じ行を作り直す
      updateRow("Signups", "signup_id", _str(existing.signup_id), {
        display_name: displayName,
        team_name:    teamName,
        x_id:         xId,
        note:         _str(payload.note),
        status:       SIGNUP_PENDING,
        created_at:   now(),
        decided_at:   "",
        decided_by:   "",
      });
      return {
        ok: true,
        data: { signup_id: _str(existing.signup_id), status: SIGNUP_PENDING, updated: true },
      };
    }

    var signupId = generateId("sg_");
    appendRow("Signups", {
      signup_id:    signupId,
      email:        email,
      display_name: displayName,
      team_name:    teamName,
      x_id:         xId,
      note:         _str(payload.note),
      status:       SIGNUP_PENDING,
      created_at:   now(),
      decided_at:   "",
      decided_by:   "",
      team_id:      "",
    });

    return { ok: true, data: { signup_id: signupId, status: SIGNUP_PENDING, updated: false } };
  });
}

/**
 * 自分の申請状況を返す。Users 未登録でも呼べる。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getMySignup(token) {
  var email = _verifyToken(token);
  if (!email) return { ok: false, error: "invalid_token" };

  var user = _findUserByEmail(email);
  if (user) {
    return {
      ok: true,
      data: { email: email, registered: true, status: SIGNUP_APPROVED, user: user },
    };
  }

  var row = _findSignupByEmail(email);
  if (!row) {
    return { ok: true, data: { email: email, registered: false, status: "" } };
  }

  return {
    ok: true,
    data: {
      email:        email,
      registered:   false,
      signup_id:    _str(row.signup_id),
      status:       _str(row.status),
      display_name: _str(row.display_name),
      team_name:    _str(row.team_name),
      x_id:         _str(row.x_id),
      created_at:   _iso(row.created_at),
    },
  };
}

/**
 * Signups から email で行を探す（大文字小文字を無視）。
 *
 * @param {string} email
 * @returns {Object|null}
 */
function _findSignupByEmail(email) {
  var rows;
  try {
    rows = getSheetData("Signups");
  } catch (e) {
    Logger.log("[_findSignupByEmail] Signups シート読み取りエラー: " + e.message);
    return null;
  }

  var target = String(email || "").toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].email).toLowerCase() === target) return rows[i];
  }
  return null;
}

// =============================================================================
// 承認 / 却下（主催者専用）
// =============================================================================

/**
 * 申請の一覧を返す。
 *
 * payload: { status? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listSignups(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var wantStatus = _str((payload || {}).status);

  var rows = getSheetData("Signups")
    .filter(function (r) {
      if (!_str(r.signup_id)) return false;
      if (wantStatus && _str(r.status) !== wantStatus) return false;
      return true;
    })
    .map(function (r) {
      return {
        signup_id:    _str(r.signup_id),
        email:        _str(r.email),
        display_name: _str(r.display_name),
        team_name:    _str(r.team_name),
        x_id:         _str(r.x_id),
        note:         _str(r.note),
        status:       _str(r.status),
        created_at:   _iso(r.created_at),
        decided_at:   _iso(r.decided_at),
        team_id:      _str(r.team_id),
      };
    });

  // 申請中を先に、その中では新しい順
  rows.sort(function (a, b) {
    var pa = a.status === SIGNUP_PENDING ? 0 : 1;
    var pb = b.status === SIGNUP_PENDING ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return String(b.created_at).localeCompare(String(a.created_at));
  });

  return { ok: true, data: rows };
}

/**
 * 申請を承認し、Users と Teams を作る。
 *
 * チーム名は主催者が上書きできる（重複や表記ゆれの調整用）。
 *
 * payload: { signup_id, team_name? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function approveSignup(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var signupId = _str(payload.signup_id);
  if (!signupId) return { ok: false, error: "signup_id は必須です。" };

  return withLock(function () {
    var row = findRow("Signups", "signup_id", signupId);
    if (!row) return { ok: false, error: "申請が見つかりません。" };
    if (_str(row.status) !== SIGNUP_PENDING) {
      return { ok: false, error: "この申請は既に " + _str(row.status) + " になっています。" };
    }

    var email = _str(row.email).toLowerCase();
    if (_findUserRowByEmail(email)) {
      return { ok: false, error: "このメールアドレスは既に Users に登録されています。" };
    }

    var teamName = _str(payload.team_name).trim() || _str(row.team_name);
    if (!teamName) return { ok: false, error: "チームが選ばれていません。" };

    // 主催者が差し替えた場合も含めて、実在クラブかつ未使用かを確認する。
    // 申請者自身の予約は「使用済み」に数えない
    var clubError = _validateSignupClub(teamName, email);
    if (clubError) return { ok: false, error: clubError };

    var userId = generateId("u_");
    var at = now();

    // 同じ名前のチームが既にあれば、新しく作らずそこへ結び付ける。
    //
    // 継続参加のチームは主催者が先にスカッドと予算を入れてある。
    // 新規に作り直すと、その積み上げが宙に浮いて空のチームが割り当たる。
    var existing = _unclaimedTeam(teamName);
    var teamId;
    var continuing = false;

    if (existing) {
      teamId = _str(existing.team_id);
      continuing = true;

      updateRow("Teams", "team_id", teamId, {
        owner_user_id: userId,
        kind:          "継続",
        active:        true,
      });
    } else {
      teamId = generateId("t_");
      appendRow("Teams", {
        team_id:       teamId,
        name:          teamName,
        owner_user_id: userId,
        kind:          "新規",
        active:        true,
      });
    }

    appendRow("Users", {
      user_id:      userId,
      email:        email,
      display_name: _str(row.display_name) || email,
      role:         "team",
      team_id:      teamId,
      x_id:         _str(row.x_id),
    });

    updateRow("Signups", "signup_id", signupId, {
      status:     SIGNUP_APPROVED,
      team_name:  teamName,
      decided_at: at,
      decided_by: _str(auth.data.user_id),
      team_id:    teamId,
    });

    return {
      ok: true,
      data: {
        signup_id:  signupId,
        user_id:    userId,
        team_id:    teamId,
        team_name:  teamName,
        continuing: continuing,
      },
    };
  });
}

/**
 * 同じ名前で、まだオーナーがいないチームを探す。
 *
 * 継続参加のチームは主催者が先に作ってあり、オーナーだけが空いている。
 * 承認のときにここへ結び付けると、スカッドと予算をそのまま引き継げる。
 *
 * 判定は owner_user_id が空かどうかだけ。_signupClubOptions と揃える。
 *
 * @param {string} teamName
 * @returns {Object|null}
 */
function _unclaimedTeam(teamName) {
  var rows = getSheetData("Teams");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].name) !== teamName) continue;
    if (!_str(rows[i].owner_user_id)) return rows[i];
  }
  return null;
}

/**
 * 申請を却下する。
 *
 * payload: { signup_id, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function rejectSignup(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var signupId = _str(payload.signup_id);
  if (!signupId) return { ok: false, error: "signup_id は必須です。" };

  return withLock(function () {
    var row = findRow("Signups", "signup_id", signupId);
    if (!row) return { ok: false, error: "申請が見つかりません。" };
    if (_str(row.status) !== SIGNUP_PENDING) {
      return { ok: false, error: "この申請は既に " + _str(row.status) + " になっています。" };
    }

    var note = _str(payload.note);

    updateRow("Signups", "signup_id", signupId, {
      status:     SIGNUP_REJECTED,
      note:       note || _str(row.note),
      decided_at: now(),
      decided_by: _str(auth.data.user_id),
    });

    return { ok: true, data: { signup_id: signupId, status: SIGNUP_REJECTED } };
  });
}
