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
  ['tab-master', 'tab-approval', 'tab-txapproval', 'tab-season', 'tab-signup'].forEach((id) => {
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
  if (name === 'protect') renderProtect();
  if (name === 'match') renderMatch();
  if (name === 'stats') renderStats();
  if (name === 'season') renderSeasonAdmin();
  if (name === 'signup') renderSignupAdmin();
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
 * X（旧Twitter）のプロフィールリンクを HTML で返す。
 *
 * 試合連絡と移籍交渉は X で行うため、相手のIDが分かる場所には
 * 必ずこのリンクを出す。ID が未設定なら「—」を返す。
 *
 * target="_blank" には rel="noopener" を必ず付ける
 * （開いた先のページから window.opener を触られないようにするため）。
 *
 * @param {string} xId
 * @returns {string} HTML
 */
function xLinkHtml(xId) {
  const id = String(xId || '').trim();
  if (!id) return '<span class="muted">—</span>';
  return '<a class="x-link" href="https://x.com/' + encodeURIComponent(id) +
    '" target="_blank" rel="noopener noreferrer">@' + esc(id) + '</a>';
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
    ${renderProfileEditor()}
  `;

  bindProfileEditor();
}

/**
 * 自分の X ID を設定する欄を返す。
 *
 * 他チームから交渉の連絡が来る窓口になるので、
 * 未設定の場合は目立つように注意書きを出す。
 *
 * @returns {string} HTML
 */
function renderProfileEditor() {
  const xid = currentUser.x_id || '';

  return `
    <h3 class="sub-head">連絡先（X）</h3>
    <p class="muted">
      試合日程の連絡と移籍交渉は X で行います。
      ここで設定した ID は参加者一覧と公開ページに表示されます。
    </p>
    ${xid
      ? '<p>現在の設定: ' + xLinkHtml(xid) + '</p>'
      : '<p class="form-msg msg-error">X ID が未設定です。相手から連絡が取れません。</p>'}
    <div class="form-grid">
      <label>
        X の ID
        <input type="text" id="pf-x" value="${esc(xid ? '@' + xid : '')}"
               placeholder="例: @gm_league / https://x.com/gm_league" />
        <span class="unit-hint">@ や URL のまま貼っても構いません。</span>
      </label>
      <div class="form-actions">
        <button type="button" id="pf-save" class="btn btn-primary">保存する</button>
        <span id="pf-result" class="form-msg"></span>
      </div>
    </div>`;
}

/**
 * プロフィール編集のボタンを結線する。
 * ダッシュボードは描画のたびに DOM を作り直すので毎回呼ぶ。
 */
function bindProfileEditor() {
  const btn = document.getElementById('pf-save');
  if (!btn) return;
  btn.onclick = onSaveProfile;
}

/**
 * 自分の X ID を保存する。
 */
async function onSaveProfile() {
  const btn = document.getElementById('pf-save');
  btn.disabled = true;
  setResult('pf-result', true, '保存中...');

  const res = await callApi('updateMyProfile', {
    x_id: document.getElementById('pf-x').value.trim(),
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('pf-result', false, '保存できません: ' + res.error);
    return;
  }

  currentUser.x_id = res.data.x_id;
  setResult('pf-result', true, res.data.x_id ? '保存しました。' : 'X ID を消しました。');
  await renderDashboard();
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

  // 交渉相手にすぐ連絡できるよう、オーナーの X をここに出す
  const team = (cache.teams || []).find((t) => t.team_id === teamId) || {};

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">オーナー</span>
        <span class="stat-value stat-sm">
          ${esc(team.owner_name || '—')}<br>${xLinkHtml(team.owner_x_id)}
        </span>
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
  setResult('tm-result', true, '送信中...');

  const res = await callApi('upsertTeam', {
    name: document.getElementById('tm-name').value.trim(),
    kind: document.getElementById('tm-kind').value,
    active: document.getElementById('tm-active').checked,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('tm-result', true, '登録しました。');
    e.target.reset();
    document.getElementById('tm-active').checked = true;
    await renderMaster();
  } else {
    setResult('tm-result', false, '失敗: ' + res.error);
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

  // 交渉相手のオーナーに X で連絡できるようにする
  const teamById = {};
  (cache.teams || []).forEach((t) => { teamById[t.team_id] = t; });

  const counterparty = (t) => {
    // 自分が買い手なら相手は売り手。逆も同じ。主催者にはどちらも「相手」ではない
    const myTeam = currentUser.team_id;
    const otherId = t.to_team === myTeam ? t.from_team : t.to_team;
    const other = teamById[otherId];
    if (!other) return '<span class="muted">—</span>';
    return xLinkHtml(other.owner_x_id);
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
        ${withRespond ? '<td>' + counterparty(t) + '</td>' : ''}
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
            ${withRespond ? '<th>相手のX</th>' : ''}
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

// ---------------------------------------------------------------------------
// 画面5: プロテクト（Phase 4）
// ---------------------------------------------------------------------------

/** 直近に取得したプロテクト状況 */
let protectData = null;

/**
 * プロテクト画面のシーズン／チーム選択を用意する。
 */
async function renderProtect() {
  const seasons = await loadSeasons();
  fillSelect('pr-season', seasons, 'season_id', 'name');

  const seasonSel = document.getElementById('pr-season');
  const teamSel = document.getElementById('pr-team');

  if (currentUser.role === 'organizer') {
    fillSelect('pr-team', await loadTeams(), 'team_id', 'name', 'チームを選択');
    document.getElementById('pr-team-wrap').style.display = 'flex';
  } else {
    document.getElementById('pr-team-wrap').style.display = 'none';
  }

  if (!seasonSel.dataset.bound) {
    seasonSel.onchange = loadProtectStatus;
    teamSel.onchange = loadProtectStatus;
    document.getElementById('pr-submit').onclick = onSubmitProtection;
    document.getElementById('pb-window').onchange = loadProtectionBoard;
    seasonSel.dataset.bound = '1';
  }

  await loadProtectStatus();
}

/**
 * 現在のフェーズ・残枠・設定可能な選手を取得して描画する。
 */
async function loadProtectStatus() {
  const seasonId = document.getElementById('pr-season').value;
  const teamId = document.getElementById('pr-team').value;
  const statusBox = document.getElementById('pr-status');
  const form = document.getElementById('pr-form');

  protectData = null;
  form.style.display = 'none';
  document.getElementById('pr-mine').innerHTML = '';

  if (!seasonId) {
    statusBox.innerHTML = '<p class="muted">シーズンを選択してください。</p>';
    return;
  }

  setLoading('pr-status');

  const res = await callApi('getProtectionStatus', { season_id: seasonId, team_id: teamId });
  if (!res.ok) {
    setError('pr-status', 'プロテクト状況の取得に失敗しました: ' + res.error);
    return;
  }

  protectData = res.data;
  renderProtectStatusBox();

  if (res.data.team_id) {
    renderMyProtections();
    if (res.data.can_set) {
      form.style.display = 'block';
      renderProtectPlayerSelect();
    }
  }

  await loadProtectionBoard();
}

/**
 * フェーズ・期間・残枠・次の料金を表示する。
 */
function renderProtectStatusBox() {
  const d = protectData;
  const box = document.getElementById('pr-status');

  const phaseClass = {
    無料: 'tag-ok',
    有料: 'tag-pending',
    受付外: 'tag-none',
  }[d.phase] || 'tag-none';

  const fmt = (iso) => (iso ? String(iso).replace('T', ' ').slice(5, 16) : '—');

  let periodInfo = '';
  if (d.periods) {
    periodInfo = `
      <p class="muted note-sm">
        第${d.window}次の受付期間 —
        無料: 〜 ${esc(fmt(d.periods.free_end))} ／
        有料: ${esc(fmt(d.periods.paid_start))} 〜 ${esc(fmt(d.periods.paid_end))}
      </p>`;
  }

  let usageBlock = '';
  if (d.usage) {
    usageBlock = `
      <div class="stat">
        <span class="stat-label">無料枠</span>
        <span class="stat-value">${d.usage.free} / ${d.free_max}</span>
      </div>
      <div class="stat">
        <span class="stat-label">有料枠</span>
        <span class="stat-value">${d.usage.paid} / ${d.paid_max}</span>
      </div>`;
  }

  let nextBlock = '';
  if (d.next_tier) {
    const feeText = d.next_tier.fee > 0 ? formatMoney(d.next_tier.fee) : '無料';
    nextBlock = `
      <div class="stat">
        <span class="stat-label">次に設定する枠</span>
        <span class="stat-value">${esc(d.next_tier.tier)}<span class="stat-sm"> ${esc(feeText)}</span></span>
      </div>`;
  }

  let notice = '';
  if (d.phase === '受付外') {
    notice = '<p class="msg-error">現在はプロテクトの受付期間外です。</p>';
  } else if (d.team_id && !d.can_set) {
    notice = '<p class="msg-ok">' + esc(d.phase) + '枠をすべて使い切っています。</p>';
  } else if (d.phase === '有料') {
    notice =
      '<p class="msg-error">有料枠は<strong>設定した瞬間に料金が引かれ、後から解除できません。</strong>' +
      '選手をよく確認してください。</p>';
  }

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">現在のフェーズ</span>
        <span class="stat-value">第${d.window || '—'}次 <span class="${phaseClass}">${esc(d.phase)}</span></span>
      </div>
      ${usageBlock}
      ${nextBlock}
    </div>
    ${periodInfo}
    ${notice}`;
}

/**
 * プロテクト可能な選手のプルダウンを組み立てる。
 */
function renderProtectPlayerSelect() {
  const sel = document.getElementById('pr-player');
  const list = protectData.protectable || [];

  sel.innerHTML =
    '<option value="">選手を選択</option>' +
    list
      .map((p) => '<option value="' + esc(p.player_id) + '">' +
        esc(p.position) + ' ' + esc(p.name) + '</option>')
      .join('');
}

/**
 * 自チームの設定済みプロテクトを一覧表示する。
 */
function renderMyProtections() {
  const d = protectData;
  const box = document.getElementById('pr-mine');

  if (!d.my_protections || d.my_protections.length === 0) {
    box.innerHTML = '<h3 class="sub-head">設定済み</h3><p class="muted">まだ設定していません。</p>';
    return;
  }

  const rows = d.my_protections
    .map((p) => `
      <tr>
        <td><span class="pos pos-${esc(p.position)}">${esc(p.position)}</span></td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.tier)}</td>
        <td class="num">${p.fee > 0 ? esc(formatMoney(p.fee)) : '無料'}</td>
        <td class="muted">${esc(String(p.set_at).replace('T', ' ').slice(5, 16))}</td>
      </tr>`)
    .join('');

  box.innerHTML = `
    <h3 class="sub-head">設定済み（第${d.window}次）</h3>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Pos</th><th>選手</th><th>枠</th><th class="num">料金</th><th>設定日時</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">プロテクトは解除できません。放出しても枠は戻りません。</p>`;
}

/**
 * プロテクトを設定する。
 * 有料枠は取り消せないので、料金と選手名を明示して確認を取る。
 */
async function onSubmitProtection() {
  const d = protectData;
  const sel = document.getElementById('pr-player');
  const playerId = sel.value;

  if (!playerId) {
    setResult('pr-result', false, '選手を選んでください。');
    return;
  }

  const playerName = sel.options[sel.selectedIndex].text;
  const tier = d.next_tier.tier;
  const fee = d.next_tier.fee;

  const confirmMsg =
    playerName + ' を「' + tier + '」でプロテクトします。\n' +
    (fee > 0
      ? '料金 ' + formatMoney(fee) + ' が今すぐ予算から引かれます。\n'
      : '料金はかかりません。\n') +
    '\n※ 一度設定すると解除できません。放出しても枠は戻りません。\n\n実行しますか？';

  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById('pr-submit');
  btn.disabled = true;
  setResult('pr-result', true, '設定中...');

  const res = await callApi('setProtection', {
    season_id: d.season_id,
    team_id: d.team_id,
    player_id: playerId,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult(
      'pr-result',
      true,
      res.data.tier + ' で設定しました' +
        (res.data.fee > 0 ? '（' + formatMoney(res.data.fee) + ' を計上）' : '') + '。'
    );
    await loadProtectStatus();
  } else {
    setResult('pr-result', false, '設定できません: ' + res.error);
  }
}

/**
 * プロテクト掲示を描画する。全ロールが閲覧できる。
 */
async function loadProtectionBoard() {
  const seasonId = document.getElementById('pr-season').value;
  const windowNo = document.getElementById('pb-window').value;
  const box = document.getElementById('pb-body');
  if (!seasonId) return;

  setLoading('pb-body');

  const res = await callApi('getProtections', {
    season_id: seasonId,
    window: windowNo ? Number(windowNo) : 0,
  });

  if (!res.ok) {
    setError('pb-body', 'プロテクト掲示の取得に失敗しました: ' + res.error);
    return;
  }
  if (res.data.length === 0) {
    box.innerHTML = '<p class="muted">プロテクトされている選手はいません。</p>';
    return;
  }

  const rows = res.data
    .map((p) => `
      <tr>
        <td>第${p.window}次</td>
        <td>${esc(p.team_name)}</td>
        <td><span class="pos pos-${esc(p.position)}">${esc(p.position)}</span></td>
        <td>${esc(p.name)}${p.still_on_team ? '' : ' <span class="tag-ng">放出済</span>'}</td>
        <td>${esc(p.tier)}</td>
        <td class="num muted">${p.fee > 0 ? esc(formatMoney(p.fee)) : '—'}</td>
      </tr>`)
    .join('');

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>市場</th><th>チーム</th><th>Pos</th><th>選手</th><th>枠</th><th class="num">料金</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">「放出済」は設定後に移籍などで抜けた選手です。枠は戻りません。</p>`;
}

// ---------------------------------------------------------------------------
// 画面6: 試合（Phase 5）
// ---------------------------------------------------------------------------

/** 申請フォーム用に取得した両軍の選手など */
let matchOptions = null;

/** 訂正モードのときの match_id。通常の申請時は null */
let correctingMatchId = null;

/** GK 入力欄の行数（チームごと） */
let gkRowSeq = 0;

/**
 * 試合画面を初期化する。
 */
async function renderMatch() {
  const seasons = await loadSeasons();
  fillSelect('mt-season', seasons, 'season_id', 'name');

  const teams = await loadTeams();
  fillSelect('mt-home', teams, 'team_id', 'name', 'チームを選択');
  fillSelect('mt-away', teams, 'team_id', 'name', 'チームを選択');

  const seasonSel = document.getElementById('mt-season');
  if (!seasonSel.dataset.bound) {
    seasonSel.onchange = () => { loadMatchOptions(); loadMatchList(); };
    document.getElementById('mt-stage').onchange = onMatchStageChange;
    document.getElementById('mt-home').onchange = loadMatchOptions;
    document.getElementById('mt-away').onchange = loadMatchOptions;
    document.getElementById('mt-home-score').oninput = renderGoalRows;
    document.getElementById('mt-away-score').oninput = renderGoalRows;
    document.getElementById('mt-add-gk').onclick = () => addGkRow();
    document.getElementById('mt-submit').onclick = onSubmitMatch;
    document.getElementById('mt-cancel').onclick = exitCorrectionMode;
    document.getElementById('mt-filter').onchange = loadMatchList;
    seasonSel.dataset.bound = '1';
  }

  onMatchStageChange();
  await loadMatchOptions();
  await loadMatchList();
}

/**
 * 試合種別の短縮表示。
 *
 * @param {string} stage
 * @returns {string}
 */
function _stageLabel(stage) {
  if (stage === 'tournament') return '杯';
  if (stage === 'supercup') return 'SC';
  return 'L';
}

/**
 * 種別の切り替え。ノックアウトのときだけ tie_id / レグ / PK を出す。
 */
function onMatchStageChange() {
  // スーパーカップも1試合のノックアウトなので tie_id / PK を使う
  const stage = document.getElementById('mt-stage').value;
  const isKnockout = stage === 'tournament' || stage === 'supercup';
  document.getElementById('mt-tie-row').style.display = isKnockout ? 'flex' : 'none';
  document.getElementById('mt-pk-row').style.display = isKnockout ? 'flex' : 'none';
}

/**
 * 両軍の選手一覧を取得し、得点者・GK のプルダウンを組み直す。
 */
async function loadMatchOptions() {
  const seasonId = document.getElementById('mt-season').value;
  const home = document.getElementById('mt-home').value;
  const away = document.getElementById('mt-away').value;

  if (!seasonId) return;

  const res = await callApi('getMatchOptions', {
    season_id: seasonId,
    home_team: home,
    away_team: away,
  });

  if (!res.ok) {
    setResult('mt-result', false, '選手情報の取得に失敗しました: ' + res.error);
    return;
  }

  matchOptions = res.data;

  // team ロールは自チームを自動で埋める
  if (!home && !away && matchOptions.my_team) {
    document.getElementById('mt-home').value = matchOptions.my_team;
    return loadMatchOptions();
  }

  renderGoalRows();
  renderShotInputs();
  if (document.querySelectorAll('.gk-row').length === 0) {
    const t = currentMatchTeams();
    if (t.home) addGkRow(t.home);
    if (t.away) addGkRow(t.away);
  }
}

/**
 * 選択中のチームIDと表示名を返す。
 *
 * @returns {{home: string, away: string, homeName: string, awayName: string}}
 */
function currentMatchTeams() {
  const homeSel = document.getElementById('mt-home');
  const awaySel = document.getElementById('mt-away');
  return {
    home: homeSel.value,
    away: awaySel.value,
    homeName: homeSel.value ? homeSel.options[homeSel.selectedIndex].text : 'ホーム',
    awayName: awaySel.value ? awaySel.options[awaySel.selectedIndex].text : 'アウェイ',
  };
}

/**
 * 選手プルダウンの option 群を組み立てる。
 *
 * @param {Object[]} players
 * @param {boolean} withOwnGoal オウンゴールの選択肢を入れるか
 * @param {string} [selected]
 * @returns {string}
 */
function playerOptions(players, withOwnGoal, selected) {
  let html = '<option value="">選択</option>';
  if (withOwnGoal) {
    html += '<option value="' + esc(matchOptions.own_goal_id) + '">— オウンゴール —</option>';
  }
  (players || []).forEach((p) => {
    const mark = p.current ? '' : '（離脱）';
    html +=
      '<option value="' + esc(p.player_id) + '"' +
      (selected === p.player_id ? ' selected' : '') + '>' +
      esc(p.position) + ' ' + esc(p.name) + esc(mark) + '</option>';
  });
  return html;
}

/**
 * スコアの数だけ得点者の入力行を生成する。
 *
 * 行数をスコアに連動させることで、件数の不一致が構造的に起きなくなる。
 * 既に選ばれている内容はできるだけ引き継ぐ。
 */
function renderGoalRows() {
  const box = document.getElementById('mt-goals');
  if (!matchOptions) return;

  const t = currentMatchTeams();
  const homeScore = Math.max(0, Number(document.getElementById('mt-home-score').value) || 0);
  const awayScore = Math.max(0, Number(document.getElementById('mt-away-score').value) || 0);

  // 既存の入力を保持する
  const prev = [...box.querySelectorAll('.goal-row')].map((r) => ({
    team: r.dataset.team,
    scorer: r.querySelector('.goal-scorer').value,
    assist: r.querySelector('.goal-assist').value,
  }));

  const pick = (team, n) => {
    const same = prev.filter((p) => p.team === team);
    return same[n] || { scorer: '', assist: '' };
  };

  if (homeScore + awayScore === 0) {
    box.innerHTML = '<p class="muted">スコアを入力すると得点者の欄が出ます。</p>';
    return;
  }

  let html = '';
  const build = (teamId, teamName, players, count) => {
    for (let i = 0; i < count; i++) {
      const p = pick(teamId, i);
      html += `
        <div class="goal-row" data-team="${esc(teamId)}">
          <span class="goal-team">${esc(teamName)}</span>
          <label>得点者
            <select class="goal-scorer">${playerOptions(players, true, p.scorer)}</select>
          </label>
          <label>アシスト
            <select class="goal-assist">${playerOptions(players, false, p.assist)}</select>
          </label>
        </div>`;
    }
  };

  build(t.home, t.homeName, matchOptions.home_players, homeScore);
  build(t.away, t.awayName, matchOptions.away_players, awayScore);

  box.innerHTML = html;

  // オウンゴールを選んだらアシストを無効にする
  box.querySelectorAll('.goal-row').forEach((row) => {
    const scorer = row.querySelector('.goal-scorer');
    const assist = row.querySelector('.goal-assist');
    const sync = () => {
      const isOg = scorer.value === matchOptions.own_goal_id;
      assist.disabled = isOg;
      if (isOg) assist.value = '';
    };
    scorer.onchange = sync;
    sync();
  });
}

/**
 * シュート数の入力欄を組み立てる。
 */
function renderShotInputs() {
  const t = currentMatchTeams();
  const box = document.getElementById('mt-shots');

  const prev = {};
  box.querySelectorAll('.shot-input').forEach((i) => { prev[i.dataset.key] = i.value; });

  const side = (teamId, teamName) => `
    <div class="shot-side">
      <span class="goal-team">${esc(teamName)}</span>
      <label>シュート
        <input type="number" min="0" class="shot-input" data-key="${esc(teamId)}_shots"
               data-team="${esc(teamId)}" data-kind="shots" value="${esc(prev[teamId + '_shots'] || 0)}" />
      </label>
      <label>枠内
        <input type="number" min="0" class="shot-input" data-key="${esc(teamId)}_on"
               data-team="${esc(teamId)}" data-kind="on" value="${esc(prev[teamId + '_on'] || 0)}" />
      </label>
    </div>`;

  box.innerHTML = side(t.home, t.homeName) + side(t.away, t.awayName);
}

/**
 * GK の入力行を1つ追加する。
 *
 * @param {string} [teamId] 初期選択するチーム
 * @param {string} [playerId]
 * @param {number} [saves]
 */
function addGkRow(teamId, playerId, saves) {
  const t = currentMatchTeams();
  const box = document.getElementById('mt-gks');
  const id = 'gk' + ++gkRowSeq;

  const row = document.createElement('div');
  row.className = 'gk-row';
  row.dataset.id = id;
  row.innerHTML = `
    <label>チーム
      <select class="gk-team">
        <option value="${esc(t.home)}">${esc(t.homeName)}</option>
        <option value="${esc(t.away)}">${esc(t.awayName)}</option>
      </select>
    </label>
    <label>起用GK<select class="gk-player"></select></label>
    <label>セーブ<input type="number" min="0" class="gk-saves" value="${esc(saves || 0)}" /></label>
    <button type="button" class="btn btn-secondary btn-sm gk-remove">削除</button>`;

  box.appendChild(row);

  const teamSel = row.querySelector('.gk-team');
  if (teamId) teamSel.value = teamId;

  const fillPlayers = () => {
    const isHome = teamSel.value === t.home;
    const players = isHome ? matchOptions.home_players : matchOptions.away_players;
    row.querySelector('.gk-player').innerHTML = playerOptions(players, false, playerId);
  };

  teamSel.onchange = fillPlayers;
  row.querySelector('.gk-remove').onclick = () => row.remove();
  fillPlayers();
}

/**
 * フォームの内容を submitMatchResult / correctMatch の payload に変換する。
 *
 * @returns {Object}
 */
function collectMatchPayload() {
  const t = currentMatchTeams();
  const stage = document.getElementById('mt-stage').value;

  const goals = [...document.querySelectorAll('.goal-row')].map((r) => ({
    team_id: r.dataset.team,
    scorer_id: r.querySelector('.goal-scorer').value,
    assist_id: r.querySelector('.goal-assist').value,
  }));

  const shots = {};
  document.querySelectorAll('.shot-input').forEach((i) => {
    const tid = i.dataset.team;
    if (!shots[tid]) shots[tid] = { team_id: tid, shots: 0, shots_on_target: 0 };
    if (i.dataset.kind === 'shots') shots[tid].shots = Number(i.value) || 0;
    else shots[tid].shots_on_target = Number(i.value) || 0;
  });

  const gkStats = [...document.querySelectorAll('.gk-row')]
    .map((r) => ({
      team_id: r.querySelector('.gk-team').value,
      gk_player_id: r.querySelector('.gk-player').value,
      saves: Number(r.querySelector('.gk-saves').value) || 0,
    }))
    .filter((g) => g.gk_player_id);

  const payload = {
    season_id: document.getElementById('mt-season').value,
    stage,
    round: document.getElementById('mt-round').value.trim(),
    home_team: t.home,
    away_team: t.away,
    home_score: Number(document.getElementById('mt-home-score').value) || 0,
    away_score: Number(document.getElementById('mt-away-score').value) || 0,
    goals,
    team_stats: Object.keys(shots).map((k) => shots[k]),
    gk_stats: gkStats,
  };

  if (stage === 'tournament' || stage === 'supercup') {
    payload.tie_id = document.getElementById('mt-tie').value.trim();
    payload.leg = document.getElementById('mt-leg').value;
    payload.home_pk = document.getElementById('mt-home-pk').value;
    payload.away_pk = document.getElementById('mt-away-pk').value;
  }

  return payload;
}

/**
 * 試合を申請、または訂正モードなら訂正する。
 */
async function onSubmitMatch() {
  const btn = document.getElementById('mt-submit');
  const payload = collectMatchPayload();

  // 得点者の未選択はサーバーに投げる前に気づけるようにする
  const missing = payload.goals.some((g) => !g.scorer_id);
  if (missing) {
    setResult('mt-result', false, '得点者が選ばれていない行があります。');
    return;
  }

  btn.disabled = true;
  setResult('mt-result', true, '送信中...');

  let res;
  if (correctingMatchId) {
    payload.match_id = correctingMatchId;
    res = await callApi('correctMatch', payload);
  } else {
    res = await callApi('submitMatchResult', payload);
  }

  btn.disabled = false;

  if (res.ok) {
    setResult(
      'mt-result',
      true,
      correctingMatchId ? '訂正しました。' : '申請しました。主催者の承認をお待ちください。'
    );
    if (correctingMatchId) exitCorrectionMode();
    await loadMatchList();
  } else {
    setResult('mt-result', false, (correctingMatchId ? '訂正' : '申請') + 'できません: ' + res.error);
  }
}

/**
 * 訂正モードを抜けてフォームを申請用に戻す。
 */
function exitCorrectionMode() {
  correctingMatchId = null;
  document.getElementById('mt-form-title').textContent = '試合結果の申請';
  document.getElementById('mt-submit').textContent = '申請する';
  document.getElementById('mt-cancel').style.display = 'none';
  setResult('mt-result', true, '');
}

/**
 * 既存の試合をフォームに読み込んで訂正モードに入る。
 *
 * @param {string} matchId
 */
async function startCorrection(matchId) {
  setResult('mt-result', true, '読み込み中...');

  const res = await callApi('getMatchDetail', { match_id: matchId });
  if (!res.ok) {
    setResult('mt-result', false, '取得に失敗しました: ' + res.error);
    return;
  }

  const { match, goals, team_stats, gk_stats } = res.data;

  document.getElementById('mt-stage').value = match.stage;
  onMatchStageChange();
  document.getElementById('mt-round').value = match.round;
  document.getElementById('mt-tie').value = match.tie_id;
  document.getElementById('mt-leg').value = match.leg || '-';
  document.getElementById('mt-home').value = match.home_team;
  document.getElementById('mt-away').value = match.away_team;
  document.getElementById('mt-home-score').value = match.home_score;
  document.getElementById('mt-away-score').value = match.away_score;
  document.getElementById('mt-home-pk').value = match.home_pk === null ? '' : match.home_pk;
  document.getElementById('mt-away-pk').value = match.away_pk === null ? '' : match.away_pk;

  await loadMatchOptions();

  // 得点者を反映
  const rows = [...document.querySelectorAll('.goal-row')];
  const byTeam = {};
  goals.forEach((g) => {
    if (!byTeam[g.team_id]) byTeam[g.team_id] = [];
    byTeam[g.team_id].push(g);
  });
  const used = {};
  rows.forEach((r) => {
    const tid = r.dataset.team;
    used[tid] = (used[tid] || 0);
    const g = (byTeam[tid] || [])[used[tid]++];
    if (!g) return;
    r.querySelector('.goal-scorer').value = g.scorer_id;
    r.querySelector('.goal-scorer').dispatchEvent(new Event('change'));
    if (g.assist_id) r.querySelector('.goal-assist').value = g.assist_id;
  });

  // シュートを反映
  team_stats.forEach((s) => {
    const a = document.querySelector('.shot-input[data-key="' + s.team_id + '_shots"]');
    const b = document.querySelector('.shot-input[data-key="' + s.team_id + '_on"]');
    if (a) a.value = s.shots;
    if (b) b.value = s.shots_on_target;
  });

  // GK を反映
  document.getElementById('mt-gks').innerHTML = '';
  gk_stats.forEach((g) => addGkRow(g.team_id, g.gk_player_id, g.saves));
  if (gk_stats.length === 0) addGkRow();

  correctingMatchId = matchId;
  document.getElementById('mt-form-title').textContent = '試合結果の訂正';
  document.getElementById('mt-submit').textContent = 'この内容で訂正する';
  document.getElementById('mt-cancel').style.display = 'inline-block';
  setResult('mt-result', true, '訂正モードです。内容を書き換えて「訂正する」を押してください。');

  document.getElementById('mt-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 試合一覧を描画する。
 */
async function loadMatchList() {
  const seasonId = document.getElementById('mt-season').value;
  const status = document.getElementById('mt-filter').value;
  const box = document.getElementById('mt-list');
  if (!seasonId) return;

  setLoading('mt-list');

  const res = await callApi('listMatches', { season_id: seasonId, status });
  if (!res.ok) {
    setError('mt-list', '試合一覧の取得に失敗しました: ' + res.error);
    return;
  }
  if (res.data.length === 0) {
    box.innerHTML = '<p class="muted">該当する試合はありません。</p>';
    return;
  }

  const badge = { 申請中: 'tag-pending', 承認: 'tag-ok', 差戻: 'tag-ng' };
  const isOrganizer = currentUser.role === 'organizer';

  const rows = res.data
    .map((m) => {
      const pk =
        m.home_pk !== null && m.away_pk !== null
          ? ' <span class="muted">(PK ' + m.home_pk + '-' + m.away_pk + ')</span>'
          : '';

      let actions =
        '<button class="btn btn-sm btn-secondary mt-detail" data-id="' + esc(m.match_id) + '">明細</button> ';
      if (isOrganizer) {
        if (m.can_approve) {
          actions +=
            '<button class="btn btn-sm btn-primary mt-approve" data-id="' + esc(m.match_id) + '">承認</button> ' +
            '<button class="btn btn-sm btn-secondary mt-reject" data-id="' + esc(m.match_id) + '">差戻</button> ';
        } else if (m.status === '承認') {
          actions +=
            '<button class="btn btn-sm btn-secondary mt-reject" data-id="' + esc(m.match_id) + '">差戻</button> ';
        }
        actions +=
          '<button class="btn btn-sm btn-secondary mt-correct" data-id="' + esc(m.match_id) + '">訂正</button>';
      }

      return `
      <tr>
        <td class="muted">${esc(_stageLabel(m.stage))} ${esc(m.round)}</td>
        <td>${esc(m.home_name)} <strong>${m.home_score} - ${m.away_score}</strong> ${esc(m.away_name)}${pk}</td>
        <td><span class="${badge[m.status] || 'tag-none'}">${esc(m.status)}</span></td>
        <td>${actions}</td>
      </tr>
      <tr class="detail-row" id="det-${esc(m.match_id)}" style="display:none;">
        <td colspan="4" class="detail-cell"></td>
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>節</th><th>対戦</th><th>状態</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p id="mt-list-result" class="form-msg"></p>`;

  box.querySelectorAll('.mt-detail').forEach((b) => {
    b.onclick = () => toggleMatchDetail(b.dataset.id);
  });
  box.querySelectorAll('.mt-approve').forEach((b) => {
    b.onclick = () => onMatchAction('approveMatch', b.dataset.id, '承認');
  });
  box.querySelectorAll('.mt-reject').forEach((b) => {
    b.onclick = () => onMatchAction('rejectMatch', b.dataset.id, '差戻');
  });
  box.querySelectorAll('.mt-correct').forEach((b) => {
    b.onclick = () => startCorrection(b.dataset.id);
  });
}

/**
 * 試合明細の開閉。
 *
 * @param {string} matchId
 */
async function toggleMatchDetail(matchId) {
  const row = document.getElementById('det-' + matchId);
  if (!row) return;

  if (row.style.display !== 'none') {
    row.style.display = 'none';
    return;
  }

  const cell = row.querySelector('.detail-cell');
  cell.innerHTML = '<p class="muted">読み込み中...</p>';
  row.style.display = 'table-row';

  const res = await callApi('getMatchDetail', { match_id: matchId });
  if (!res.ok) {
    cell.innerHTML = '<p class="msg-error">' + esc(res.error) + '</p>';
    return;
  }

  const { goals, team_stats, gk_stats } = res.data;

  const goalList = goals.length
    ? goals
        .map((g) =>
          '<li>' + esc(g.team_name) + ' — ' + esc(g.scorer_name) +
          (g.assist_name ? '<span class="muted">（A: ' + esc(g.assist_name) + '）</span>' : '') +
          '</li>')
        .join('')
    : '<li class="muted">得点なし</li>';

  const shotList = team_stats
    .map((s) => '<li>' + esc(s.team_name) + ' — ' + s.shots + ' 本（枠内 ' + s.shots_on_target + '）</li>')
    .join('') || '<li class="muted">未入力</li>';

  const gkList = gk_stats
    .map((g) => '<li>' + esc(g.team_name) + ' — ' + esc(g.gk_name) + ' ' + g.saves + ' セーブ</li>')
    .join('') || '<li class="muted">未入力</li>';

  cell.innerHTML = `
    <div class="detail-grid">
      <div><h4>得点</h4><ul>${goalList}</ul></div>
      <div><h4>シュート</h4><ul>${shotList}</ul></div>
      <div><h4>GK</h4><ul>${gkList}</ul></div>
    </div>`;
}

/**
 * 試合の承認／差戻を実行する。
 *
 * @param {string} action
 * @param {string} matchId
 * @param {string} label
 */
async function onMatchAction(action, matchId, label) {
  if (action === 'rejectMatch' && !confirm('この試合を差し戻します。よろしいですか？')) return;

  setResult('mt-list-result', true, label + '中...');

  const res = await callApi(action, { match_id: matchId });

  if (res.ok) {
    await loadMatchList();
    setResult('mt-list-result', true, label + 'しました。');
  } else {
    setResult('mt-list-result', false, label + 'できません: ' + res.error);
  }
}

// ---------------------------------------------------------------------------
// 画面7: 順位・記録（Phase 6）
// ---------------------------------------------------------------------------

/**
 * 集計画面を初期化する。
 */
async function renderStats() {
  const seasons = await loadSeasons();
  fillSelect('st-season', seasons, 'season_id', 'name');

  const seasonSel = document.getElementById('st-season');
  if (!seasonSel.dataset.bound) {
    seasonSel.onchange = loadStatsView;
    document.getElementById('st-view').onchange = loadStatsView;
    document.getElementById('st-division').onchange = loadStatsView;
    seasonSel.dataset.bound = '1';
  }

  await loadStatsView();
}

/**
 * 選択中の表示種別に応じて描画する。
 */
async function loadStatsView() {
  const seasonId = document.getElementById('st-season').value;
  const view = document.getElementById('st-view').value;
  const box = document.getElementById('st-body');

  if (!seasonId) {
    box.innerHTML = '<p class="muted">シーズンを選択してください。</p>';
    return;
  }

  setLoading('st-body');

  // 絞り込み欄は表示種別によって選択肢が変わる。
  // 順位表はディビジョン（GM1/GM2）、個人ランキングは大会単位。
  const divWrap = document.getElementById('st-division-wrap');
  const divSel = document.getElementById('st-division');
  const showFilter = view === 'standings' || view === 'rankings';
  divWrap.style.display = showFilter ? '' : 'none';

  if (showFilter) {
    const opts =
      view === 'standings'
        ? [['GM1', 'GM1リーグ'], ['GM2', 'GM2リーグ']]
        : [['', '全大会'], ['GM1リーグ', 'GM1リーグ'], ['GM2リーグ', 'GM2リーグ'],
           ['GMリーグ杯', 'GMリーグ杯'], ['GMスーパーカップ', 'GMスーパーカップ']];

    const signature = view + ':' + opts.length;
    if (divSel.dataset.signature !== signature) {
      const keep = divSel.value;
      divSel.innerHTML = opts
        .map((o) => '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>')
        .join('');
      divSel.dataset.signature = signature;
      // 種別を切り替えても同じ値があれば維持する
      if (opts.some((o) => o[0] === keep)) divSel.value = keep;
    }
  }

  const filter = divSel.value;

  if (view === 'standings') return renderStandings(seasonId, filter);
  if (view === 'tournament') return renderTournament(seasonId, 'tournament');
  if (view === 'supercup') return renderTournament(seasonId, 'supercup');
  return renderRankings(seasonId, filter);
}

/**
 * リーグ順位表を描画する。
 *
 * @param {string} seasonId
 */
async function renderStandings(seasonId, division) {
  const res = await callApi('getStandings', { season_id: seasonId, division: division || '' });
  if (!res.ok) {
    setError('st-body', '順位表の取得に失敗しました: ' + res.error);
    return;
  }

  const d = res.data;
  const box = document.getElementById('st-body');

  const leagueName = d.two_division
    ? (division === 'GM2' ? 'GM2リーグ' : 'GM1リーグ')
    : 'GM1リーグ（一部制）';

  if (d.match_count === 0) {
    box.innerHTML =
      '<h3 class="sub-head">' + esc(leagueName) + ' 順位表</h3>' +
      '<p class="muted">承認済みのリーグ戦がまだありません。' +
      (d.two_division ? '' : '<br>このシーズンは一部制のため、GM2リーグは開催されません。') +
      '</p>';
    return;
  }

  const anyH2H = d.table.some((r) => r.h2h);

  const rows = d.table
    .map((r) => {
      const h2h = r.h2h
        ? '<span class="muted">' + r.h2h.points + '点 / ' +
          (r.h2h.gd >= 0 ? '+' : '') + r.h2h.gd + '</span>'
        : '<span class="muted">—</span>';

      return `
      <tr${r.rank <= 2 ? ' class="rank-top"' : ''}>
        <td class="num">${r.rank}${r.tied ? '<span class="tag-none">同</span>' : ''}</td>
        <td>${esc(r.team_name)}</td>
        <td class="num">${r.played}</td>
        <td class="num">${r.won}</td>
        <td class="num">${r.drawn}</td>
        <td class="num">${r.lost}</td>
        <td class="num">${r.gf}</td>
        <td class="num">${r.ga}</td>
        <td class="num">${r.gd >= 0 ? '+' : ''}${r.gd}</td>
        <td class="num"><strong>${r.points}</strong></td>
        ${anyH2H ? '<td class="num">' + h2h + '</td>' : ''}
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <h3 class="sub-head">${esc(leagueName)} 順位表</h3>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="num">順位</th><th>チーム</th>
            <th class="num">試合</th><th class="num">勝</th><th class="num">分</th><th class="num">敗</th>
            <th class="num">得点</th><th class="num">失点</th><th class="num">得失</th><th class="num">勝点</th>
            ${anyH2H ? '<th class="num">直接対決</th>' : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">
      承認済み ${d.match_count} 試合を集計（シーズン1・シーズン2の合算）。
      勝${d.win_points}・分${d.draw_points}・敗0。
      同点時は 得失点差 → 総得点 → 直接対決 の順で比較し、すべて並ぶ場合は同順位（「同」表示）です。
    </p>`;
}

/**
 * トーナメント表を描画する。
 *
 * @param {string} seasonId
 */
async function renderTournament(seasonId, stage) {
  const isCup = stage !== 'supercup';
  const title = isCup ? 'GMリーグ杯' : 'GMスーパーカップ';

  const res = await callApi('getTournament', { season_id: seasonId, stage: stage || 'tournament' });
  if (!res.ok) {
    setError('st-body', title + 'の取得に失敗しました: ' + res.error);
    return;
  }

  const d = res.data;
  const box = document.getElementById('st-body');

  if (d.ties.length === 0) {
    box.innerHTML =
      '<h3 class="sub-head">' + esc(title) + '</h3>' +
      '<p class="muted">承認済みの試合がまだありません。' +
      (isCup ? '' : '<br>スーパーカップの出場チームは「運営・進行」タブで設定します。') +
      '</p>';
    return;
  }

  const cards = d.ties
    .map((t) => {
      const legRows = t.legs
        .map((l) => {
          const pk =
            l.home_pk !== null && l.away_pk !== null
              ? ' <span class="muted">PK ' + l.home_pk + '-' + l.away_pk + '</span>'
              : '';
          return `
          <li>
            <span class="muted">${esc(l.leg && l.leg !== '-' ? l.leg + 'st/nd レグ' : '単発')}</span>
            ${esc(l.home_name)} <strong>${l.home_score} - ${l.away_score}</strong> ${esc(l.away_name)}${pk}
          </li>`;
        })
        .join('');

      const pkAgg =
        t.pk_a !== null && t.pk_b !== null
          ? '<span class="muted">（PK ' + t.pk_a + '-' + t.pk_b + '）</span>'
          : '';

      const decided =
        t.winner
          ? '<span class="tag-ok">' + esc(t.winner_name) + ' 勝ち上がり</span>' +
            '<span class="muted"> — ' + esc(t.decided_by) + '</span>'
          : '<span class="tag-pending">未決着</span>';

      return `
      <div class="tie-card">
        <div class="tie-head">
          <span class="tie-round">${esc(t.round || t.tie_id || '—')}</span>
          ${decided}
        </div>
        <div class="tie-agg">
          <span${t.winner === t.team_a ? ' class="tie-winner"' : ''}>${esc(t.team_a_name)}</span>
          <strong>${t.agg_a} - ${t.agg_b}</strong>
          <span${t.winner === t.team_b ? ' class="tie-winner"' : ''}>${esc(t.team_b_name)}</span>
          ${pkAgg}
        </div>
        <ul class="tie-legs">${legRows}</ul>
      </div>`;
    })
    .join('');

  box.innerHTML = `
    <h3 class="sub-head">トーナメント</h3>
    <div class="tie-grid">${cards}</div>
    <p class="muted note-sm">
      合計スコアで判定します（アウェイゴールは採用しません）。合計が同点の場合は PK 戦の結果で決まります。
      各レグの結果も併記しています。
    </p>`;
}

/**
 * 個人ランキング4種を描画する。
 *
 * @param {string} seasonId
 */
async function renderRankings(seasonId, competition) {
  const res = await callApi('getRankings', {
    season_id: seasonId,
    competition: competition || '',
  });
  if (!res.ok) {
    setError('st-body', 'ランキングの取得に失敗しました: ' + res.error);
    return;
  }

  const d = res.data;
  const box = document.getElementById('st-body');

  const rkTitle = '個人ランキング' + (competition ? '（' + competition + '）' : '（全大会）');

  if (d.match_count === 0) {
    box.innerHTML =
      '<h3 class="sub-head">' + esc(rkTitle) + '</h3>' +
      '<p class="muted">承認済みの試合がまだありません。</p>';
    return;
  }

  const table = (title, list, valueKey, unit, extra) => {
    if (!list || list.length === 0) {
      return '<div><h4 class="rank-title">' + esc(title) + '</h4><p class="muted">該当なし</p></div>';
    }

    const rows = list
      .slice(0, 20)
      .map((r) => `
        <tr>
          <td class="num">${r.rank}${r.tied ? '<span class="tag-none">同</span>' : ''}</td>
          <td><span class="pos pos-${esc(r.position)}">${esc(r.position)}</span> ${esc(r.name)}</td>
          <td class="muted">${esc(r.team_name)}</td>
          <td class="num"><strong>${esc(r[valueKey])}</strong>${esc(unit)}</td>
          ${extra ? '<td class="num muted">' + esc(extra(r)) + '</td>' : ''}
        </tr>`)
      .join('');

    return `
      <div>
        <h4 class="rank-title">${esc(title)}</h4>
        <div class="table-wrap">
          <table class="data-table">
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  };

  box.innerHTML = `
    <h3 class="sub-head">${esc(rkTitle)}</h3>
    <div class="rank-grid">
      ${table('得点', d.goals, 'goals', ' 点')}
      ${table('アシスト', d.assists, 'assists', ' 回')}
      ${table('セーブ数', d.saves, 'saves', ' 本')}
      ${table('シュートセーブ率', d.save_rate, 'rate', ' %', (r) => r.saves + '/' + r.faced)}
    </div>
    <p class="muted note-sm">
      承認済み ${d.match_count} 試合を集計。得点ランキングにオウンゴールは含めません。
      シュートセーブ率は ${d.min_matches_for_save_rate} 試合以上出場した GK のみを対象とし、
      分母は出場試合における相手チームの枠内シュート数です。
    </p>`;
}

// ---------------------------------------------------------------------------
// 画面8: 運営・進行（主催者限定・Phase 7）
// ---------------------------------------------------------------------------

/** 直近に取得したシーズン進行状況 */
let seasonProgress = null;

/**
 * 運営画面を初期化する。
 */
async function renderSeasonAdmin() {
  if (currentUser.role !== 'organizer') return;

  const seasons = await loadSeasons(true);
  fillSelect('sp-season', seasons, 'season_id', 'name');

  const teams = await loadTeams();
  fillSelect('pn-team', teams, 'team_id', 'name', 'チームを選択');
  fillSelect('cp-team', teams, 'team_id', 'name', 'チームを選択');

  const sel = document.getElementById('sp-season');
  if (!sel.dataset.bound) {
    sel.onchange = loadSeasonAdmin;
    document.getElementById('sp-advance').onclick = onAdvanceSeason;
    document.getElementById('sp-close').onclick = onCloseSeason;
    document.getElementById('sp-sponsor-submit').onclick = onSubmitSponsor;
    document.getElementById('pn-submit').onclick = onSubmitPenalty;
    document.getElementById('cp-submit').onclick = onSubmitCompensation;
    document.getElementById('cp-team').onchange = loadCompensationPlayers;
    document.getElementById('dv-save').onclick = onSaveDivisions;
    document.getElementById('dv-all-gm1').onclick = onAllGm1;
    document.getElementById('sc-save').onclick = onSaveSuperCup;
    bindMoneyEcho('pn-amount', 'pn-amount-echo');
    sel.dataset.bound = '1';
  }

  await loadSeasonAdmin();
}

/**
 * 進行状況・引継ぎ先候補・スポンサー入力欄を組み立てる。
 */
async function loadSeasonAdmin() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  setLoading('sp-status');

  const res = await callApi('getSeasonProgress', { season_id: seasonId });
  if (!res.ok) {
    setError('sp-status', '進行状況の取得に失敗しました: ' + res.error);
    return;
  }

  seasonProgress = res.data;
  renderSeasonStatusBox();

  // 引継ぎ先は自分以外のシーズン
  const seasons = (await loadSeasons()).filter((s) => s.season_id !== seasonId);
  fillSelect('sp-next', seasons, 'season_id', 'name', '引継ぎしない');

  renderSponsorInputs(await loadTeams());
  await loadCompensationPlayers();
  await loadDivisions();
  await loadSuperCup();
}

// ---------------------------------------------------------------------------
// ディビジョン設定
// ---------------------------------------------------------------------------

/** getSeasonDivisions の結果を保持する（保存時の再取得を避けるため） */
let divisionData = null;

/**
 * ディビジョン割り当ての現状を読み込んで描画する。
 */
async function loadDivisions() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  setLoading('dv-list');

  const res = await callApi('getSeasonDivisions', { season_id: seasonId });
  if (!res.ok) {
    setError('dv-list', 'ディビジョンの取得に失敗しました: ' + res.error);
    return;
  }

  divisionData = res.data;
  renderDivisionBox();
}

/**
 * ディビジョンの状態表示とチーム別セレクトを描画する。
 */
function renderDivisionBox() {
  const d = divisionData;

  document.getElementById('dv-status').innerHTML = `
    <div class="status-line">
      <span class="tag-${d.two_division ? 'ok' : 'none'}">${esc(d.format)}</span>
      <span class="muted">
        参加 ${d.team_count} チーム（GM1 ${d.counts.GM1} / GM2 ${d.counts.GM2}）
        ／ 二部制の要件: ${d.min_teams} チーム以上
      </span>
    </div>
    ${d.can_two_division
      ? ''
      : '<p class="muted note-sm">現在は ' + d.min_teams +
        ' チームに達していないため、GM2 を選ぶと保存時に拒否されます。</p>'}`;

  const rows = d.teams
    .map(
      (t) => `
      <label class="division-row">
        <span>${esc(t.team_name)}</span>
        <select class="division-input" data-team="${esc(t.team_id)}"${d.can_two_division ? '' : ' disabled'}>
          <option value="GM1"${t.division === 'GM1' ? ' selected' : ''}>GM1リーグ</option>
          <option value="GM2"${t.division === 'GM2' ? ' selected' : ''}>GM2リーグ</option>
        </select>
      </label>`
    )
    .join('');

  document.getElementById('dv-list').innerHTML = '<div class="form-grid">' + rows + '</div>';
  document.getElementById('dv-save').disabled = !d.can_two_division;
  document.getElementById('dv-all-gm1').disabled = !d.can_two_division;
}

/**
 * 全チームを GM1 に戻す（画面上のみ。保存は「割り当てを保存」）。
 */
function onAllGm1() {
  document.querySelectorAll('.division-input').forEach((sel) => {
    sel.value = 'GM1';
  });
  setResult('dv-result', true, '全て GM1 にしました。保存を押すと確定します。');
}

/**
 * ディビジョン割り当てを保存する。
 */
async function onSaveDivisions() {
  const assignments = [...document.querySelectorAll('.division-input')].map((sel) => ({
    team_id: sel.dataset.team,
    division: sel.value,
  }));

  if (assignments.length === 0) {
    setResult('dv-result', false, '対象チームがありません。');
    return;
  }

  const btn = document.getElementById('dv-save');
  btn.disabled = true;
  setResult('dv-result', true, '保存中...');

  const res = await callApi('setSeasonDivisions', {
    season_id: document.getElementById('sp-season').value,
    assignments: assignments,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('dv-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult(
    'dv-result', true,
    res.data.format + 'として保存しました（GM1 ' + res.data.counts.GM1 +
    ' / GM2 ' + res.data.counts.GM2 + '）。'
  );
  await loadDivisions();
}

// ---------------------------------------------------------------------------
// GMスーパーカップ
// ---------------------------------------------------------------------------

/**
 * スーパーカップの設定を読み込んでフォームに反映する。
 */
async function loadSuperCup() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  const teams = (await loadTeams()).filter((t) => t.active);
  fillSelect('sc-team-a', teams, 'team_id', 'name', 'チームを選択');
  fillSelect('sc-team-b', teams, 'team_id', 'name', 'チームを選択');

  const res = await callApi('getSuperCup', { season_id: seasonId });
  if (!res.ok) {
    setError('sc-info', 'スーパーカップの取得に失敗しました: ' + res.error);
    return;
  }

  const d = res.data;

  document.getElementById('sc-team-a').value = d.team_a || '';
  document.getElementById('sc-team-b').value = d.team_b || '';
  document.getElementById('sc-streamed').checked = !!d.streamed;
  document.getElementById('sc-note').value = d.note || '';

  renderSuperCupSuggestion(d);

  document.getElementById('sc-info').innerHTML = `
    <p class="muted note-sm">
      配信料 各 ${formatMoney(d.stream_fee)}
      ／ 優勝 ${formatMoney(d.prize_1)}
      ／ 準優勝 ${formatMoney(d.prize_2)}
      <br>
      ${d.configured
        ? '設定済み。' + (d.streamed
            ? '配信ありのため、シーズン終了時に両チームへ配信料が入ります。'
            : '配信なしのため、配信料は発生しません。')
        : '未設定です。'}
      優勝・準優勝の賞金は「スーパーカップ」の試合が承認されている場合のみ支給されます。
    </p>`;
}

/**
 * 前シーズン王者の候補を表示する。参考情報であり自動では入力しない。
 *
 * @param {Object} d getSuperCup のレスポンス
 */
function renderSuperCupSuggestion(d) {
  const box = document.getElementById('sc-suggestion');
  const sg = d.suggestion;

  if (!sg) {
    box.innerHTML = '<p class="muted note-sm">前シーズンがないため、候補は表示できません。</p>';
    return;
  }

  const line = (label, champ) =>
    '<li>' + esc(label) + ': ' +
    (champ ? '<strong>' + esc(champ.team_name) + '</strong>' : '<span class="muted">未確定</span>') +
    '</li>';

  box.innerHTML = `
    <div class="hint-box">
      <strong>${esc(sg.prev_season_name)} の王者（候補）</strong>
      <ul class="detail-grid-list">
        ${line('GM1リーグ', sg.league_champion)}
        ${line('GMリーグ杯', sg.cup_champion)}
      </ul>
      ${sg.same_team
        ? '<p class="muted note-sm">両方が同じチームです。もう1枠は主催者の判断で選んでください。</p>'
        : ''}
    </div>`;
}

/**
 * スーパーカップの出場チーム・配信有無を保存する。
 */
async function onSaveSuperCup() {
  const teamA = document.getElementById('sc-team-a').value;
  const teamB = document.getElementById('sc-team-b').value;

  if (!teamA || !teamB) {
    setResult('sc-result', false, '出場チームを2つとも選んでください。');
    return;
  }

  const btn = document.getElementById('sc-save');
  btn.disabled = true;
  setResult('sc-result', true, '保存中...');

  const res = await callApi('setSuperCup', {
    season_id: document.getElementById('sp-season').value,
    team_a: teamA,
    team_b: teamB,
    streamed: document.getElementById('sc-streamed').checked,
    note: document.getElementById('sc-note').value,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('sc-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult(
    'sc-result', true,
    res.data.streamed
      ? '保存しました。配信料 各 ' + formatMoney(res.data.stream_fee_each) +
        ' をシーズン終了時に計上します。'
      : '保存しました。配信なしのため配信料はありません。'
  );
  await loadSuperCup();
}

/**
 * 現在の状態と実施済みの経済処理を表示する。
 */
function renderSeasonStatusBox() {
  const d = seasonProgress;
  const box = document.getElementById('sp-status');

  const flag = (label, done) =>
    `<div class="stat">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-value stat-sm">${done ? '<span class="tag-ok">計上済</span>' : '<span class="tag-none">未</span>'}</span>
    </div>`;

  const nextLine = d.can_advance
    ? '<strong>' + esc(d.next_status) + '</strong> へ進めます'
    : (d.closed ? '終了済みです' : 'これ以上は進められません（終了処理へ）');

  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-label">現在の状態</span>
        <span class="stat-value">${esc(d.status)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">次の状態</span>
        <span class="stat-value stat-sm">${nextLine}</span>
      </div>
      ${flag('シーズン賞金', d.applied.season_prize)}
      ${flag('スポンサー', d.applied.sponsor)}
      ${flag('順位賞金', d.applied.rank_prize)}
      ${flag('終了手数料', d.applied.season_fee)}
    </div>
    <p class="muted note-sm">
      進行順: ${d.statuses.join(' → ')}
    </p>`;

  document.getElementById('sp-advance').disabled = !d.can_advance;
  document.getElementById('sp-close').disabled = !d.can_close;
}

/**
 * シーズンを1つ進める。
 */
async function onAdvanceSeason() {
  const d = seasonProgress;
  if (!confirm('シーズンを「' + d.next_status + '」へ進めます。よろしいですか？')) return;

  const btn = document.getElementById('sp-advance');
  btn.disabled = true;
  setResult('sp-result', true, '実行中...');

  const res = await callApi('advanceSeason', { season_id: d.season_id });

  if (res.ok) {
    const effects = res.data.effects || [];
    setResult(
      'sp-result',
      true,
      '「' + res.data.status + '」に進みました。' + (effects.length ? ' ' + effects.join(' / ') : '')
    );
    cache.seasons = null;
    await loadSeasons(true);
    await loadSeasonAdmin();
  } else {
    btn.disabled = false;
    setResult('sp-result', false, '進められません: ' + res.error);
  }
}

/**
 * シーズン終了処理を実行する。取り消せないので二重に確認する。
 */
async function onCloseSeason() {
  const d = seasonProgress;
  const nextSel = document.getElementById('sp-next');
  const nextId = nextSel.value;
  const nextName = nextId ? nextSel.options[nextSel.selectedIndex].text : 'なし';

  const msg =
    'シーズン「' + d.season_name + '」を終了します。\n\n' +
    '・順位賞金と得点王賞金を計上\n' +
    '・残予算から手数料を控除\n' +
    '・期限付き選手を離脱\n' +
    '・引継ぎ先: ' + nextName + '\n\n' +
    'この操作は取り消せません。実行しますか？';

  if (!confirm(msg)) return;

  const btn = document.getElementById('sp-close');
  btn.disabled = true;
  setResult('sp-close-result', true, '実行中...');

  const res = await callApi('closeSeason', {
    season_id: d.season_id,
    next_season_id: nextId,
  });

  if (!res.ok) {
    btn.disabled = false;
    setResult('sp-close-result', false, '終了できません: ' + res.error);
    return;
  }

  setResult('sp-close-result', true, 'シーズンを終了しました。');
  renderCloseReport(res.data.report);
  cache.seasons = null;
  await loadSeasons(true);
  await loadSeasonAdmin();
}

/**
 * 終了処理の結果を表示する。
 *
 * @param {Object} report
 */
function renderCloseReport(report) {
  const box = document.getElementById('sp-report');
  const teams = cache.teams || [];
  const nameOf = (id) => {
    const t = teams.find((x) => x.team_id === id);
    return t ? t.name : id;
  };

  const list = (title, rows, fmt) =>
    rows.length
      ? '<div><h4 class="rank-title">' + esc(title) + '</h4><ul class="detail-grid-list">' +
        rows.map((r) => '<li>' + esc(fmt(r)) + '</li>').join('') + '</ul></div>'
      : '';

  box.innerHTML = `
    <h3 class="sub-head">終了処理の結果（${esc(report.format || '')}）</h3>
    <div class="detail-grid">
      ${list('リーグ順位賞金', report.rank_prizes,
        (r) => (r.competition ? r.competition + ' ' : '') + nameOf(r.team_id) + ' ' + r.rank + '位 ' + formatMoney(r.amount))}
      ${list('GMリーグ杯', report.cup_prizes || [],
        (r) => nameOf(r.team_id) + ' ' + r.label + ' ' + formatMoney(r.amount))}
      ${list('GMスーパーカップ', report.supercup_prizes || [],
        (r) => nameOf(r.team_id) + ' ' + r.label + ' ' + formatMoney(r.amount))}
      ${list('配信料', report.stream_fees || [],
        (r) => nameOf(r.team_id) + ' ' + formatMoney(r.amount))}
      ${list('得点王賞金', report.top_scorer_prizes,
        (r) => (r.competition ? r.competition + ' ' : '') + nameOf(r.team_id) + ' ' + r.goals + '点 ' + formatMoney(r.amount))}
      ${list('終了手数料', report.fees, (r) => nameOf(r.team_id) + ' −' + formatMoney(r.fee))}
    </div>
    <p class="muted note-sm">
      期限切れで離脱: ${report.expired} 名 ／ 次シーズンへ引継ぎ: ${report.carried} 名
    </p>`;
}

/**
 * スポンサー収益の入力欄をチーム分だけ生成する。
 *
 * @param {Object[]} teams
 */
function renderSponsorInputs(teams) {
  const box = document.getElementById('sp-sponsor');
  const active = teams.filter((t) => t.active);

  box.innerHTML =
    '<div class="form-grid">' +
    active
      .map(
        (t) => `
      <label>
        ${esc(t.name)} <span class="unit-hint">100万円単位</span>
        <input type="number" min="0" step="1" class="sponsor-input" data-team="${esc(t.team_id)}" />
        <span class="money-echo" data-echo="${esc(t.team_id)}">—</span>
      </label>`
      )
      .join('') +
    '</div>';

  box.querySelectorAll('.sponsor-input').forEach((input) => {
    input.oninput = () => {
      const echo = box.querySelector('[data-echo="' + input.dataset.team + '"]');
      const yen = unitToYen(input.value);
      echo.textContent = yen > 0 ? '→ ' + formatMoney(yen) : '—';
      echo.className = 'money-echo' + (yen > 0 ? ' money-echo-on' : '');
    };
  });
}

/**
 * スポンサー収益を反映する。
 */
async function onSubmitSponsor() {
  const entries = [...document.querySelectorAll('.sponsor-input')]
    .map((i) => ({ team_id: i.dataset.team, amount: unitToYen(i.value) }))
    .filter((e) => e.amount > 0);

  if (entries.length === 0) {
    setResult('sp-sponsor-result', false, '金額を入力してください。');
    return;
  }

  const total = entries.reduce((s, e) => s + e.amount, 0);
  if (!confirm(entries.length + ' チームに合計 ' + formatMoney(total) + ' を計上します。よろしいですか？')) {
    return;
  }

  const btn = document.getElementById('sp-sponsor-submit');
  btn.disabled = true;
  setResult('sp-sponsor-result', true, '反映中...');

  const res = await callApi('applySponsorIncome', {
    season_id: document.getElementById('sp-season').value,
    entries,
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('sp-sponsor-result', true, res.data.count + ' チームに反映しました。');
    document.querySelectorAll('.sponsor-input').forEach((i) => {
      i.value = '';
      i.dispatchEvent(new Event('input'));
    });
    await loadSeasonAdmin();
  } else {
    setResult('sp-sponsor-result', false, '反映できません: ' + res.error);
  }
}

/**
 * 罰金を計上する。
 */
async function onSubmitPenalty() {
  const teamSel = document.getElementById('pn-team');
  const teamId = teamSel.value;
  const amount = unitToYen(document.getElementById('pn-amount').value);

  if (!teamId || amount <= 0) {
    setResult('pn-result', false, 'チームと金額を入力してください。');
    return;
  }

  const teamName = teamSel.options[teamSel.selectedIndex].text;
  if (!confirm(teamName + ' に ' + formatMoney(amount) + ' の罰金を計上します。よろしいですか？')) return;

  const btn = document.getElementById('pn-submit');
  btn.disabled = true;
  setResult('pn-result', true, '計上中...');

  const res = await callApi('addPenalty', {
    season_id: document.getElementById('sp-season').value,
    team_id: teamId,
    amount,
    note: document.getElementById('pn-note').value.trim(),
  });

  btn.disabled = false;

  if (res.ok) {
    setResult('pn-result', true, formatMoney(-res.data.amount) + ' を計上しました。');
    document.getElementById('pn-amount').value = '';
    document.getElementById('pn-amount').dispatchEvent(new Event('input'));
    document.getElementById('pn-note').value = '';
  } else {
    setResult('pn-result', false, '計上できません: ' + res.error);
  }
}

/**
 * 補填金の対象になりうる選手を読み込む。
 *
 * 獲得額が母数になるため、そのシーズンにそのチームで在籍記録がある選手を出す。
 */
async function loadCompensationPlayers() {
  const seasonId = document.getElementById('sp-season').value;
  const teamId = document.getElementById('cp-team').value;
  const sel = document.getElementById('cp-player');

  if (!seasonId || !teamId) {
    sel.innerHTML = '<option value="">チームを選択してください</option>';
    return;
  }

  const res = await callApi('getMatchOptions', {
    season_id: seasonId,
    home_team: teamId,
  });

  if (!res.ok) {
    sel.innerHTML = '<option value="">取得に失敗しました</option>';
    return;
  }

  const list = res.data.home_players || [];
  sel.innerHTML =
    '<option value="">選手を選択</option>' +
    list
      .map((p) => '<option value="' + esc(p.player_id) + '">' +
        esc(p.position) + ' ' + esc(p.name) + (p.current ? '' : '（離脱）') + '</option>')
      .join('');
}

/**
 * 補填金を計上する。
 */
async function onSubmitCompensation() {
  const teamSel = document.getElementById('cp-team');
  const playerSel = document.getElementById('cp-player');
  const kind = document.getElementById('cp-kind').value;

  if (!teamSel.value || !playerSel.value) {
    setResult('cp-result', false, 'チームと選手を選んでください。');
    return;
  }

  const btn = document.getElementById('cp-submit');
  btn.disabled = true;
  setResult('cp-result', true, '計上中...');

  const res = await callApi('addCompensation', {
    season_id: document.getElementById('sp-season').value,
    team_id: teamSel.value,
    player_id: playerSel.value,
    kind,
  });

  btn.disabled = false;

  if (res.ok) {
    const d = res.data;
    setResult(
      'cp-result',
      true,
      '獲得額 ' + formatMoney(d.acquired_cost) + ' × ' + Math.round(d.rate * 100) + '% = ' +
        formatMoney(d.amount) + ' を計上しました。'
    );
  } else {
    setResult('cp-result', false, '計上できません: ' + res.error);
  }
}

// ---------------------------------------------------------------------------
// 画面: 参加登録承認（主催者のみ）
// ---------------------------------------------------------------------------

/**
 * 合言葉の設定と申請一覧を描画する。
 */
async function renderSignupAdmin() {
  if (currentUser.role !== 'organizer') return;

  const btn = document.getElementById('sg-save-config');
  if (!btn.dataset.bound) {
    btn.onclick = onSaveSignupConfig;
    btn.dataset.bound = '1';
  }

  await loadSignupConfig();
  await loadSignups();
}

/**
 * Config から合言葉と受付フラグを読み込む。
 *
 * 合言葉は主催者しか見られない（listConfig が主催者専用のため）。
 */
async function loadSignupConfig() {
  const res = await callApi('listConfig');
  if (!res.ok) {
    setError('sg-list', '設定の取得に失敗しました: ' + res.error);
    return;
  }

  const map = {};
  res.data.forEach((r) => { map[r.key] = r.value; });

  document.getElementById('sg-code').value = map.signup_code || '';
  document.getElementById('sg-open').checked =
    String(map.signup_open).toLowerCase() === 'true' || map.signup_open === true;

  renderSignupLink();
}

/**
 * 参加者に案内する URL を表示する。
 *
 * 現在開いているページと同じ場所の register.html を指すので、
 * ローカル確認でも本番でもそのまま使える。
 */
function renderSignupLink() {
  const url = location.href.replace(/[^/]*$/, '') + 'register.html';
  const pub = location.href.replace(/[^/]*$/, '') + 'public.html';

  document.getElementById('sg-link').innerHTML = `
    <div class="hint-box">
      <strong>案内用のURL</strong>
      <ul class="detail-grid-list">
        <li>参加登録: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></li>
        <li>公開ページ: <a href="${esc(pub)}" target="_blank" rel="noopener">${esc(pub)}</a></li>
      </ul>
      <p class="muted note-sm">
        合言葉はこのURLとは別に伝えてください。URLだけでは登録できません。
      </p>
    </div>`;
}

/**
 * 合言葉と受付フラグを保存する。
 */
async function onSaveSignupConfig() {
  const code = document.getElementById('sg-code').value.trim();
  const open = document.getElementById('sg-open').checked;

  if (open && !code) {
    setResult('sg-config-result', false, '受け付けるには合言葉を設定してください。');
    return;
  }

  const btn = document.getElementById('sg-save-config');
  btn.disabled = true;
  setResult('sg-config-result', true, '保存中...');

  const a = await callApi('setConfig', { key: 'signup_code', value: code });
  const b = await callApi('setConfig', { key: 'signup_open', value: open });

  btn.disabled = false;

  if (!a.ok || !b.ok) {
    setResult('sg-config-result', false, '保存できません: ' + (a.error || b.error));
    return;
  }

  setResult(
    'sg-config-result', true,
    open ? '受付中にしました。' : '受付を停止しました。'
  );
}

/**
 * 申請一覧を読み込んで描画する。
 */
async function loadSignups() {
  setLoading('sg-list');

  const res = await callApi('listSignups', {});
  if (!res.ok) {
    setError('sg-list', '申請一覧の取得に失敗しました: ' + res.error);
    return;
  }

  const box = document.getElementById('sg-list');

  if (res.data.length === 0) {
    box.innerHTML = '<p class="muted">まだ申請はありません。</p>';
    return;
  }

  const rows = res.data
    .map((r) => {
      const pending = r.status === '申請中';
      const tag =
        r.status === '承認' ? '<span class="tag-ok">承認</span>'
        : r.status === '却下' ? '<span class="tag-ng">却下</span>'
        : '<span class="tag-wait">申請中</span>';

      const actions = pending
        ? `<button type="button" class="btn btn-primary btn-sm sg-approve" data-id="${esc(r.signup_id)}">承認</button>
           <button type="button" class="btn btn-secondary btn-sm sg-reject" data-id="${esc(r.signup_id)}">却下</button>`
        : '<span class="muted">—</span>';

      return `
        <tr>
          <td class="muted">${esc(String(r.created_at).slice(0, 10))}</td>
          <td>${esc(r.display_name)}</td>
          <td>
            ${pending
              ? `<input type="text" class="sg-team-input" data-id="${esc(r.signup_id)}" value="${esc(r.team_name)}" />`
              : esc(r.team_name)}
          </td>
          <td>${xLinkHtml(r.x_id)}</td>
          <td class="muted">${esc(r.note)}</td>
          <td>${tag}</td>
          <td>${actions}</td>
        </tr>`;
    })
    .join('');

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>申請日</th><th>表示名</th><th>チーム名</th><th>X</th>
            <th>連絡事項</th><th>状態</th><th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">
      チーム名は承認前なら主催者が直せます。同じ名前のチームが既にある場合は承認できません。
    </p>`;

  box.querySelectorAll('.sg-approve').forEach((b) => {
    b.onclick = () => onApproveSignup(b.dataset.id);
  });
  box.querySelectorAll('.sg-reject').forEach((b) => {
    b.onclick = () => onRejectSignup(b.dataset.id);
  });
}

/**
 * 申請を承認する。チーム名は画面の入力欄の値を使う。
 *
 * @param {string} signupId
 */
async function onApproveSignup(signupId) {
  const input = document.querySelector('.sg-team-input[data-id="' + signupId + '"]');
  const teamName = input ? input.value.trim() : '';

  if (!confirm('この申請を承認します。\nチーム「' + teamName + '」とユーザーが作成されます。')) return;

  const res = await callApi('approveSignup', { signup_id: signupId, team_name: teamName });

  if (!res.ok) {
    alert('承認できません: ' + res.error);
    return;
  }

  // 新しいチームができたのでキャッシュを捨てる
  cache.teams = null;
  await loadTeams(true);
  await loadSignups();
}

/**
 * 申請を却下する。
 *
 * @param {string} signupId
 */
async function onRejectSignup(signupId) {
  const note = prompt('却下の理由（任意・申請者には表示されません）', '');
  if (note === null) return;

  const res = await callApi('rejectSignup', { signup_id: signupId, note });

  if (!res.ok) {
    alert('却下できません: ' + res.error);
    return;
  }

  await loadSignups();
}
