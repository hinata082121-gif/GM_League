/**
 * views.js — Phase 1「マスタ & 閲覧」の画面ロジック
 *
 * 画面:
 *   1. ダッシュボード   — 全ロール。自チームの予算・スカッド概要
 *   2. チーム閲覧       — 全ロール。任意チームのスカッドと保有予算
 *   3. マスタ管理       — 主催者限定。選手/チーム/ユーザー登録・CSV取込・Config編集
 *
 * 依存:
 *   - app.js    (callApi)
 *   - index.html の各セクション DOM
 *
 * 設計メモ:
 *   - 集計・検証の最終判定は必ず GAS 側。ここでの表示はあくまで見た目のため。
 *   - 金額は「◯億◯万」形式に整形して表示する（内部では常に数値のまま扱う）。
 */

// ---------------------------------------------------------------------------
// 画面状態
// ---------------------------------------------------------------------------

/** ログイン中ユーザー（whoami の結果） */
let currentUser = null;

/** マスタのキャッシュ。画面遷移のたびに再取得しないための保持 */
const cache = {
  teams: null,
  seasons: null,
  players: null,
  clubs: null,
};

/** カテゴリー選択で「その他」を選んだときの値。自由入力に切り替える */
const CLUB_OTHER = '__other__';

/**
 * 金額入力の最小単位（円）。
 *
 * 大会ルール上、移籍金などの最小単位は 100万円。
 * 画面の入力欄はこの単位で受け取り、GAS へ送る直前に円へ換算する。
 * こうすると「0 を1つ多く打つ」種の入力ミスが構造的に起きなくなる。
 * シートに保存される値は従来どおり円のまま。
 */
const MONEY_UNIT = 1000000;

/**
 * 100万円単位の入力値を円に変換する。
 *
 * @param {*} v 入力欄の値
 * @returns {number} 円
 */
function unitToYen(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n) * MONEY_UNIT;
}

/**
 * 金額入力欄に「→ 2億5000万円」の確認表示を出す。
 *
 * @param {string} inputId
 * @param {string} echoId
 */
function bindMoneyEcho(inputId, echoId) {
  const input = document.getElementById(inputId);
  const echo = document.getElementById(echoId);
  if (!input || !echo) return;

  const update = () => {
    const yen = unitToYen(input.value);
    echo.textContent = yen > 0 ? '→ ' + formatMoney(yen) : '—';
    echo.className = 'money-echo' + (yen > 0 ? ' money-echo-on' : '');
  };

  input.addEventListener('input', update);
  update();
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

/**
 * ログイン完了後に app.js から呼ばれる。
 * ロールに応じてタブを出し分け、初期画面を描画する。
 *
 * @param {Object} user - whoami の data
 */
async function initViews(user) {
  currentUser = user;

  // 主催者だけマスタ管理・承認タブを表示
  const organizerOnly = user.role === 'organizer';
  ['tab-master', 'tab-approval', 'tab-txapproval'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = organizerOnly ? 'inline-block' : 'none';
  });

  bindTabs();
  bindMasterForms();

  // チーム・シーズンは各画面で使い回すので先に取得しておく
  await Promise.all([loadTeams(), loadSeasons()]);

  showTab('dashboard');
}

/**
 * タブボタンにクリックハンドラを割り当てる。
 */
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.onclick = () => showTab(btn.dataset.tab);
  });
}

/**
 * 指定タブを表示し、その画面の描画関数を呼ぶ。
 *
 * @param {string} name - 'dashboard' | 'teams' | 'master'
 */
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach((el) => {
    el.style.display = el.dataset.panel === name ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.tab === name);
  });

  if (name === 'dashboard') renderDashboard();
  if (name === 'teams') renderTeamViewer();
  if (name === 'entry') renderEntry();
  if (name === 'transfer') renderTransfer();
  if (name === 'approval') renderApproval();
  if (name === 'txapproval') renderTxApproval();
  if (name === 'master') renderMaster();
}

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 金額を「◯億◯◯00万円」形式の読みやすい文字列にする。
 *
 * 大会の最小単位が 100万円なので、億の位がある場合は万の位を必ず4桁で
 * ゼロ埋めして表示する（例: 1億 → 「1億0000万円」）。
 * 一覧で並んだときに桁が揃い、読み違いを防げる。
 *
 * 100万円未満の端数が出た場合（補填金の按分など）は
 * カンマ区切りの円表記にフォールバックする。
 *
 * @param {number} n
 * @returns {string}
 */
function formatMoney(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? '−' : '';
  const abs = Math.abs(num);

  if (abs === 0) return '0円';
  if (abs % 10000 !== 0) return sign + abs.toLocaleString() + '円';

  const oku = Math.floor(abs / 100000000);
  const man = Math.floor((abs % 100000000) / 10000);

  if (oku > 0) {
    // 億がある場合は万を4桁ゼロ埋めして桁を揃える
    return sign + oku + '億' + String(man).padStart(4, '0') + '万円';
  }
  return sign + man + '万円';
}

/**
 * HTML エスケープ。シート由来の文字列を innerHTML に入れる前に必ず通す。
 *
 * @param {*} s
 * @returns {string}
 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 要素に「読み込み中」表示を出す。
 *
 * @param {string} id
 */
function setLoading(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '<p class="muted">読み込み中...</p>';
}

/**
 * 要素にエラーメッセージを表示する。
 *
 * @param {string} id
 * @param {string} msg
 */
function setError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '<p class="msg-error">' + esc(msg) + '</p>';
}

/**
 * フォーム操作の結果メッセージを表示する。
 *
 * @param {string} id
 * @param {boolean} ok
 * @param {string} msg
 */
function setResult(id, ok, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = ok ? 'msg-ok' : 'msg-error';
  el.textContent = msg;
}

// ---------------------------------------------------------------------------
// マスタ取得（キャッシュ付き）
// ---------------------------------------------------------------------------

/**
 * チーム一覧を取得してキャッシュする。
 * @returns {Promise<Object[]>}
 */
async function loadTeams(force) {
  if (cache.teams && !force) return cache.teams;
  const res = await callApi('listTeams', {});
  cache.teams = res.ok ? res.data : [];
  return cache.teams;
}

/**
 * シーズン一覧を取得してキャッシュする。
 * @returns {Promise<Object[]>}
 */
async function loadSeasons(force) {
  if (cache.seasons && !force) return cache.seasons;
  const res = await callApi('listSeasons', {});
  cache.seasons = res.ok ? res.data : [];
  return cache.seasons;
}

/**
 * 選手一覧を取得してキャッシュする。
 * @returns {Promise<Object[]>}
 */
async function loadPlayers(force) {
  if (cache.players && !force) return cache.players;
  const res = await callApi('listPlayers', {});
  cache.players = res.ok ? res.data : [];
  return cache.players;
}

/**
 * クラブ一覧（カテゴリー別）を取得してキャッシュする。
 * @returns {Promise<{categories: string[], clubs: Object}>}
 */
async function loadClubs(force) {
  if (cache.clubs && !force) return cache.clubs;
  const res = await callApi('listClubs', {});
  cache.clubs = res.ok ? res.data : { categories: [], clubs: {}, total: 0 };
  return cache.clubs;
}

/**
 * セレクトボックスに選択肢を流し込む。
 *
 * @param {string} selectId
 * @param {Array} items
 * @param {string} valueKey
 * @param {string} labelKey
 * @param {string} [placeholder]
 */
function fillSelect(selectId, items, valueKey, labelKey, placeholder) {
  const sel = document.getElementById(selectId);
  if (!sel) return;

  const prev = sel.value;
  let html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : '';
  items.forEach((it) => {
    html += '<option value="' + esc(it[valueKey]) + '">' + esc(it[labelKey]) + '</option>';
  });
  sel.innerHTML = html;

  if (prev && items.some((it) => String(it[valueKey]) === prev)) sel.value = prev;
}

// ---------------------------------------------------------------------------
// 画面1: ダッシュボード
// ---------------------------------------------------------------------------

/**
 * 自チームの概要を描画する。
 * 主催者は所属チームが無いため、案内文のみ表示する。
 */
async function renderDashboard() {
  const box = document.getElementById('dashboard-body');
  if (!box) return;

  if (currentUser.role === 'organizer') {
    box.innerHTML =
      '<p class="muted">主催者アカウントには所属チームがありません。' +
      '「チーム閲覧」で各チームの状況を確認できます。</p>';
    return;
  }

  setLoading('dashboard-body');

  const res = await callApi('getMyTeam', {});
  if (!res.ok) {
    setError('dashboard-body', 'チーム情報の取得に失敗しました: ' + res.error);
    return;
  }
  if (!res.data.team) {
    box.innerHTML =
      '<p class="msg-error">チームが割り当てられていません。主催者に連絡してください。</p>';
    return;
  }

  const { team, squad, budget } = res.data;
  const c = squad.position_counts;

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">チーム</span>
        <span class="stat-value">${esc(team.name)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">現保有予算</span>
        <span class="stat-value">${esc(formatMoney(budget.balance))}</span>
      </div>
      <div class="stat">
        <span class="stat-label">スカッド人数</span>
        <span class="stat-value">${squad.total} 名</span>
      </div>
      <div class="stat">
        <span class="stat-label">内訳</span>
        <span class="stat-value stat-sm">GK${c.GK} / DF${c.DF} / MF${c.MF} / FW${c.FW}</span>
      </div>
    </div>
    <h3 class="sub-head">予算の内訳</h3>
    ${renderBudgetTable(budget)}
    <h3 class="sub-head">スカッド</h3>
    ${renderSquadTable(squad.squad)}
  `;
}

// ---------------------------------------------------------------------------
// 画面2: チーム閲覧
// ---------------------------------------------------------------------------

/**
 * チーム選択・シーズン選択の UI を用意する。
 * team ロールのユーザーは自チームを初期選択にする。
 */
async function renderTeamViewer() {
  const teams = await loadTeams();
  const seasons = await loadSeasons();

  fillSelect('tv-team', teams, 'team_id', 'name', 'チームを選択');
  fillSelect('tv-season', seasons, 'season_id', 'name', '全シーズン');

  const teamSel = document.getElementById('tv-team');
  const seasonSel = document.getElementById('tv-season');

  if (!teamSel.dataset.bound) {
    teamSel.onchange = loadTeamDetail;
    seasonSel.onchange = loadTeamDetail;
    teamSel.dataset.bound = '1';
  }

  // 自チームを既定選択にする
  if (!teamSel.value && currentUser.team_id) {
    teamSel.value = currentUser.team_id;
  }

  if (teamSel.value) loadTeamDetail();
}

/**
 * 選択中チームのスカッドと予算を取得して描画する。
 *
 * 予算は「現在の保有額」を見たいので、シーズン絞り込みは
 * スカッド側にのみ適用し、予算は常に全期間の合計を表示する。
 */
async function loadTeamDetail() {
  const teamId = document.getElementById('tv-team').value;
  const seasonId = document.getElementById('tv-season').value;
  const box = document.getElementById('tv-body');
  if (!box) return;

  if (!teamId) {
    box.innerHTML = '<p class="muted">チームを選択してください。</p>';
    return;
  }

  setLoading('tv-body');

  const [squadRes, budgetRes] = await Promise.all([
    callApi('getTeamSquad', { team_id: teamId, season_id: seasonId }),
    callApi('getTeamBudget', { team_id: teamId }),
  ]);

  if (!squadRes.ok) {
    setError('tv-body', 'スカッドの取得に失敗しました: ' + squadRes.error);
    return;
  }
  if (!budgetRes.ok) {
    setError('tv-body', '予算の取得に失敗しました: ' + budgetRes.error);
    return;
  }

  const squad = squadRes.data;
  const budget = budgetRes.data;
  const c = squad.position_counts;

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">現保有予算</span>
        <span class="stat-value">${esc(formatMoney(budget.balance))}</span>
      </div>
      <div class="stat">
        <span class="stat-label">スカッド人数</span>
        <span class="stat-value">${squad.total} 名</span>
      </div>
      <div class="stat">
        <span class="stat-label">内訳</span>
        <span class="stat-value stat-sm">GK${c.GK} / DF${c.DF} / MF${c.MF} / FW${c.FW}</span>
      </div>
    </div>
    <h3 class="sub-head">予算の増減（全期間）</h3>
    ${renderBudgetTable(budget)}
    <h3 class="sub-head">スカッド</h3>
    ${renderSquadTable(squad.squad)}
  `;
}

/**
 * スカッド表の HTML を組み立てる。
 *
 * @param {Object[]} squad
 * @returns {string}
 */
function renderSquadTable(squad) {
  if (!squad || squad.length === 0) {
    return '<p class="muted">在籍選手がいません。</p>';
  }

  const rows = squad
    .map(
      (p) => `
      <tr>
        <td><span class="pos pos-${esc(p.position)}">${esc(p.position)}</span></td>
        <td>${esc(p.name)}${p.eligible ? '' : ' <span class="tag-ng">対象外</span>'}</td>
        <td class="muted">${esc(p.real_club)}</td>
        <td>${esc(p.acquisition_type)}</td>
        <td class="num">${esc(formatMoney(p.acquired_cost))}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Pos</th><th>選手名</th><th>現実クラブ</th><th>獲得形態</th><th class="num">獲得額</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * 予算内訳表の HTML を組み立てる。
 *
 * 残高は BudgetTx の合計（GAS 側で算出済み）。
 * ここでは内訳を金額の大きい順に並べて見せるだけ。
 *
 * @param {Object} budget
 * @returns {string}
 */
function renderBudgetTable(budget) {
  if (!budget.breakdown || budget.breakdown.length === 0) {
    return '<p class="muted">取引履歴がありません。</p>';
  }

  const sorted = budget.breakdown.slice().sort((a, b) => b.amount - a.amount);
  const rows = sorted
    .map(
      (b) => `
      <tr>
        <td>${esc(b.reason)}</td>
        <td class="num ${b.amount < 0 ? 'neg' : 'pos'}">${esc(formatMoney(b.amount))}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>区分</th><th class="num">金額</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <th>合計（現保有額）</th>
            <th class="num">${esc(formatMoney(budget.balance))}</th>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="muted note-sm">取引 ${budget.tx_count} 件の合計。残高はシートに保存せず毎回算出しています。</p>`;
}

// ---------------------------------------------------------------------------
// 画面3: マスタ管理（主催者限定）
// ---------------------------------------------------------------------------

/**
 * マスタ管理画面を描画する。
 * チーム・ユーザーのプルダウンを更新し、選手一覧を表示する。
 */
async function renderMaster() {
  if (currentUser.role !== 'organizer') return;

  const teams = await loadTeams(true);
  fillSelect('mu-team', teams, 'team_id', 'name', '（所属なし）');

  await renderClubSelects();
  await refreshPlayerList();
  await refreshUserList();
}

/**
 * 「カテゴリー → クラブ」の2段プルダウンを組み立てる。
 * Clubs シートが空の場合は自由入力にフォールバックする。
 */
async function renderClubSelects() {
  const data = await loadClubs();
  const catSel = document.getElementById('mp-category');
  if (!catSel) return;

  let html = '';
  data.categories.forEach((c) => {
    html += '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  });
  html += '<option value="' + CLUB_OTHER + '">その他（自由入力）</option>';
  catSel.innerHTML = html;

  if (!catSel.dataset.bound) {
    catSel.onchange = onCategoryChange;
    catSel.dataset.bound = '1';
  }

  // Clubs シートが空なら最初から自由入力にしておく
  if (data.categories.length === 0) catSel.value = CLUB_OTHER;

  onCategoryChange();
}

/**
 * カテゴリー選択に応じてクラブ側のUIを切り替える。
 * 「その他」ならテキスト入力、それ以外ならクラブのプルダウンを出す。
 */
function onCategoryChange() {
  const category = document.getElementById('mp-category').value;
  const clubSel = document.getElementById('mp-club-select');
  const clubInput = document.getElementById('mp-club');
  const data = cache.clubs || { clubs: {} };

  if (category === CLUB_OTHER) {
    clubSel.style.display = 'none';
    clubInput.style.display = 'block';
    return;
  }

  clubSel.style.display = 'block';
  clubInput.style.display = 'none';

  const list = data.clubs[category] || [];
  clubSel.innerHTML = list
    .map((name) => '<option value="' + esc(name) + '">' + esc(name) + '</option>')
    .join('');
}

/**
 * 選手フォームで選択中のクラブ名を返す。
 * カテゴリーが「その他」ならテキスト入力の値を使う。
 *
 * @returns {string}
 */
function getSelectedClub() {
  const category = document.getElementById('mp-category').value;
  if (category === CLUB_OTHER) {
    return document.getElementById('mp-club').value.trim();
  }
  return document.getElementById('mp-club-select').value;
}

/**
 * 選手一覧を再取得して表に描画する。
 */
async function refreshPlayerList() {
  setLoading('mp-list');
  const players = await loadPlayers(true);

  if (players.length === 0) {
    document.getElementById('mp-list').innerHTML = '<p class="muted">選手が未登録です。</p>';
    return;
  }

  const rows = players
    .map(
      (p) => `
      <tr>
        <td><span class="pos pos-${esc(p.position)}">${esc(p.position)}</span></td>
        <td>${esc(p.name)}</td>
        <td class="muted">${esc(p.real_club)}</td>
        <td>${p.eligible ? '<span class="tag-ok">可</span>' : '<span class="tag-ng">不可</span>'}</td>
      </tr>`
    )
    .join('');

  document.getElementById('mp-list').innerHTML = `
    <div class="table-wrap table-scroll">
      <table class="data-table">
        <thead><tr><th>Pos</th><th>選手名</th><th>現実クラブ</th><th>エントリー</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">登録 ${players.length} 名</p>`;
}

/**
 * ユーザー一覧を再取得して表に描画する。
 */
async function refreshUserList() {
  setLoading('mu-list');
  const res = await callApi('listUsers', {});

  if (!res.ok) {
    setError('mu-list', 'ユーザー一覧の取得に失敗しました: ' + res.error);
    return;
  }

  const teams = await loadTeams();
  const teamName = (id) => {
    const t = teams.find((x) => x.team_id === id);
    return t ? t.name : id;
  };

  const rows = res.data
    .map(
      (u) => `
      <tr>
        <td>${esc(u.display_name)}</td>
        <td class="muted">${esc(u.email)}</td>
        <td>${u.role === 'organizer' ? '主催者' : 'チーム'}</td>
        <td class="muted">${esc(u.team_id ? teamName(u.team_id) : '—')}</td>
      </tr>`
    )
    .join('');

  document.getElementById('mu-list').innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>表示名</th><th>メール</th><th>ロール</th><th>チーム</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * マスタ管理画面の各フォームに送信ハンドラを割り当てる。
 * initViews から1回だけ呼ばれる。
 */
function bindMasterForms() {
  const playerForm = document.getElementById('form-player');
  if (playerForm) playerForm.onsubmit = onSubmitPlayer;

  const teamForm = document.getElementById('form-team');
  if (teamForm) teamForm.onsubmit = onSubmitTeam;

  const userForm = document.getElementById('form-user');
  if (userForm) userForm.onsubmit = onSubmitUser;

  const csvForm = document.getElementById('form-csv');
  if (csvForm) csvForm.onsubmit = onSubmitCsv;
}

/**
 * 選手登録フォームの送信処理。
 * @param {Event} e
 */
async function onSubmitPlayer(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  setResult('mp-result', true, '送信中...');

  const res = await callApi('upsertPlayer', {
    name: document.getElementById('mp-name').value.trim(),
    position: document.getElementById('mp-pos').value,
    real_club: getSelectedClub(),
    eligible: document.getElementById('mp-eligible').checked,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('mp-result', true, '登録しました。');

    // 選手名だけクリアする。連続登録しやすいようクラブ選択は残す
    document.getElementById('mp-name').value = '';
    document.getElementById('mp-eligible').checked = true;
    document.getElementById('mp-name').focus();

    await refreshPlayerList();
  } else {
    setResult('mp-result', false, '失敗: ' + res.error);
  }
}

/**
 * チーム登録フォームの送信処理。
 * @param {Event} e
 */
async function onSubmitTeam(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  setResult('mt-result', true, '送信中...');

  const res = await callApi('upsertTeam', {
    name: document.getElementById('mt-name').value.trim(),
    kind: document.getElementById('mt-kind').value,
    active: document.getElementById('mt-active').checked,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('mt-result', true, '登録しました。');
    e.target.reset();
    document.getElementById('mt-active').checked = true;
    await renderMaster();
  } else {
    setResult('mt-result', false, '失敗: ' + res.error);
  }
}

/**
 * ユーザー登録フォームの送信処理。
 * @param {Event} e
 */
async function onSubmitUser(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  setResult('mu-result', true, '送信中...');

  const res = await callApi('upsertUser', {
    email: document.getElementById('mu-email').value.trim(),
    display_name: document.getElementById('mu-name').value.trim(),
    role: document.getElementById('mu-role').value,
    team_id: document.getElementById('mu-team').value,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('mu-result', true, '登録しました。新規メンバーは OAuth のテストユーザー追加も必要です。');
    e.target.reset();
    await refreshUserList();
  } else {
    setResult('mu-result', false, '失敗: ' + res.error);
  }
}

/**
 * CSV 一括登録フォームの送信処理。
 * @param {Event} e
 */
async function onSubmitCsv(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const csv = document.getElementById('mc-csv').value.trim();

  if (!csv) {
    setResult('mc-result', false, 'CSV が空です。');
    return;
  }

  btn.disabled = true;
  setResult('mc-result', true, '取込中...');

  const res = await callApi('importPlayersCsv', { csv });
  btn.disabled = false;

  if (!res.ok) {
    setResult('mc-result', false, '失敗: ' + res.error);
    return;
  }

  const d = res.data;
  let msg = `${d.added} 件を追加、${d.skipped} 件をスキップしました。`;
  if (d.errors && d.errors.length > 0) {
    msg += '\nエラー: ' + d.errors.join(' / ');
  }
  setResult('mc-result', d.errors.length === 0, msg);

  document.getElementById('mc-csv').value = '';
  await refreshPlayerList();
}

// ---------------------------------------------------------------------------
// 画面3: エントリー提出（Phase 2）
// ---------------------------------------------------------------------------

/** エントリー画面で現在チェックされている player_id の集合 */
let entrySelection = new Set();

/** 直近に取得したエントリー状況 */
let entryData = null;

/**
 * エントリー画面のシーズン／チーム選択を用意する。
 * 主催者はチームを選べる（代理提出）。team ロールは自チーム固定。
 */
async function renderEntry() {
  const seasons = await loadSeasons();
  fillSelect('en-season', seasons, 'season_id', 'name');

  const seasonSel = document.getElementById('en-season');
  const teamSel = document.getElementById('en-team');
  const teamWrap = document.getElementById('en-team-wrap');

  if (currentUser.role === 'organizer') {
    const teams = await loadTeams();
    fillSelect('en-team', teams, 'team_id', 'name', 'チームを選択');
    teamWrap.style.display = 'flex';
  } else {
    teamWrap.style.display = 'none';
  }

  if (!seasonSel.dataset.bound) {
    seasonSel.onchange = loadEntryStatus;
    teamSel.onchange = loadEntryStatus;
    seasonSel.dataset.bound = '1';
  }

  await loadEntryStatus();
}

/**
 * 選択中のシーズン・チームのエントリー状況を取得して描画する。
 */
async function loadEntryStatus() {
  const seasonId = document.getElementById('en-season').value;
  const teamId = document.getElementById('en-team').value;
  const statusBox = document.getElementById('en-status');
  const pickerBox = document.getElementById('en-picker');

  entryData = null;
  entrySelection = new Set();
  pickerBox.innerHTML = '';

  if (!seasonId) {
    statusBox.innerHTML = '<p class="muted">シーズンを選択してください。</p>';
    return;
  }
  if (currentUser.role === 'organizer' && !teamId) {
    statusBox.innerHTML = '<p class="muted">代理提出するチームを選択してください。</p>';
    return;
  }

  setLoading('en-status');

  const res = await callApi('getEntryStatus', { season_id: seasonId, team_id: teamId });
  if (!res.ok) {
    setError('en-status', 'エントリー状況の取得に失敗しました: ' + res.error);
    return;
  }

  entryData = res.data;
  entrySelection = new Set(res.data.selected_ids);

  renderEntryStatusBox();
  renderEntryPicker();
}

/**
 * 状態サマリー（チーム・提出状態・必要人数）を描画する。
 */
function renderEntryStatusBox() {
  const d = entryData;
  const box = document.getElementById('en-status');

  const badge = {
    未提出: 'tag-none',
    提出済: 'tag-pending',
    承認: 'tag-ok',
    差戻: 'tag-ng',
  }[d.entry_status] || 'tag-none';

  let notice = '';
  if (d.season_status !== 'エントリー受付') {
    notice =
      '<p class="msg-error">このシーズンは現在「' + esc(d.season_status) +
      '」のため提出できません。エントリー受付中のみ提出できます。</p>';
  } else if (d.entry_status === '承認') {
    notice = '<p class="msg-ok">承認済みです。内容を変更するには主催者に差戻を依頼してください。</p>';
  } else if (d.entry_status === '差戻') {
    notice = '<p class="msg-error">差し戻されています。選び直して再提出してください。</p>';
  }

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">チーム</span>
        <span class="stat-value">${esc(d.team_name)} <span class="tag-kind">${esc(d.team_kind)}</span></span>
      </div>
      <div class="stat">
        <span class="stat-label">提出状態</span>
        <span class="stat-value stat-sm"><span class="${badge}">${esc(d.entry_status)}</span></span>
      </div>
      <div class="stat">
        <span class="stat-label">必要人数</span>
        <span class="stat-value stat-sm">${esc(d.required.label)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">選択可能な選手</span>
        <span class="stat-value stat-sm">${d.available_count} 名</span>
      </div>
    </div>
    ${notice}`;
}

/**
 * 選手選択UIを描画する。
 * 継続チームは選手を選ばないため、確認と提出ボタンだけ出す。
 */
function renderEntryPicker() {
  const d = entryData;
  const box = document.getElementById('en-picker');
  const editable = d.can_submit;

  if (d.team_kind === '継続') {
    box.innerHTML = `
      <h3 class="sub-head">引継ぎスカッドの確認</h3>
      <p class="muted">
        継続チームは前シーズンのスカッドをそのまま引き継ぎます（現在 ${d.selected_count} 名）。
        内容は「チーム閲覧」で確認できます。
      </p>
      <div class="form-actions">
        <button type="button" id="en-submit" class="btn btn-primary" ${editable ? '' : 'disabled'}>
          この内容で提出する
        </button>
        <span id="en-result" class="form-msg"></span>
      </div>`;
    document.getElementById('en-submit').onclick = onSubmitEntry;
    return;
  }

  const byPos = { GK: [], DF: [], MF: [], FW: [] };
  d.available.forEach((p) => {
    if (byPos[p.position]) byPos[p.position].push(p);
  });

  let html = '<h3 class="sub-head">選手を選ぶ</h3>';
  html += '<div id="en-counter" class="entry-counter"></div>';

  ['GK', 'DF', 'MF', 'FW'].forEach((pos) => {
    const list = byPos[pos];
    if (list.length === 0) return;

    html += `
      <div class="pos-group">
        <div class="pos-group-head">
          <span class="pos pos-${pos}">${pos}</span>
          <span class="muted" id="en-count-${pos}"></span>
        </div>
        <div class="player-grid">`;

    list.forEach((p) => {
      const checked = entrySelection.has(p.player_id) ? 'checked' : '';
      html += `
          <label class="player-chip">
            <input type="checkbox" class="en-pick" value="${esc(p.player_id)}" ${checked} ${editable ? '' : 'disabled'} />
            <span class="player-chip-name">${esc(p.name)}</span>
            <span class="player-chip-club">${esc(p.real_club)}</span>
          </label>`;
    });

    html += '</div></div>';
  });

  html += `
    <div class="form-actions">
      <button type="button" id="en-submit" class="btn btn-primary">提出する</button>
      <button type="button" id="en-clear" class="btn btn-secondary btn-sm">選択をすべて解除</button>
      <span id="en-result" class="form-msg"></span>
    </div>`;

  box.innerHTML = html;

  box.querySelectorAll('.en-pick').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) entrySelection.add(cb.value);
      else entrySelection.delete(cb.value);
      updateEntryCounter();
    };
  });

  document.getElementById('en-submit').onclick = onSubmitEntry;
  document.getElementById('en-clear').onclick = () => {
    entrySelection.clear();
    box.querySelectorAll('.en-pick').forEach((cb) => { cb.checked = false; });
    updateEntryCounter();
  };

  updateEntryCounter();
}

/**
 * 選択人数のカウンタとポジション別内訳を更新し、
 * 必要人数に満たない場合は提出ボタンを無効にする。
 *
 * 最終的な人数判定は GAS 側でも行う（クライアント側は操作性のため）。
 */
function updateEntryCounter() {
  const d = entryData;
  if (!d) return;

  const counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
  d.available.forEach((p) => {
    if (entrySelection.has(p.player_id) && counts[p.position] !== undefined) {
      counts[p.position]++;
    }
  });

  const n = entrySelection.size;
  const exact = d.required.exact;
  const okCount = exact === null
    ? n >= d.required.min && n <= d.required.max
    : n === exact;

  const counter = document.getElementById('en-counter');
  if (counter) {
    counter.className = 'entry-counter ' + (okCount ? 'entry-ok' : 'entry-ng');
    counter.innerHTML =
      '<strong>' + n + ' / ' + esc(d.required.label) + '</strong>' +
      '<span class="muted">GK' + counts.GK + ' / DF' + counts.DF +
      ' / MF' + counts.MF + ' / FW' + counts.FW + '</span>';
  }

  ['GK', 'DF', 'MF', 'FW'].forEach((pos) => {
    const el = document.getElementById('en-count-' + pos);
    if (el) el.textContent = counts[pos] + ' 名選択中';
  });

  const btn = document.getElementById('en-submit');
  if (btn) btn.disabled = !okCount || !d.can_submit;
}

/**
 * エントリーを提出する。
 */
async function onSubmitEntry() {
  const btn = document.getElementById('en-submit');
  btn.disabled = true;
  setResult('en-result', true, '送信中...');

  const res = await callApi('submitEntryList', {
    season_id: entryData.season_id,
    team_id: entryData.team_id,
    player_ids: Array.from(entrySelection),
  });

  if (res.ok) {
    setResult('en-result', true, res.data.count + ' 名で提出しました。主催者の承認をお待ちください。');
    await loadEntryStatus();
  } else {
    setResult('en-result', false, '提出できません: ' + res.error);
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 画面4: エントリー承認（主催者限定）
// ---------------------------------------------------------------------------

/**
 * 承認画面のシーズン選択を用意する。
 */
async function renderApproval() {
  if (currentUser.role !== 'organizer') return;

  const seasons = await loadSeasons();
  fillSelect('ap-season', seasons, 'season_id', 'name');

  const sel = document.getElementById('ap-season');
  if (!sel.dataset.bound) {
    sel.onchange = loadApprovalList;
    document.getElementById('ap-status-save').onclick = onSaveSeasonStatus;
    sel.dataset.bound = '1';
  }

  await renderSeasonStatusSelect();
  await loadApprovalList();
}

/**
 * シーズン状態のプルダウンを用意し、現在の状態を選択状態にする。
 * 選択肢は GAS 側の SEASON_STATUSES を正とする。
 */
async function renderSeasonStatusSelect() {
  const seasonId = document.getElementById('ap-season').value;
  const sel = document.getElementById('ap-season-status');
  if (!sel) return;

  const res = await callApi('listSeasonStatuses', {});
  const list = res.ok ? res.data : [];

  sel.innerHTML = list
    .map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>')
    .join('');

  const seasons = await loadSeasons(true);
  const cur = seasons.find((s) => s.season_id === seasonId);
  if (cur) sel.value = cur.status;
}

/**
 * シーズン状態を変更する。
 * エントリー受付・移籍市場などのフェーズ切替に使う。
 */
async function onSaveSeasonStatus() {
  const seasonId = document.getElementById('ap-season').value;
  const status = document.getElementById('ap-season-status').value;
  if (!seasonId) return;

  const btn = document.getElementById('ap-status-save');
  btn.disabled = true;
  setResult('ap-status-result', true, '変更中...');

  const res = await callApi('setSeasonStatus', { season_id: seasonId, status });
  btn.disabled = false;

  if (res.ok) {
    setResult('ap-status-result', true, 'シーズン状態を「' + status + '」に変更しました。');
    cache.seasons = null;
    await loadSeasons(true);
  } else {
    setResult('ap-status-result', false, '変更できません: ' + res.error);
  }
}

/**
 * 全チームの提出状況を取得して表に描画する。
 */
async function loadApprovalList() {
  const seasonId = document.getElementById('ap-season').value;
  const box = document.getElementById('ap-body');

  if (!seasonId) {
    box.innerHTML = '<p class="muted">シーズンを選択してください。</p>';
    return;
  }

  setLoading('ap-body');

  const res = await callApi('listEntryLists', { season_id: seasonId });
  if (!res.ok) {
    setError('ap-body', '提出状況の取得に失敗しました: ' + res.error);
    return;
  }

  const badgeClass = {
    未提出: 'tag-none',
    提出済: 'tag-pending',
    承認: 'tag-ok',
    差戻: 'tag-ng',
  };

  const rows = res.data
    .map((e) => {
      const canAct = e.status === '提出済';
      return `
      <tr>
        <td>${esc(e.team_name)}</td>
        <td><span class="tag-kind">${esc(e.kind)}</span></td>
        <td><span class="${badgeClass[e.status] || 'tag-none'}">${esc(e.status)}</span></td>
        <td class="num">${e.count}</td>
        <td class="num muted">${e.pending}</td>
        <td class="num muted">${e.active}</td>
        <td>
          <button class="btn btn-sm btn-primary ap-approve" data-team="${esc(e.team_id)}" ${canAct ? '' : 'disabled'}>承認</button>
          <button class="btn btn-sm btn-secondary ap-reject" data-team="${esc(e.team_id)}" ${canAct ? '' : 'disabled'}>差戻</button>
        </td>
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>チーム</th><th>種別</th><th>状態</th>
            <th class="num">提出人数</th><th class="num">申請中</th><th class="num">在籍</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p id="ap-result" class="form-msg"></p>`;

  box.querySelectorAll('.ap-approve').forEach((b) => {
    b.onclick = () => onApprovalAction('approveEntryList', b.dataset.team, '承認');
  });
  box.querySelectorAll('.ap-reject').forEach((b) => {
    b.onclick = () => onApprovalAction('rejectEntryList', b.dataset.team, '差戻');
  });
}

/**
 * 承認／差戻を実行する。
 *
 * @param {string} action   approveEntryList | rejectEntryList
 * @param {string} teamId
 * @param {string} label    表示用の操作名
 */
async function onApprovalAction(action, teamId, label) {
  const seasonId = document.getElementById('ap-season').value;

  if (action === 'rejectEntryList') {
    if (!confirm('このチームのエントリーを差し戻します。申請中のスカッドは削除されます。よろしいですか？')) {
      return;
    }
  }

  setResult('ap-result', true, label + '中...');

  const res = await callApi(action, { season_id: seasonId, team_id: teamId });

  if (res.ok) {
    await loadApprovalList();
    setResult('ap-result', true, label + 'しました。');
  } else {
    setResult('ap-result', false, label + 'できません: ' + res.error);
  }
}

// ---------------------------------------------------------------------------
// 画面4: 移籍申請（Phase 3）
// ---------------------------------------------------------------------------

/** 直近に取得した移籍オプション */
let transferData = null;

/**
 * 移籍画面のシーズン／チーム選択を用意する。
 */
async function renderTransfer() {
  const seasons = await loadSeasons();
  fillSelect('tr-season', seasons, 'season_id', 'name');

  const seasonSel = document.getElementById('tr-season');
  const teamSel = document.getElementById('tr-team');

  if (currentUser.role === 'organizer') {
    fillSelect('tr-team', await loadTeams(), 'team_id', 'name', 'チームを選択');
    document.getElementById('tr-team-wrap').style.display = 'flex';
  } else {
    document.getElementById('tr-team-wrap').style.display = 'none';
  }

  if (!seasonSel.dataset.bound) {
    seasonSel.onchange = loadTransferOptions;
    teamSel.onchange = loadTransferOptions;
    document.getElementById('tr-method').onchange = onTransferMethodChange;
    document.getElementById('tr-pos').onchange = renderTransferPlayerSelect;
    document.getElementById('tr-player').onchange = updateTransferPreview;
    document.getElementById('tr-fee').oninput = updateTransferPreview;
    document.getElementById('tr-submit').onclick = onSubmitTransfer;
    bindMoneyEcho('tr-fee', 'tr-fee-echo');
    seasonSel.dataset.bound = '1';
  }

  await loadTransferOptions();
}

/**
 * 市場状況・予算・獲得候補を取得して画面を組み立てる。
 */
async function loadTransferOptions() {
  const seasonId = document.getElementById('tr-season').value;
  const teamId = document.getElementById('tr-team').value;
  const marketBox = document.getElementById('tr-market');
  const formWrap = document.getElementById('tr-form-wrap');

  transferData = null;
  formWrap.style.display = 'none';

  if (!seasonId) {
    marketBox.innerHTML = '<p class="muted">シーズンを選択してください。</p>';
    return;
  }
  if (currentUser.role === 'organizer' && !teamId) {
    marketBox.innerHTML = '<p class="muted">代理申請するチームを選択してください。</p>';
    document.getElementById('tr-list').innerHTML = '';
    return;
  }

  setLoading('tr-market');

  const res = await callApi('getTransferOptions', { season_id: seasonId, team_id: teamId });
  if (!res.ok) {
    setError('tr-market', '移籍情報の取得に失敗しました: ' + res.error);
    return;
  }

  transferData = res.data;
  renderTransferMarketBox();

  if (res.data.market_open) {
    formWrap.style.display = 'block';
    renderTransferMethodSelect();
    renderTransferPlayerSelect();
  }

  await loadTransferList();
}

/**
 * 市場の状況と自チームの予算・人数を表示する。
 */
function renderTransferMarketBox() {
  const d = transferData;
  const box = document.getElementById('tr-market');

  if (!d.market_open) {
    box.innerHTML =
      '<p class="msg-error">現在は移籍市場の期間外です（シーズン状態: ' +
      esc(d.season_status) + '）。移籍市場1 または 移籍市場2 の間だけ申請できます。</p>';
    return;
  }

  const b = d.budget || { balance: 0, reserved: 0, available: 0 };
  const s = d.squad || { active: 0, projected: 0 };

  const discountBadge = d.is_discount_time
    ? '<span class="tag-ok">割引時間帯</span>'
    : '<span class="tag-none">通常価格</span>';

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">移籍市場</span>
        <span class="stat-value">第${d.window}次 ${discountBadge}</span>
      </div>
      <div class="stat">
        <span class="stat-label">使える予算</span>
        <span class="stat-value">${esc(formatMoney(b.available))}</span>
      </div>
      <div class="stat">
        <span class="stat-label">承認待ちで確保中</span>
        <span class="stat-value stat-sm">${esc(formatMoney(b.reserved))}</span>
      </div>
      <div class="stat">
        <span class="stat-label">スカッド人数</span>
        <span class="stat-value stat-sm">${s.active} 名（見込み ${s.projected}）</span>
      </div>
    </div>
    <p class="muted note-sm">
      使える予算 = 残高 ${esc(formatMoney(b.balance))} − 承認待ちで確保中 ${esc(formatMoney(b.reserved))}。
      サーバー時刻 ${esc(String(d.server_time).replace('T', ' ').slice(0, 16))}
    </p>`;
}

/**
 * 移籍形態のプルダウンを組み立てる。
 * オークションは主催者が別画面で登録するため、ここには出さない。
 */
function renderTransferMethodSelect() {
  const sel = document.getElementById('tr-method');
  const list = transferData.methods.filter((m) => m.method !== 'オークション');

  sel.innerHTML = list
    .map((m) => {
      const cost = m.needs_fee ? '交渉額' : formatMoney(m.fixed_cost);
      const disc = m.discounted ? '・割引中' : '';
      return '<option value="' + esc(m.method) + '">' +
        esc(m.method) + '（' + esc(cost) + esc(disc) + '）</option>';
    })
    .join('');

  onTransferMethodChange();
}

/**
 * 形態に応じて交渉額の入力欄を出し分ける。
 */
function onTransferMethodChange() {
  const method = document.getElementById('tr-method').value;
  const info = (transferData.methods || []).find((m) => m.method === method);
  const feeWrap = document.getElementById('tr-fee-wrap');

  feeWrap.style.display = info && info.needs_fee ? 'flex' : 'none';
  renderTransferPlayerSelect();
}

/**
 * 対象選手のプルダウンを組み立てる（ポジション → 選手 の2段目）。
 *
 * 承認待ちの申請がある選手と、特別ルールでプロテクト中の選手は選べないようにする。
 * 最終的な可否判定は GAS 側でも行う。
 */
function renderTransferPlayerSelect() {
  if (!transferData) return;

  const pos = document.getElementById('tr-pos').value;
  const method = document.getElementById('tr-method').value;
  const sel = document.getElementById('tr-player');

  let list = (transferData.targets || []).slice();
  if (pos) list = list.filter((p) => p.position === pos);

  sel.innerHTML =
    '<option value="">選手を選択</option>' +
    list
      .map((p) => {
        const blockedPending = p.pending;
        const blockedProtect = method === '特別' && p.protected;
        const disabled = blockedPending || blockedProtect ? ' disabled' : '';

        let note = '';
        if (blockedPending) note = ' ⏳承認待ちあり';
        else if (blockedProtect) note = ' 🛡プロテクト中';
        else if (p.protected) note = ' 🛡';

        return '<option value="' + esc(p.player_id) + '"' + disabled + '>' +
          esc(p.position) + ' ' + esc(p.name) + '（' + esc(p.team_name) + '）' +
          esc(note) + '</option>';
      })
      .join('');

  updateTransferPreview();
}

/**
 * 選んだ形態と交渉額から、買い手支払・売り手受取をその場で表示する。
 *
 * これは操作性のための概算表示。確定額は申請時に GAS が再計算する。
 */
function updateTransferPreview() {
  const d = transferData;
  if (!d) return;

  const method = document.getElementById('tr-method').value;
  const info = (d.methods || []).find((m) => m.method === method);
  const box = document.getElementById('tr-preview');
  const btn = document.getElementById('tr-submit');
  if (!info) return;

  const playerId = document.getElementById('tr-player').value;
  const fee = unitToYen(document.getElementById('tr-fee').value);

  let cost;
  let payout;

  if (info.needs_fee) {
    cost = fee;
    payout = Math.round(fee * d.seller_rate_normal);
  } else {
    cost = info.fixed_cost;
    payout = info.payout;
  }

  const available = d.budget ? d.budget.available : 0;
  const enough = cost > 0 && cost <= available;
  const ready = !!playerId && enough;

  const rows = [
    ['買い手の支払', formatMoney(cost)],
    ['売り手の受取', formatMoney(payout)],
    ['申請後の使える予算', formatMoney(available - cost)],
  ];

  box.className = 'cost-preview ' + (ready ? 'cost-ok' : 'cost-ng');
  box.innerHTML =
    rows
      .map((r) => '<div><span class="muted">' + esc(r[0]) + '</span><strong>' + esc(r[1]) + '</strong></div>')
      .join('') +
    (info.discounted ? '<div class="cost-note">最終日割引が適用されています</div>' : '') +
    (!enough && cost > 0 ? '<div class="cost-note">使える予算を超えています</div>' : '') +
    (info.needs_seller_approval
      ? '<div class="cost-note">申請後、売り手チームの同意 → 主催者承認 の順に進みます</div>'
      : '<div class="cost-note">交渉なしの形態です。申請後すぐ主催者承認に進みます</div>');

  btn.disabled = !ready;
}

/**
 * 移籍を申請する。
 */
async function onSubmitTransfer() {
  const btn = document.getElementById('tr-submit');
  btn.disabled = true;
  setResult('tr-result', true, '送信中...');

  const res = await callApi('requestTransfer', {
    season_id: transferData.season_id,
    // GAS 側は to_team で受け取る（team_id ではない）
    to_team: transferData.team_id,
    player_id: document.getElementById('tr-player').value,
    method: document.getElementById('tr-method').value,
    gross_fee: unitToYen(document.getElementById('tr-fee').value),
  });

  if (res.ok) {
    const d = res.data;
    setResult(
      'tr-result',
      true,
      '申請しました（' + formatMoney(d.cost_to_buyer) + '）。状態: ' + d.status +
        (d.discounted ? ' ※割引適用' : '')
    );
    document.getElementById('tr-fee').value = '';
    await loadTransferOptions();
  } else {
    setResult('tr-result', false, '申請できません: ' + res.error);
    btn.disabled = false;
  }
}

/**
 * 自チームが関与する移籍の一覧を描画する。
 */
async function loadTransferList() {
  const seasonId = document.getElementById('tr-season').value;
  const box = document.getElementById('tr-list');
  if (!seasonId) return;

  setLoading('tr-list');

  const res = await callApi('listTransfers', { season_id: seasonId });
  if (!res.ok) {
    setError('tr-list', '移籍一覧の取得に失敗しました: ' + res.error);
    return;
  }
  if (res.data.length === 0) {
    box.innerHTML = '<p class="muted">移籍の記録はまだありません。</p>';
    return;
  }

  box.innerHTML = renderTransferTable(res.data, true) + '<p id="tr-list-result" class="form-msg"></p>';

  box.querySelectorAll('.tr-agree').forEach((b) => {
    b.onclick = () => onRespondTransfer(b.dataset.id, true);
  });
  box.querySelectorAll('.tr-decline').forEach((b) => {
    b.onclick = () => onRespondTransfer(b.dataset.id, false);
  });
}

/**
 * 移籍テーブルの HTML を組み立てる。
 *
 * @param {Object[]} rows
 * @param {boolean} withRespond 売り手応答ボタンを出すか
 * @returns {string}
 */
function renderTransferTable(rows, withRespond) {
  const badge = {
    売り手承認待ち: 'tag-pending',
    主催者承認待ち: 'tag-pending',
    承認: 'tag-ok',
    売り手拒否: 'tag-ng',
    差戻: 'tag-ng',
  };

  const body = rows
    .map((t) => {
      let actions = '';
      if (withRespond && t.can_respond) {
        actions =
          '<button class="btn btn-sm btn-primary tr-agree" data-id="' + esc(t.transfer_id) + '">同意</button> ' +
          '<button class="btn btn-sm btn-secondary tr-decline" data-id="' + esc(t.transfer_id) + '">拒否</button>';
      }

      return `
      <tr>
        <td>${esc(t.player_name)}</td>
        <td class="muted">${esc(t.from_team_name || '—')} → ${esc(t.to_team_name)}</td>
        <td>${esc(t.method)}</td>
        <td class="num">${esc(formatMoney(t.cost_to_buyer))}</td>
        <td class="num">${esc(formatMoney(t.payout_to_seller))}</td>
        <td><span class="${badge[t.status] || 'tag-none'}">${esc(t.status)}</span></td>
        ${withRespond ? '<td>' + actions + '</td>' : ''}
      </tr>`;
    })
    .join('');

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>選手</th><th>移籍</th><th>形態</th>
            <th class="num">買い手支払</th><th class="num">売り手受取</th><th>状態</th>
            ${withRespond ? '<th>操作</th>' : ''}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/**
 * 売り手として同意 / 拒否する。
 *
 * @param {string} transferId
 * @param {boolean} agree
 */
async function onRespondTransfer(transferId, agree) {
  if (!agree && !confirm('この移籍を拒否します。よろしいですか？')) return;

  setResult('tr-list-result', true, (agree ? '同意' : '拒否') + '中...');

  const res = await callApi('respondTransfer', { transfer_id: transferId, agree });

  if (res.ok) {
    await loadTransferList();
    setResult('tr-list-result', true, '状態を「' + res.data.status + '」に更新しました。');
  } else {
    setResult('tr-list-result', false, '失敗: ' + res.error);
  }
}

// ---------------------------------------------------------------------------
// 画面5: 移籍承認（主催者限定）
// ---------------------------------------------------------------------------

/**
 * 移籍承認画面を用意する。
 */
async function renderTxApproval() {
  if (currentUser.role !== 'organizer') return;

  const seasons = await loadSeasons();
  fillSelect('ta-season', seasons, 'season_id', 'name');
  fillSelect('au-team', await loadTeams(), 'team_id', 'name', 'チームを選択');

  const sel = document.getElementById('ta-season');
  if (!sel.dataset.bound) {
    sel.onchange = loadTxApprovalList;
    document.getElementById('ta-pending-only').onchange = loadTxApprovalList;
    document.getElementById('au-submit').onclick = onSubmitAuction;
    bindMoneyEcho('au-fee', 'au-fee-echo');
    sel.dataset.bound = '1';
  }

  await loadTxApprovalList();
}

/**
 * 移籍一覧を取得し、承認／差戻ボタン付きで描画する。
 * あわせてオークション用のフリー選手プルダウンも更新する。
 */
async function loadTxApprovalList() {
  const seasonId = document.getElementById('ta-season').value;
  const pendingOnly = document.getElementById('ta-pending-only').checked;
  const box = document.getElementById('ta-body');

  if (!seasonId) {
    box.innerHTML = '<p class="muted">シーズンを選択してください。</p>';
    return;
  }

  setLoading('ta-body');

  const [txRes, optRes] = await Promise.all([
    callApi('listTransfers', { season_id: seasonId, pending_only: pendingOnly }),
    callApi('getTransferOptions', { season_id: seasonId }),
  ]);

  if (!txRes.ok) {
    setError('ta-body', '移籍一覧の取得に失敗しました: ' + txRes.error);
    return;
  }

  // オークション対象（どのチームにも在籍していない選手）
  if (optRes.ok) {
    const free = (optRes.data.free_agents || []).filter((p) => !p.pending);
    const sel = document.getElementById('au-player');
    sel.innerHTML =
      '<option value="">選手を選択</option>' +
      free
        .map((p) => '<option value="' + esc(p.player_id) + '">' +
          esc(p.position) + ' ' + esc(p.name) + '</option>')
        .join('');
  }

  if (txRes.data.length === 0) {
    box.innerHTML = '<p class="muted">' +
      (pendingOnly ? '未確定の移籍はありません。' : '移籍の記録はまだありません。') + '</p>';
    return;
  }

  const rows = txRes.data
    .map((t) => {
      const wait = t.status === '売り手承認待ち'
        ? '<span class="muted">売り手の応答待ち</span>'
        : '';
      const actions = t.can_approve
        ? '<button class="btn btn-sm btn-primary ta-approve" data-id="' + esc(t.transfer_id) + '">承認</button> '
        : wait;
      const rejectable = t.status === '売り手承認待ち' || t.status === '主催者承認待ち';
      const reject = rejectable
        ? '<button class="btn btn-sm btn-secondary ta-reject" data-id="' + esc(t.transfer_id) + '">差戻</button>'
        : '';

      const badge = {
        売り手承認待ち: 'tag-pending',
        主催者承認待ち: 'tag-pending',
        承認: 'tag-ok',
        売り手拒否: 'tag-ng',
        差戻: 'tag-ng',
      };

      return `
      <tr>
        <td>${esc(t.player_name)}</td>
        <td class="muted">${esc(t.from_team_name || '—')} → ${esc(t.to_team_name)}</td>
        <td>${esc(t.method)}<span class="muted"> 第${t.window}次</span></td>
        <td class="num neg">${esc(formatMoney(-t.cost_to_buyer))}</td>
        <td class="num pos">${t.payout_to_seller > 0 ? esc(formatMoney(t.payout_to_seller)) : '—'}</td>
        <td><span class="${badge[t.status] || 'tag-none'}">${esc(t.status)}</span></td>
        <td>${actions}${reject}</td>
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>選手</th><th>移籍</th><th>形態</th>
            <th class="num">買い手支払</th><th class="num">売り手受取</th>
            <th>状態</th><th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p id="ta-result" class="form-msg"></p>`;

  box.querySelectorAll('.ta-approve').forEach((b) => {
    b.onclick = () => onTxApprovalAction('approveTransfer', b.dataset.id, '承認');
  });
  box.querySelectorAll('.ta-reject').forEach((b) => {
    b.onclick = () => onTxApprovalAction('rejectTransfer', b.dataset.id, '差戻');
  });
}

/**
 * 移籍の承認／差戻を実行する。
 *
 * @param {string} action approveTransfer | rejectTransfer
 * @param {string} transferId
 * @param {string} label
 */
async function onTxApprovalAction(action, transferId, label) {
  if (action === 'approveTransfer') {
    if (!confirm('この移籍を承認します。スカッドと予算がその場で更新されます。よろしいですか？')) {
      return;
    }
  } else if (!confirm('この移籍を差し戻します。よろしいですか？')) {
    return;
  }

  setResult('ta-result', true, label + '中...');

  const res = await callApi(action, { transfer_id: transferId });

  if (res.ok) {
    await loadTxApprovalList();
    const d = res.data;
    setResult(
      'ta-result',
      true,
      label + 'しました。' +
        (action === 'approveTransfer'
          ? '買い手 −' + formatMoney(d.cost_to_buyer) +
            ' / 売り手 +' + formatMoney(d.payout_to_seller)
          : '')
    );
  } else {
    setResult('ta-result', false, label + 'できません: ' + res.error);
  }
}

/**
 * オークション結果を登録する。
 */
async function onSubmitAuction() {
  const btn = document.getElementById('au-submit');
  const seasonId = document.getElementById('ta-season').value;
  const teamId = document.getElementById('au-team').value;
  const playerId = document.getElementById('au-player').value;
  const fee = unitToYen(document.getElementById('au-fee').value);

  if (!teamId || !playerId) {
    setResult('au-result', false, '落札チームと選手を選んでください。');
    return;
  }

  btn.disabled = true;
  setResult('au-result', true, '登録中...');

  const res = await callApi('registerAuction', {
    season_id: seasonId,
    to_team: teamId,
    player_id: playerId,
    gross_fee: fee,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('au-result', true, '登録しました。上の一覧から承認してください。');
    document.getElementById('au-fee').value = '';
    await loadTxApprovalList();
  } else {
    setResult('au-result', false, '登録できません: ' + res.error);
  }
}
