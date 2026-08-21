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

/** getUiState の結果。どのタブを出すかの判定に使う */
let uiState = null;

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

  await applyTabVisibility();

  showTab('dashboard');
}

/**
 * 期間外のタブを参加者の画面から消す。
 *
 * 移籍市場や監督申告のように期間が決まっているものは、期間外に並んでいても
 * 押せるだけで何もできない。「今できること」を探しにくくなるので隠す。
 *
 * **主催者には常に全部見せる。** 期限を過ぎた参加者の代わりに入力するため。
 *
 * ⚠️ これは見た目の整理であって権限の仕組みではない。
 *   タブを隠しても API は叩けるので、期間の検証は各 action 側で行っている。
 */
async function applyTabVisibility() {
  const seasonId = (cache.seasons && cache.seasons.length)
    ? cache.seasons[cache.seasons.length - 1].season_id
    : '';

  const res = await callApi('getUiState', { season_id: seasonId });

  // 取得に失敗したときは何も隠さない。
  // 通信の不調でタブが消えると「機能が無くなった」と誤解されるため
  if (!res.ok) {
    console.warn('[views] タブの出し分けを取得できませんでした:', res.error);
    return;
  }

  uiState = res.data;

  Object.keys(uiState.tabs).forEach((key) => {
    const btn = document.querySelector('.tab-btn[data-tab="' + key + '"]');
    if (!btn) return;

    const state = uiState.tabs[key];
    btn.style.display = state.open ? '' : 'none';
    btn.title = state.reason || '';
  });

  // 今開いているタブが消えたらダッシュボードへ戻す
  const active = document.querySelector('.tab-btn.is-active');
  if (active && active.style.display === 'none') showTab('dashboard');
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
  if (name === 'claims') renderClaims();
  if (name === 'schedule') renderSchedule();
  if (name === 'manager') renderManager();
  if (name === 'sponsor') renderSponsor();
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
    ${renderNowAvailable()}
    <h3 class="sub-head">スカッド</h3>
    ${renderSquadTable(squad.squad)}
    ${renderProfileEditor()}
  `;

  bindProfileEditor();

  // 開いたままにしていると期間がずれるので、ここで取り直す
  await applyTabVisibility();
}

/**
 * 「今できること」をダッシュボードに出す。
 *
 * 期間外のタブは消えるので、消えた側にも触れておかないと
 * 「機能が無くなった」と誤解される。閉じているものも理由付きで並べる。
 *
 * @returns {string} HTML
 */
function renderNowAvailable() {
  if (!uiState || !uiState.tabs) return '';

  const labels = {
    entry:    'エントリー',
    transfer: '移籍',
    protect:  'プロテクト',
    manager:  '使用監督',
    claims:   '補填の選択',
  };

  const open = [];
  const closed = [];

  Object.keys(labels).forEach((key) => {
    const state = uiState.tabs[key];
    if (!state) return;
    (state.open ? open : closed).push(
      '<li>' + esc(labels[key]) + ' — ' + esc(state.reason) + '</li>'
    );
  });

  return `
    <h3 class="sub-head">今できること</h3>
    <div class="hint-box">
      ${open.length
        ? '<ul class="detail-grid-list">' + open.join('') + '</ul>'
        : '<p class="muted">受付中の手続きはありません。</p>'}
      ${closed.length
        ? '<details><summary class="muted">受付していないもの（' + closed.length + '）</summary>' +
          '<ul class="detail-grid-list muted">' + closed.join('') + '</ul></details>'
        : ''}
      <p class="muted note-sm">
        受付中のものはタブに表示されます。期間が終わるとタブは消えますが、記録は残っています。
      </p>
    </div>`;
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

  // シーズンが0件でも押せる必要があるので、loadSeasonAdmin より先につなぐ
  bindCreateSeason();

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
  await loadRealTransfers();
  await loadClaimAdmin();
  await loadWithdraw();
  await loadMarketWindows();
  await loadScheduleAdmin();
  await loadManagerAdmin();
  await loadSponsorAdmin();
}

// ---------------------------------------------------------------------------
// シーズンの作成
// ---------------------------------------------------------------------------

/**
 * 「シーズンを作成」ボタンをつなぐ。
 *
 * シーズンが1つも無いとどの画面も動かないが、作る手段がシートの直接編集しか
 * 無かったので画面から作れるようにした。
 */
function bindCreateSeason() {
  const btn = document.getElementById('ns-create');
  if (btn.dataset.bound) return;

  btn.onclick = onCreateSeason;
  btn.dataset.bound = '1';
}

/**
 * 新しいシーズンを作る。状態は「準備中」から始まる。
 */
async function onCreateSeason() {
  const name = document.getElementById('ns-name').value.trim();
  if (!name) {
    setResult('ns-result', false, 'シーズン名を入れてください。');
    return;
  }

  const btn = document.getElementById('ns-create');
  btn.disabled = true;
  setResult('ns-result', true, '作成中...');

  const res = await callApi('upsertSeason', {
    name,
    status: '準備中',
    leg_enabled: document.getElementById('ns-leg').checked,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('ns-result', false, '作成できません: ' + res.error);
    return;
  }

  setResult('ns-result', true, name + ' を作成しました。');
  document.getElementById('ns-name').value = '';

  cache.seasons = null;
  const seasons = await loadSeasons(true);
  fillSelect('sp-season', seasons, 'season_id', 'name');
  document.getElementById('sp-season').value = res.data.season_id;
  await loadSeasonAdmin();
}

// ---------------------------------------------------------------------------
// 移籍市場の開幕日時
// ---------------------------------------------------------------------------

/**
 * 移籍市場の開幕日時を読み込む。
 *
 * プロテクトの無料期・有料期はこの日時からの逆算で決まる（SPEC.md §7.3）。
 * シートを直接触らないと設定できない状態だったので、画面から直せるようにした。
 */
async function loadMarketWindows() {
  const seasonId = document.getElementById('sp-season').value;
  const season = (await loadSeasons()).find((s) => s.season_id === seasonId);
  if (!season) return;

  const btn = document.getElementById('mw-save');
  if (!btn.dataset.bound) {
    btn.onclick = onSaveMarketWindows;
    btn.dataset.bound = '1';
  }

  document.getElementById('mw-window1').value = toDatetimeLocal(season.window1_open_at);
  document.getElementById('mw-window2').value = toDatetimeLocal(season.window2_open_at);

  renderMarketDerived();
}

/**
 * datetime-local の入力欄に入れられる形（YYYY-MM-DDTHH:mm）へ変換する。
 *
 * @param {string} value
 * @returns {string}
 */
function toDatetimeLocal(value) {
  if (!value) return '';

  const d = new Date(value);
  if (isNaN(d.getTime())) return '';

  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 入力された日時から、プロテクトの期間がいつになるかを出す。
 *
 * 保存する前に「無料はいつからいつまでか」が見えないと、
 * 日程表と食い違っていても気づけない。
 */
function renderMarketDerived() {
  const box = document.getElementById('mw-derived');
  const raw = document.getElementById('mw-window1').value;

  if (!raw) {
    box.innerHTML = '';
    return;
  }

  const open = new Date(raw);
  if (isNaN(open.getTime())) {
    box.innerHTML = '';
    return;
  }

  const shift = (days) => {
    const d = new Date(open.getTime());
    d.setDate(d.getDate() + days);
    return d;
  };

  const fmt = (d) => (d.getMonth() + 1) + '/' + d.getDate() +
    '（' + '日月火水木金土'[d.getDay()] + '）';

  box.innerHTML = `
    <div class="hint-box">
      この日時にすると、第1次のプロテクトはこうなります。
      <ul class="detail-grid-list">
        <li>無料期: ${esc(fmt(shift(-6)))} 〜 ${esc(fmt(shift(-3)))}</li>
        <li>有料期: ${esc(fmt(shift(-1)))} 23:00 〜 市場最終日</li>
      </ul>
      <p class="muted note-sm">日数は Config で変えられます。</p>
    </div>`;
}

/**
 * 移籍市場の開幕日時を保存する。
 */
async function onSaveMarketWindows() {
  const seasonId = document.getElementById('sp-season').value;
  const season = (await loadSeasons()).find((s) => s.season_id === seasonId);
  if (!season) return;

  const btn = document.getElementById('mw-save');
  btn.disabled = true;
  setResult('mw-result', true, '保存中...');

  // upsertSeason は全項目を受け取るので、他の値は今のまま渡す
  const res = await callApi('upsertSeason', {
    season_id: seasonId,
    name: season.name,
    status: season.status,
    leg_enabled: season.leg_enabled,
    window1_open_at: document.getElementById('mw-window1').value,
    window2_open_at: document.getElementById('mw-window2').value,
    claim_deadline_at: season.claim_deadline_at,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('mw-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult('mw-result', true, '日時を保存しました。');
  cache.seasons = null;
  await loadSeasons(true);
  renderMarketDerived();
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
      ${list('現実移籍で離脱', report.dropped_ineligible || [],
        (r) => nameOf(r.team_id) + ' ' + r.name)}
      ${list('スポンサーのノルマ', report.sponsor_results || [],
        (r) => r.team_name + ' ' + r.sponsor_name + ' ' + (r.met ? '達成' : '未達（' + r.actual + '）−' + formatMoney(r.penalty)))}
    </div>
    <p class="muted note-sm">
      期限切れで離脱: ${report.expired} 名
      ／ 現実移籍で離脱: ${(report.dropped_ineligible || []).length} 名
      ／ 次シーズンへ引継ぎ: ${report.carried} 名
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

  // 設定の読み込みで失敗しても申請一覧は出す。
  // 片方の不具合でもう片方が見えなくなるのを避ける。
  try {
    await loadSignupConfig();
  } catch (e) {
    console.error('[signup] 設定の読み込みに失敗:', e);
    setResult('sg-config-result', false, '設定を読み込めませんでした: ' + e.message);
  }

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
    setResult('sg-config-result', false, '設定の取得に失敗しました: ' + res.error);
    return;
  }

  // listConfig は配列ではなく { key: value } のオブジェクトを返す
  const map = res.data || {};

  document.getElementById('sg-code').value = map.signup_code || '';
  document.getElementById('sg-open').checked =
    map.signup_open === true || String(map.signup_open).toLowerCase() === 'true';

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

  // 承認時にクラブを差し替えられるよう、空きクラブの一覧を取っておく
  const clubRes = await callApi('getSignupClubs', {});
  const clubData = clubRes.ok ? clubRes.data : null;

  const clubSelect = (signupId, current) => {
    if (!clubData) {
      // 一覧が取れないときは表示だけにする（自由記入に戻さない）
      return esc(current);
    }

    const opts = clubData.categories
      .map((cat) => {
        const items = clubData.clubs[cat]
          .map((c) => {
            // 申請者本人が押さえているクラブは taken にならない
            const label = c.taken ? c.club_name + '（' + c.taken_reason + '）' : c.club_name;
            return '<option value="' + esc(c.club_name) + '"' +
              (c.taken && c.club_name !== current ? ' disabled' : '') +
              (c.club_name === current ? ' selected' : '') +
              '>' + esc(label) + '</option>';
          })
          .join('');
        return '<optgroup label="' + esc(cat) + '">' + items + '</optgroup>';
      })
      .join('');

    return '<select class="sg-team-input" data-id="' + esc(signupId) + '">' + opts + '</select>';
  };

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
          <td>${pending ? clubSelect(r.signup_id, r.team_name) : esc(r.team_name)}</td>
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
      チームは承認前なら主催者が差し替えられます。既に使われているクラブは選べません。
      選択肢に出るのは Config の <code>signup_club_categories</code> で許可したカテゴリだけです。
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

// ---------------------------------------------------------------------------
// 現実移籍の反映（主催者のみ）
// ---------------------------------------------------------------------------

/** getRealTransferTargets の結果 */
let realTransferData = null;

/**
 * 現実移籍の反映画面を読み込む。
 * 運営タブの loadSeasonAdmin から呼ばれる。
 */
async function loadRealTransfers() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  const searchBtn = document.getElementById('rt-search');
  if (!searchBtn.dataset.bound) {
    searchBtn.onclick = loadRealTransfers;
    document.getElementById('rt-owned').onchange = loadRealTransfers;
    document.getElementById('rt-apply').onclick = onApplyRealTransfers;
    document.getElementById('rt-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadRealTransfers();
    });
    searchBtn.dataset.bound = '1';
  }

  setLoading('rt-list');

  const res = await callApi('getRealTransferTargets', {
    season_id: seasonId,
    keyword: document.getElementById('rt-keyword').value.trim(),
    only_owned: document.getElementById('rt-owned').checked,
  });

  if (!res.ok) {
    setError('rt-list', '選手一覧の取得に失敗しました: ' + res.error);
    return;
  }

  realTransferData = res.data;
  renderRealTransferList();
}

/**
 * 選手一覧を描画する。
 *
 * 既に対象外の選手も表示する。誤って外した場合に気づけるようにするため。
 */
function renderRealTransferList() {
  const d = realTransferData;
  const box = document.getElementById('rt-list');

  if (d.players.length === 0) {
    box.innerHTML = '<p class="muted">該当する選手がいません。</p>';
    document.getElementById('rt-summary').innerHTML = '';
    document.getElementById('rt-apply').disabled = true;
    return;
  }

  const rows = d.players
    .map((p) => {
      if (!p.eligible) {
        return `
        <tr class="row-ineligible">
          <td><span class="muted">対象外</span></td>
          <td><span class="pos pos-${esc(p.position)}">${esc(p.position)}</span> ${esc(p.name)}</td>
          <td class="muted">${esc(p.real_club)}</td>
          <td class="muted">${esc(p.team_name || '—')}</td>
          <td class="num muted">—</td>
          <td>
            <button type="button" class="btn btn-secondary btn-sm rt-restore"
                    data-id="${esc(p.player_id)}">戻す</button>
          </td>
        </tr>`;
      }

      const comp = p.compensable
        ? formatMoney(p.compensation)
        : '<span class="muted">なし</span>';

      return `
      <tr>
        <td>
          <input type="checkbox" class="rt-check" data-id="${esc(p.player_id)}"
                 data-team="${esc(p.team_id)}" data-amount="${p.compensation}" />
        </td>
        <td><span class="pos pos-${esc(p.position)}">${esc(p.position)}</span> ${esc(p.name)}</td>
        <td class="muted">${esc(p.real_club)}</td>
        <td>${p.owned ? esc(p.team_name) : '<span class="muted">保有なし</span>'}</td>
        <td class="num">${comp}</td>
        <td class="muted">${esc(p.acquisition_type)}</td>
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <div class="table-wrap scroll-list">
      <table class="data-table">
        <thead>
          <tr>
            <th>選択</th><th>選手</th><th>実クラブ</th><th>保有チーム</th>
            <th class="num">補填金</th><th>獲得方法</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">
      補填金は獲得額 × ${Math.round(d.rate * 100)}%。
      オークション獲得と獲得額0の選手は補填の対象外です。
    </p>`;

  box.querySelectorAll('.rt-check').forEach((c) => {
    c.onchange = renderRealTransferSummary;
  });
  box.querySelectorAll('.rt-restore').forEach((b) => {
    b.onclick = () => onRestorePlayer(b.dataset.id);
  });

  renderRealTransferSummary();
}

/**
 * 選択内容から、補填の合計と各チームの残り人数を出す。
 *
 * 人数が squad_min を割るチームは警告する。
 * 反映してから気づくと、参加者に説明が必要になるため。
 */
function renderRealTransferSummary() {
  const d = realTransferData;
  const checked = [...document.querySelectorAll('.rt-check:checked')];
  const box = document.getElementById('rt-summary');

  document.getElementById('rt-apply').disabled = checked.length === 0;

  if (checked.length === 0) {
    box.innerHTML = '';
    return;
  }

  let total = 0;
  const lossByTeam = {};

  checked.forEach((c) => {
    total += Number(c.dataset.amount) || 0;
    const tid = c.dataset.team;
    if (tid) lossByTeam[tid] = (lossByTeam[tid] || 0) + 1;
  });

  const affected = d.teams
    .filter((t) => lossByTeam[t.team_id])
    .map((t) => {
      const after = t.squad - lossByTeam[t.team_id];
      const short = after < d.squad_min;
      return `
        <li>
          ${esc(t.team_name)}: ${t.squad} → <strong>${after}</strong> 名
          ${short ? '<span class="tag-ng">下限' + d.squad_min + '名を下回る</span>' : ''}
        </li>`;
    })
    .join('');

  const anyShort = d.teams.some(
    (t) => lossByTeam[t.team_id] && t.squad - lossByTeam[t.team_id] < d.squad_min
  );

  box.innerHTML = `
    <div class="${anyShort ? 'warn-box' : 'hint-box'}">
      <strong>${checked.length} 名を対象外にします。</strong>
      補填金の合計 ${esc(formatMoney(total))}
      <ul class="detail-grid-list">${affected || '<li class="muted">保有チームなし</li>'}</ul>
      <p class="muted note-sm">
        人数は翌シーズンの見込みです。今シーズンのスカッドは変わりません。
        ${anyShort
          ? '<strong>下限を割るチームがあります。</strong>移籍市場で補充が必要になることを伝えてください。'
          : ''}
      </p>
    </div>`;
}

/**
 * 選択した選手をまとめて対象外にする。
 */
async function onApplyRealTransfers() {
  const checked = [...document.querySelectorAll('.rt-check:checked')];
  if (checked.length === 0) return;

  const ids = checked.map((c) => c.dataset.id);
  const names = checked.map((c) => c.closest('tr').children[1].textContent.trim());

  const msg =
    ids.length + ' 名を大会の対象外にします。\n\n' +
    names.slice(0, 10).join('\n') +
    (names.length > 10 ? '\n...ほか ' + (names.length - 10) + ' 名' : '') +
    '\n\n補填金がこの場で計上されます。よろしいですか？';

  if (!confirm(msg)) return;

  const btn = document.getElementById('rt-apply');
  btn.disabled = true;
  setResult('rt-result', true, '反映中...');

  const res = await callApi('applyRealTransfers', {
    season_id: document.getElementById('sp-season').value,
    player_ids: ids,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('rt-result', false, '反映できません: ' + res.error);
    return;
  }

  setResult('rt-result', true, res.data.applied_count + ' 名を対象外にしました。');
  renderRealTransferReport(res.data);

  await loadRealTransfers();
}

/**
 * 反映結果を表示する。
 *
 * @param {Object} d applyRealTransfers のレスポンス
 */
function renderRealTransferReport(d) {
  const box = document.getElementById('rt-report');

  const comp = d.compensations.length
    ? '<ul class="detail-grid-list">' +
      d.compensations
        .map((c) =>
          '<li>' + esc(c.team_name) + ' ← ' + esc(c.name) + ' ' +
          esc(formatMoney(c.amount)) + '（獲得額 ' + esc(formatMoney(c.acquired_cost)) + '）</li>'
        )
        .join('') +
      '</ul>'
    : '<p class="muted">補填金の発生はありません。</p>';

  const skipped = d.skipped.length
    ? '<p class="muted note-sm">対象外にできなかった選手: ' +
      d.skipped.map((s) => esc((s.name || s.player_id) + '（' + s.reason + '）')).join(' / ') +
      '</p>'
    : '';

  box.innerHTML = `
    <h3 class="sub-head">反映結果</h3>
    <p>対象外にした選手: <strong>${d.applied_count} 名</strong>
       ／ 補填金の合計: <strong>${esc(formatMoney(d.total_amount))}</strong></p>
    ${comp}
    ${skipped}
    <p class="muted note-sm">
      この選手たちはシーズン終了処理のときにスカッドから外れます。
      今シーズンの試合には引き続き出場できます。
    </p>`;
}

/**
 * 誤って対象外にした選手を戻す。
 *
 * @param {string} playerId
 */
async function onRestorePlayer(playerId) {
  if (!confirm('この選手を大会の対象に戻します。\n\n補填金は取り消されません。よろしいですか？')) return;

  const res = await callApi('restorePlayerEligible', { player_id: playerId });

  if (!res.ok) {
    setResult('rt-result', false, '戻せません: ' + res.error);
    return;
  }

  setResult('rt-result', true, res.data.name + ' を対象に戻しました。補填金は残っています。');
  await loadRealTransfers();
}

// ---------------------------------------------------------------------------
// 画面: 補填の選択（参加者）
// ---------------------------------------------------------------------------

/** getMyClaims の結果 */
let myClaimData = null;

/**
 * 補填の選択画面を初期化する。
 */
async function renderClaims() {
  const seasons = await loadSeasons();
  fillSelect('cl-season', seasons, 'season_id', 'name');

  const sel = document.getElementById('cl-season');

  // 主催者は代理で他チームの選択を入力できる
  const teamWrap = document.getElementById('cl-team-wrap');
  if (currentUser.role === 'organizer') {
    teamWrap.style.display = '';
    fillSelect('cl-team', (await loadTeams()).filter((t) => t.active), 'team_id', 'name');
  } else {
    teamWrap.style.display = 'none';
  }

  if (!sel.dataset.bound) {
    sel.onchange = loadMyClaims;
    document.getElementById('cl-team').onchange = loadMyClaims;
    sel.dataset.bound = '1';
  }

  await loadMyClaims();
}

/**
 * 自分（または選択したチーム）の請求を読み込む。
 */
async function loadMyClaims() {
  const seasonId = document.getElementById('cl-season').value;
  if (!seasonId) return;

  setLoading('cl-list');

  const payload = { season_id: seasonId };
  if (currentUser.role === 'organizer') {
    payload.team_id = document.getElementById('cl-team').value;
  }

  const res = await callApi('getMyClaims', payload);
  if (!res.ok) {
    setError('cl-list', '補填の情報を取得できませんでした: ' + res.error);
    return;
  }

  myClaimData = res.data;
  renderClaimStatus();
  renderClaimList();
}

/**
 * 期限と残件数を上部に出す。
 */
function renderClaimStatus() {
  const d = myClaimData;
  const box = document.getElementById('cl-status');

  if (d.claims.length === 0) {
    box.innerHTML = '';
    return;
  }

  const deadline = d.deadline
    ? new Date(d.deadline).toLocaleString('ja-JP')
    : '未設定';

  box.innerHTML = `
    <div class="${d.window_open ? 'hint-box' : 'warn-box'}">
      <strong>${esc(d.team_name)}</strong>
      ／ 選択期限: ${esc(deadline)}
      ／ 未選択 ${d.pending_count} 件
      <p class="muted note-sm">
        ${d.window_open
          ? '期限までに選んでください。選ばなかった場合は「' + esc(d.default_choice) + '」として扱われます。'
          : '<strong>選択期限を過ぎています。</strong>変更したい場合は主催者に連絡してください。'}
      </p>
    </div>`;
}

/**
 * 請求を1件ずつカードで出す。
 *
 * 選択肢が2つしかないので、ラジオではなくボタン2つにして
 * 「押したら決まる」ことが分かるようにする。
 */
function renderClaimList() {
  const d = myClaimData;
  const box = document.getElementById('cl-list');

  if (d.claims.length === 0) {
    box.innerHTML = '<p class="muted">補填の対象はありません。</p>';
    return;
  }

  const canEdit = (c) =>
    c.status !== '精算済' && c.status !== '無効' &&
    (d.window_open || currentUser.role === 'organizer');

  const options = d.candidates
    .map((c) => '<option value="' + esc(c.player_id) + '">' +
      esc(c.position + ' ' + c.name) + '</option>')
    .join('');

  box.innerHTML = d.claims
    .map((c) => {
      const settled = c.status === '精算済';
      const chosen = c.choice !== '未選択';

      const state = settled
        ? '<span class="tag-ok">精算済（' + esc(c.choice) + '）</span>'
        : chosen
          ? '<span class="tag-ok">' + esc(c.choice) + ' で確定</span>'
          : '<span class="tag-wait">未選択</span>';

      const swapArea = canEdit(c)
        ? `
          <div class="claim-actions">
            <button type="button" class="btn btn-primary btn-sm cl-refund" data-id="${esc(c.claim_id)}">
              払い戻し ${esc(formatMoney(c.refund_amount))}
            </button>
            <span class="muted">または</span>
            <select class="cl-swap-select" data-id="${esc(c.claim_id)}">
              <option value="">入れ替える選手を選択</option>
              ${options}
            </select>
            <button type="button" class="btn btn-secondary btn-sm cl-swap" data-id="${esc(c.claim_id)}">
              入れ替える
            </button>
          </div>`
        : '';

      return `
        <div class="card claim-card">
          <div class="claim-head">
            <strong><span class="pos pos-${esc(c.position)}">${esc(c.position)}</span>
              ${esc(c.player_name)}</strong>
            ${state}
          </div>
          <p class="muted note-sm">
            理由: ${esc(c.reason)}
            ／ 獲得額 ${esc(formatMoney(c.base_cost))} × ${Math.round(c.rate * 100)}%
            ＝ 払い戻し ${esc(formatMoney(c.refund_amount))}
            ${c.replacement_name ? '／ 入れ替え先: <strong>' + esc(c.replacement_name) + '</strong>' : ''}
          </p>
          ${swapArea}
        </div>`;
    })
    .join('');

  // 既に選んだ入れ替え先を選択状態にしておく
  d.claims.forEach((c) => {
    if (!c.replacement_id) return;
    const sel = box.querySelector('.cl-swap-select[data-id="' + c.claim_id + '"]');
    if (!sel) return;
    if (![...sel.options].some((o) => o.value === c.replacement_id)) {
      const opt = document.createElement('option');
      opt.value = c.replacement_id;
      opt.textContent = c.replacement_name;
      sel.appendChild(opt);
    }
    sel.value = c.replacement_id;
  });

  box.querySelectorAll('.cl-refund').forEach((b) => {
    b.onclick = () => onChooseClaim(b.dataset.id, '払い戻し');
  });
  box.querySelectorAll('.cl-swap').forEach((b) => {
    b.onclick = () => {
      const sel = box.querySelector('.cl-swap-select[data-id="' + b.dataset.id + '"]');
      onChooseClaim(b.dataset.id, '入れ替え', sel.value);
    };
  });
}

/**
 * 払い戻しか入れ替えかを送る。
 *
 * @param {string} claimId
 * @param {string} choice
 * @param {string} [replacementId]
 */
async function onChooseClaim(claimId, choice, replacementId) {
  if (choice === '入れ替え' && !replacementId) {
    alert('入れ替える選手を選んでください。');
    return;
  }

  // 主催者が代理で入力する場合は override を使う（期限後でも通る）
  const action = currentUser.role === 'organizer' ? 'overrideClaim' : 'chooseClaim';

  const res = await callApi(action, {
    claim_id: claimId,
    choice,
    replacement_player_id: replacementId || '',
  });

  if (!res.ok) {
    alert('選択できません: ' + res.error);
    return;
  }

  await loadMyClaims();
}

// ---------------------------------------------------------------------------
// 補填の請求と精算（主催者）
// ---------------------------------------------------------------------------

/**
 * 請求一覧と精算の画面を読み込む。
 */
async function loadClaimAdmin() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  const btn = document.getElementById('cs-settle');
  if (!btn.dataset.bound) {
    btn.onclick = onSettleClaims;
    document.getElementById('cs-save-deadline').onclick = onSaveClaimDeadline;
    btn.dataset.bound = '1';
  }

  setLoading('cs-list');

  const res = await callApi('listClaims', { season_id: seasonId });
  if (!res.ok) {
    setError('cs-list', '請求一覧を取得できませんでした: ' + res.error);
    return;
  }

  const d = res.data;

  document.getElementById('cs-deadline').value = d.deadline
    ? d.deadline.slice(0, 16)
    : '';

  document.getElementById('cs-summary').innerHTML = `
    <div class="${d.window_open ? 'hint-box' : 'warn-box'}">
      未選択 <strong>${d.waiting}</strong> 件
      ／ 選択済み <strong>${d.fixed}</strong> 件
      ／ 精算済み <strong>${d.settled}</strong> 件
      <p class="muted note-sm">
        ${d.window_open
          ? '選択期限内です。期限を過ぎるまで精算はできません。'
          : '期限を過ぎています。精算を実行できます。'}
        未選択のまま精算すると「${esc(d.default_choice)}」として処理されます。
      </p>
    </div>`;

  document.getElementById('cs-settle').disabled = d.window_open || (d.waiting + d.fixed) === 0;

  const box = document.getElementById('cs-list');

  if (d.claims.length === 0) {
    box.innerHTML = '<p class="muted">補填の請求はありません。</p>';
    return;
  }

  const rows = d.claims
    .map((c) => `
      <tr>
        <td>${esc(c.team_name)}</td>
        <td>${esc(c.player_name)}</td>
        <td class="muted">${esc(c.reason)}</td>
        <td class="num">${esc(formatMoney(c.refund_amount))}</td>
        <td>${c.choice === '未選択'
          ? '<span class="tag-wait">未選択</span>'
          : esc(c.choice) + (c.replacement_name ? '（' + esc(c.replacement_name) + '）' : '')}</td>
        <td>${esc(c.status)}</td>
        <td>${c.status === '精算済'
          ? '<span class="muted">—</span>'
          : '<button type="button" class="btn btn-secondary btn-sm cs-void" data-id="' +
            esc(c.claim_id) + '">無効化</button>'}</td>
      </tr>`)
    .join('');

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>チーム</th><th>選手</th><th>理由</th>
            <th class="num">払い戻し額</th><th>選択</th><th>状態</th><th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">
      参加者の代わりに選ぶ場合は「補填の選択」タブでチームを切り替えてください。期限後でも入力できます。
    </p>`;

  box.querySelectorAll('.cs-void').forEach((b) => {
    b.onclick = () => onVoidClaim(b.dataset.id);
  });
}

/**
 * 選択期限を保存する。
 */
async function onSaveClaimDeadline() {
  const seasonId = document.getElementById('sp-season').value;
  const seasons = await loadSeasons();
  const season = seasons.find((s) => s.season_id === seasonId);
  if (!season) return;

  const btn = document.getElementById('cs-save-deadline');
  btn.disabled = true;
  setResult('cs-deadline-result', true, '保存中...');

  // upsertSeason は全項目を受け取るので、既存値を維持したまま期限だけ差し替える
  const res = await callApi('upsertSeason', {
    season_id: seasonId,
    name: season.name,
    status: season.status,
    leg_enabled: season.leg_enabled,
    window1_open_at: season.window1_open_at,
    window2_open_at: season.window2_open_at,
    claim_deadline_at: document.getElementById('cs-deadline').value,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('cs-deadline-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult('cs-deadline-result', true, '期限を保存しました。');
  cache.seasons = null;
  await loadSeasons(true);
  await loadClaimAdmin();
}

/**
 * 期限後の一括精算。
 */
async function onSettleClaims() {
  if (!confirm(
    '補填をまとめて精算します。\n\n' +
    '払い戻しは予算に入金され、入れ替えは選手がスカッドに加わります。\n' +
    '未選択の請求は既定の扱いになります。よろしいですか？'
  )) return;

  const btn = document.getElementById('cs-settle');
  btn.disabled = true;
  setResult('cs-result', true, '精算中...');

  const res = await callApi('settleClaims', {
    season_id: document.getElementById('sp-season').value,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('cs-result', false, '精算できません: ' + res.error);
    return;
  }

  setResult('cs-result', true, res.data.settled_count + ' 件を精算しました。');
  renderSettleReport(res.data);
  await loadClaimAdmin();
}

/**
 * 精算結果を表示する。
 *
 * @param {Object} d settleClaims のレスポンス
 */
function renderSettleReport(d) {
  const box = document.getElementById('cs-report');

  const list = (title, rows, fmt) =>
    rows.length
      ? '<div><h4 class="rank-title">' + esc(title) + '</h4><ul class="detail-grid-list">' +
        rows.map((r) => '<li>' + esc(fmt(r)) + '</li>').join('') + '</ul></div>'
      : '';

  box.innerHTML = `
    <h3 class="sub-head">精算の結果</h3>
    <p>払い戻しの合計: <strong>${esc(formatMoney(d.refund_total))}</strong></p>
    <div class="detail-grid">
      ${list('払い戻し', d.refunds, (r) => r.team_name + ' ' + r.player_name + ' ' + formatMoney(r.amount))}
      ${list('入れ替え', d.swaps, (r) => r.team_name + ' ' + r.lost_player + ' → ' + r.got_player)}
      ${list('払い戻しに変更', d.failed, (r) => r.team_name + ' ' + r.reason)}
    </div>`;
}

/**
 * 請求を無効にする。
 *
 * @param {string} claimId
 */
async function onVoidClaim(claimId) {
  if (!confirm('この請求を無効にします。補填は行われません。よろしいですか？')) return;

  const res = await callApi('voidClaim', { claim_id: claimId });

  if (!res.ok) {
    setResult('cs-result', false, '無効にできません: ' + res.error);
    return;
  }

  await loadClaimAdmin();
}

// ---------------------------------------------------------------------------
// 辞退・チーム変更（主催者）
// ---------------------------------------------------------------------------

/**
 * 辞退・チーム変更の画面を用意する。
 */
async function loadWithdraw() {
  const teams = (await loadTeams()).filter((t) => t.active);
  fillSelect('wd-team', teams, 'team_id', 'name', 'チームを選択');

  const kindSel = document.getElementById('wd-kind');
  if (!kindSel.dataset.bound) {
    kindSel.onchange = onWithdrawKindChange;
    document.getElementById('wd-submit').onclick = onSubmitWithdraw;
    kindSel.dataset.bound = '1';
  }

  await onWithdrawKindChange();
}

/**
 * 種別に応じて「変更後のクラブ」を出し入れする。
 */
async function onWithdrawKindChange() {
  const isChange = document.getElementById('wd-kind').value === 'チーム変更';
  document.getElementById('wd-club-wrap').style.display = isChange ? '' : 'none';

  if (!isChange) return;

  const res = await callApi('getSignupClubs', {});
  if (!res.ok) return;

  const opts = res.data.categories
    .map((cat) => {
      const items = res.data.clubs[cat]
        .map((c) => '<option value="' + esc(c.club_name) + '"' + (c.taken ? ' disabled' : '') + '>' +
          esc(c.taken ? c.club_name + '（' + c.taken_reason + '）' : c.club_name) + '</option>')
        .join('');
      return '<optgroup label="' + esc(cat) + '">' + items + '</optgroup>';
    })
    .join('');

  document.getElementById('wd-club').innerHTML =
    '<option value="">クラブを選択</option>' + opts;
}

/**
 * 辞退・チーム変更を実行する。
 */
async function onSubmitWithdraw() {
  const teamId = document.getElementById('wd-team').value;
  const kind = document.getElementById('wd-kind').value;
  const newClub = document.getElementById('wd-club').value;

  if (!teamId) {
    setResult('wd-result', false, 'チームを選んでください。');
    return;
  }
  if (kind === 'チーム変更' && !newClub) {
    setResult('wd-result', false, '変更後のクラブを選んでください。');
    return;
  }

  const teamName = document.getElementById('wd-team')
    .selectedOptions[0].textContent;

  const msg = kind === '辞退'
    ? teamName + ' を大会から外します。\n\n' +
      'このクラブの選手は全員が大会の対象外になり、\n' +
      '保有している他チームには補填の請求が立ちます。\n\n取り消せません。よろしいですか？'
    : teamName + ' を ' + newClub + ' に変更します。\n\n' +
      '【完全リセット】新規参加者と同じ状態から始まります。\n' +
      '  ・スカッドは全員解散（移籍で獲得した選手も含む）\n' +
      '  ・予算は初期値に戻る\n' +
      '  ・プロテクト、エントリー、進行中の移籍申請は無効\n\n' +
      '変更前のクラブの選手は大会の対象外になり、\n' +
      '保有している他チームには補填の請求が立ちます。\n\n取り消せません。よろしいですか？';

  if (!confirm(msg)) return;

  const btn = document.getElementById('wd-submit');
  btn.disabled = true;
  setResult('wd-result', true, '実行中...');

  const res = await callApi('withdrawTeam', {
    season_id: document.getElementById('sp-season').value,
    team_id: teamId,
    kind,
    new_club: newClub,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('wd-result', false, '実行できません: ' + res.error);
    return;
  }

  const d = res.data;
  setResult('wd-result', true, d.kind + ' を反映しました。');

  const reset = d.reset
    ? `
      <p><strong>リセットの内容</strong></p>
      <ul class="detail-grid-list">
        <li>予算: ${esc(formatMoney(d.reset.budget_before))} → <strong>${esc(formatMoney(d.reset.budget_after))}</strong></li>
        <li>解除したプロテクト: ${d.reset.protections} 件</li>
        <li>取り消したエントリー: ${d.reset.entries} 件</li>
        <li>差し戻した移籍申請: ${d.reset.transfers} 件</li>
        <li>無効にした補填請求: ${d.reset.claims} 件</li>
      </ul>
      <p class="muted note-sm">
        新規参加者と同じ状態です。新しいクラブでエントリーし直してもらってください。
      </p>`
    : '';

  document.getElementById('wd-report').innerHTML = `
    <div class="hint-box">
      <strong>${esc(d.old_club)}</strong> が大会から外れました
      ${d.new_club ? '（新しいクラブ: <strong>' + esc(d.new_club) + '</strong>）' : ''}
      <ul class="detail-grid-list">
        <li>対象外になった選手: ${d.ineligible} 名</li>
        <li>スカッドから外れた選手: ${d.released} 名</li>
        <li>立った請求: ${d.claims.length} 件（払い戻しなら合計 ${esc(formatMoney(d.claim_total))}）</li>
      </ul>
      ${reset}
      <p class="muted note-sm">${esc(d.note)}</p>
    </div>`;

  cache.teams = null;
  await loadTeams(true);
  await loadSeasonAdmin();
}

// ---------------------------------------------------------------------------
// 画面: 日程（全ロール）
// ---------------------------------------------------------------------------

/**
 * 日程タブを初期化する。
 */
async function renderSchedule() {
  const seasons = await loadSeasons();
  fillSelect('sd-season', seasons, 'season_id', 'name');

  const sel = document.getElementById('sd-season');
  if (!sel.dataset.bound) {
    sel.onchange = loadScheduleView;
    sel.dataset.bound = '1';
  }

  await loadScheduleView();
}

/**
 * 選択中シーズンの日程を描画する。
 */
async function loadScheduleView() {
  const seasonId = document.getElementById('sd-season').value;
  if (!seasonId) return;

  setLoading('sd-list');

  const res = await callApi('getSeasonSchedule', { season_id: seasonId });
  if (!res.ok) {
    setError('sd-list', '日程を取得できませんでした: ' + res.error);
    return;
  }

  scheduleView = res.data;
  renderScheduleNext(res.data);
  renderScheduleFilter();
  applyScheduleFilter();
}

/** getSeasonSchedule の結果（絞り込みで使い回す） */
let scheduleView = null;

/** 選択中の分類。空文字はすべて */
let scheduleFilter = '';

/**
 * 分類の絞り込みボタンを出す。
 *
 * 予定が20件を超えると、目当ての締切を探すのに一覧を上から追うことになる。
 * 「プロテクトだけ」「監督だけ」に絞れれば、その1本だけを追える。
 *
 * 選択肢はサーバーが返した**実際に使われている分類だけ**。
 * 空の絞り込みが並んでも押す意味がない。
 */
function renderScheduleFilter() {
  const box = document.getElementById('sd-filter');
  const cats = (scheduleView && scheduleView.categories) || [];

  if (cats.length <= 1) {
    box.innerHTML = '';
    return;
  }

  const chip = (value, label) => {
    const on = scheduleFilter === value;
    return '<button type="button" class="chip' + (on ? ' chip-on' : '') +
      '" data-cat="' + esc(value) + '">' + esc(label) + '</button>';
  };

  box.innerHTML =
    '<div class="chip-row">' +
    chip('', 'すべて') +
    cats.map((c) => chip(c, c)).join('') +
    '</div>';

  box.querySelectorAll('.chip').forEach((b) => {
    b.onclick = () => {
      scheduleFilter = b.dataset.cat;
      renderScheduleFilter();
      applyScheduleFilter();
    };
  });
}

/**
 * 絞り込みを反映して一覧を描き直す。
 */
function applyScheduleFilter() {
  const d = scheduleView;
  if (!d) return;

  const items = scheduleFilter
    ? d.items.filter((i) => i.category === scheduleFilter)
    : d.items;

  const view = Object.assign({}, d, { items, count: items.length });

  document.getElementById('sd-list').innerHTML = scheduleFilter && items.length === 0
    ? '<p class="muted">「' + esc(scheduleFilter) + '」の予定はありません。</p>'
    : scheduleTableHtml(view, false);
}

/**
 * 「今日」と「次の予定」を上部に出す。
 *
 * 一覧を上から探させるより、まずここを見れば済むようにする。
 */
function renderScheduleNext(d) {
  const box = document.getElementById('sd-next');

  if (d.count === 0) {
    box.innerHTML = '';
    return;
  }

  const today = d.today_items.length
    ? '<li><strong>今日:</strong> ' +
      d.today_items.map((i) => esc(i.label)).join(' / ') + '</li>'
    : '';

  const next = d.next
    ? '<li><strong>次:</strong> ' + esc(d.next.date_label) +
      '（' + esc(d.next.weekday) + '） ' + esc(d.next.label) +
      ' — あと <strong>' + d.next.days_left + '</strong> 日</li>'
    : '<li class="muted">この先の予定はありません。</li>';

  const rest = d.upcoming.slice(1)
    .map((i) => '<li class="muted">' + esc(i.date_label) + '（' + esc(i.weekday) + '） ' +
      esc(i.label) + '</li>')
    .join('');

  box.innerHTML = `
    <div class="hint-box">
      <ul class="detail-grid-list">
        ${today}
        ${next}
        ${rest}
      </ul>
    </div>`;
}

/**
 * 日程表の HTML を作る。主催者向けは編集ボタンを付ける。
 *
 * 同じ日付が続く場合は2行目以降の日付欄を空にして、
 * 「その日にまとめて起きること」が見た目で分かるようにする。
 *
 * @param {Object} d getSeasonSchedule の結果
 * @param {boolean} editable
 * @returns {string} HTML
 */
function scheduleTableHtml(d, editable) {
  if (d.count === 0) {
    return '<p class="muted">日程はまだ作成されていません。</p>';
  }

  let prevDate = '';

  const rows = d.items
    .map((i) => {
      // date は時刻まで持つので、同じ日でも一致しない項目がある
      // （有料プロテクト開始は23:00）。表示用の日付で比べる
      const sameDay = i.date_label === prevDate;
      prevDate = i.date_label;

      const cls = [
        i.is_today ? 'row-today' : '',
        i.is_past ? 'row-past' : '',
        i.done ? 'row-done' : '',
      ].filter(Boolean).join(' ');

      const dateCell = sameDay
        ? '<td class="muted">〃</td>'
        : '<td><strong>' + esc(i.date_label) + '</strong>' +
          '<span class="muted">（' + esc(i.weekday) + '）</span></td>';

      const state = i.done
        ? '<span class="tag-ok">済</span>'
        : i.is_today
          ? '<span class="tag-wait">本日</span>'
          : i.is_past
            ? '<span class="muted">—</span>'
            : '<span class="muted">あと' + i.days_left + '日</span>';

      // 導出項目は SeasonSchedule に行が無いので編集も削除もできない
      const actions = editable
        ? (i.derived
          ? '<td><span class="muted">自動</span></td>'
          : `<td>
               <button type="button" class="btn btn-secondary btn-sm sd-edit"
                       data-id="${esc(i.schedule_id)}">編集</button>
               <button type="button" class="btn btn-secondary btn-sm sd-del"
                       data-id="${esc(i.schedule_id)}">削除</button>
             </td>`)
        : '';

      return `
        <tr class="${cls}">
          ${dateCell}
          <td>${esc(i.label)}${i.note ? '<br><span class="muted note-sm">' + esc(i.note) + '</span>' : ''}</td>
          <td>${state}</td>
          ${actions}
        </tr>`;
    })
    .join('');

  return `
    <div class="table-wrap">
      <table class="data-table schedule-table">
        <thead>
          <tr>
            <th>日付</th><th>予定</th><th>状況</th>${editable ? '<th>操作</th>' : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// 日程表の管理（主催者）
// ---------------------------------------------------------------------------

/** getScheduleTemplate の結果 */
let scheduleTemplateRows = [];

/**
 * 運営タブの日程表セクションを読み込む。
 */
async function loadScheduleAdmin() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  const btn = document.getElementById('sg-generate');
  if (!btn.dataset.bound) {
    btn.onclick = onGenerateSchedule;
    document.getElementById('sg-add-item').onclick = () => onEditScheduleItem(null);
    document.getElementById('sg-template-add').onclick = onAddTemplateRow;
    document.getElementById('sg-template-save').onclick = onSaveTemplate;
    btn.dataset.bound = '1';
  }

  await loadAdminSchedule();
  await loadTemplateEditor();
}

/**
 * そのシーズンの日程を編集モードで描画する。
 */
async function loadAdminSchedule() {
  const seasonId = document.getElementById('sp-season').value;

  setLoading('sg-schedule');

  const res = await callApi('getSeasonSchedule', { season_id: seasonId });
  if (!res.ok) {
    setError('sg-schedule', '日程を取得できませんでした: ' + res.error);
    return;
  }

  const box = document.getElementById('sg-schedule');
  box.innerHTML = scheduleTableHtml(res.data, true);

  box.querySelectorAll('.sd-edit').forEach((b) => {
    const item = res.data.items.find((i) => i.schedule_id === b.dataset.id);
    b.onclick = () => onEditScheduleItem(item);
  });
  box.querySelectorAll('.sd-del').forEach((b) => {
    b.onclick = () => onDeleteScheduleItem(b.dataset.id);
  });
}

/**
 * 開幕日からひな型を展開する。
 */
async function onGenerateSchedule() {
  const seasonId = document.getElementById('sp-season').value;
  const date = document.getElementById('sg-open-date').value;
  const overwrite = document.getElementById('sg-overwrite').checked;

  if (!date) {
    setResult('sg-gen-result', false, 'リーグ戦の開幕日を入れてください。');
    return;
  }

  if (overwrite && !confirm(
    '既存の日程をすべて削除して作り直します。\n' +
    '個別に調整した内容も消えます。よろしいですか？'
  )) return;

  const btn = document.getElementById('sg-generate');
  btn.disabled = true;
  setResult('sg-gen-result', true, '作成中...');

  const res = await callApi('generateSchedule', {
    season_id: seasonId,
    opening_date: date,
    overwrite,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('sg-gen-result', false, res.error);
    return;
  }

  // 準備期間は開幕の23日前から始まる。開幕日が近すぎると締切が過去日になるので知らせる
  const past = res.data.past_count || 0;
  setResult(
    'sg-gen-result', past === 0,
    res.data.count + ' 件の日程を作成しました。' +
    (past > 0
      ? ' ただし ' + past + ' 件が過去の日付です。開幕日を後ろへずらすか、個別に編集してください。'
      : '')
  );
  document.getElementById('sg-overwrite').checked = false;
  await loadAdminSchedule();
}

/**
 * 予定を1件追加・編集する。
 *
 * @param {Object|null} item 既存の予定。null なら新規
 */
async function onEditScheduleItem(item) {
  const seasonId = document.getElementById('sp-season').value;

  const label = prompt('予定の名前', item ? item.label : '');
  if (label === null || !label.trim()) return;

  const date = prompt(
    '日付（YYYY-MM-DD）',
    item ? String(item.date).slice(0, 10) : ''
  );
  if (date === null || !date.trim()) return;

  const note = prompt('補足（任意）', item ? item.note : '');
  if (note === null) return;

  const res = await callApi('upsertScheduleItem', {
    schedule_id: item ? item.schedule_id : '',
    season_id: seasonId,
    date: date.trim(),
    label: label.trim(),
    note,
    sort_order: item ? item.sort_order : 999,
    done: item ? item.done : false,
  });

  if (!res.ok) {
    alert('保存できません: ' + res.error);
    return;
  }

  await loadAdminSchedule();
}

/**
 * 予定を1件削除する。
 *
 * @param {string} scheduleId
 */
async function onDeleteScheduleItem(scheduleId) {
  if (!confirm('この予定を削除します。よろしいですか？')) return;

  const res = await callApi('deleteScheduleItem', { schedule_id: scheduleId });
  if (!res.ok) {
    alert('削除できません: ' + res.error);
    return;
  }

  await loadAdminSchedule();
}

// ---------------------------------------------------------------------------
// ひな型の編集
// ---------------------------------------------------------------------------

/**
 * ひな型を読み込んで編集欄を作る。
 */
async function loadTemplateEditor() {
  const res = await callApi('getScheduleTemplate', {});
  if (!res.ok) {
    setResult('sg-template-result', false, 'ひな型を取得できませんでした: ' + res.error);
    return;
  }

  scheduleTemplateRows = res.data.rows;
  renderTemplateEditor();
}

/**
 * ひな型の編集欄を描く。
 *
 * 行の追加・削除は画面上だけで行い、「保存」で丸ごと差し替える。
 * 1行ずつ通信すると、並べ替え中の中途半端な状態が保存されてしまう。
 */
function renderTemplateEditor() {
  const rows = scheduleTemplateRows
    .map((r, i) => `
      <tr>
        <td><input type="number" class="tpl-offset" data-i="${i}" value="${r.day_offset}" step="1" /></td>
        <td><input type="text" class="tpl-label" data-i="${i}" value="${esc(r.label)}" /></td>
        <td><input type="text" class="tpl-note" data-i="${i}" value="${esc(r.note)}" /></td>
        <td><button type="button" class="btn btn-secondary btn-sm tpl-del" data-i="${i}">削除</button></td>
      </tr>`)
    .join('');

  document.getElementById('sg-template').innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:90px;">日数</th><th>予定</th><th>補足</th><th style="width:70px;">操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted note-sm">
      例: 開幕14日前なら <code>-14</code>、開幕当日なら <code>0</code>。
      同じ日数の行は上から順に並びます。
    </p>`;

  document.querySelectorAll('.tpl-del').forEach((b) => {
    b.onclick = () => {
      collectTemplateRows();
      scheduleTemplateRows.splice(Number(b.dataset.i), 1);
      renderTemplateEditor();
    };
  });
}

/**
 * 画面の入力値を scheduleTemplateRows に取り込む。
 */
function collectTemplateRows() {
  document.querySelectorAll('.tpl-offset').forEach((el) => {
    scheduleTemplateRows[el.dataset.i].day_offset = Number(el.value) || 0;
  });
  document.querySelectorAll('.tpl-label').forEach((el) => {
    scheduleTemplateRows[el.dataset.i].label = el.value;
  });
  document.querySelectorAll('.tpl-note').forEach((el) => {
    scheduleTemplateRows[el.dataset.i].note = el.value;
  });
}

/**
 * ひな型に空行を1つ足す。
 */
function onAddTemplateRow() {
  collectTemplateRows();
  scheduleTemplateRows.push({ day_offset: 0, label: '', note: '' });
  renderTemplateEditor();
}

/**
 * ひな型を保存する。
 */
async function onSaveTemplate() {
  collectTemplateRows();

  const rows = scheduleTemplateRows.filter((r) => r.label.trim());
  if (rows.length === 0) {
    setResult('sg-template-result', false, '少なくとも1件は必要です。');
    return;
  }

  const btn = document.getElementById('sg-template-save');
  btn.disabled = true;
  setResult('sg-template-result', true, '保存中...');

  const res = await callApi('saveScheduleTemplate', { rows });

  btn.disabled = false;

  if (!res.ok) {
    setResult('sg-template-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult(
    'sg-template-result', true,
    res.data.count + ' 件を保存しました。次に作成する日程から反映されます。'
  );
  await loadTemplateEditor();
}

// ---------------------------------------------------------------------------
// 画面: 使用監督の申告（参加者）
// ---------------------------------------------------------------------------

/** getManagerStatus の結果 */
let managerData = null;

/**
 * 使用監督タブを初期化する。
 */
async function renderManager() {
  const seasons = await loadSeasons();
  fillSelect('mg-season', seasons, 'season_id', 'name');

  const wrap = document.getElementById('mg-team-wrap');
  if (currentUser.role === 'organizer') {
    wrap.style.display = '';
    fillSelect('mg-team', (await loadTeams()).filter((t) => t.active), 'team_id', 'name');
  } else {
    wrap.style.display = 'none';
  }

  const sel = document.getElementById('mg-season');
  if (!sel.dataset.bound) {
    sel.onchange = loadManagerStatus;
    document.getElementById('mg-team').onchange = loadManagerStatus;
    document.getElementById('mg-category').onchange = renderManagerSelect;
    document.getElementById('mg-submit').onclick = onDeclareManager;
    sel.dataset.bound = '1';
  }

  await loadManagerStatus();
}

/**
 * 監督の選択肢と自分の申告状況を読み込む。
 */
async function loadManagerStatus() {
  const seasonId = document.getElementById('mg-season').value;
  if (!seasonId) return;

  setLoading('mg-list');

  const payload = { season_id: seasonId };
  if (currentUser.role === 'organizer') {
    payload.team_id = document.getElementById('mg-team').value;
  }

  const res = await callApi('getManagerStatus', payload);
  if (!res.ok) {
    setError('mg-list', '監督の情報を取得できませんでした: ' + res.error);
    return;
  }

  managerData = res.data;
  renderManagerStatus();
  renderManagerList();
}

/**
 * 受付状態と自分の申告を上部に出す。
 */
function renderManagerStatus() {
  const d = managerData;
  const box = document.getElementById('mg-status');
  const form = document.getElementById('mg-form');

  // 確定済みなら申告フォームを閉じる
  const fixed = d.my_pick && d.my_pick.status === '確定';
  form.style.display = d.open && !fixed ? '' : 'none';

  if (!d.open) {
    box.innerHTML = `
      <div class="warn-box">
        <strong>現在は使用監督の申告を受け付けていません。</strong>
        <p class="muted note-sm">受付が始まると、ここから申告できるようになります。</p>
      </div>`;
    if (d.my_pick) box.innerHTML += myManagerPickHtml(d);
    return;
  }

  const rule = d.first_come
    ? '<strong>第二次は先着順です。</strong>申告した時点で確定し、あとから変更できません。'
    : '<strong>第一次は締切まで他チームの申告が見えません。</strong>' +
      '締切後に主催者が抽選し、重複した監督だけ当選者を決めます。締切までは何度でも変更できます。';

  box.innerHTML = `
    <div class="hint-box">
      <strong>${esc(d.team_name)}</strong> ／ 受付: ${esc(d.round_label)}
      ／ 空き ${d.available} / ${d.total} 人
      <p class="muted note-sm">${rule}</p>
    </div>
    ${myManagerPickHtml(d)}`;
}

/**
 * 自分の申告状況の表示。
 *
 * @param {Object} d
 * @returns {string} HTML
 */
function myManagerPickHtml(d) {
  if (!d.my_pick) {
    return '<p class="muted">まだ申告していません。</p>';
  }

  const all = [].concat(...d.categories.map((c) => d.managers[c]));
  const m = all.find((x) => x.manager_id === d.my_pick.manager_id);
  const name = m ? m.name + '（' + m.club + '）' : d.my_pick.manager_id;

  const tag = {
    確定: '<span class="tag-ok">確定</span>',
    申告中: '<span class="tag-wait">申告中</span>',
    落選: '<span class="tag-ng">落選</span>',
  }[d.my_pick.status] || esc(d.my_pick.status);

  return `<p>あなたの申告: <strong>${esc(name)}</strong> ${tag}</p>`;
}

/**
 * カテゴリのプルダウンを作り、監督の選択肢を描く。
 */
function renderManagerList() {
  const d = managerData;

  const catSel = document.getElementById('mg-category');
  const keep = catSel.value;
  catSel.innerHTML = d.categories
    .map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>')
    .join('');
  if (d.categories.indexOf(keep) !== -1) catSel.value = keep;

  renderManagerSelect();

  // 確定済みの一覧（第二次以降は誰がどの監督か見える）
  const fixedList = [].concat(...d.categories.map((c) => d.managers[c]))
    .filter((m) => m.taken);

  const box = document.getElementById('mg-list');

  if (fixedList.length === 0) {
    box.innerHTML = '<p class="muted note-sm">確定した監督はまだいません。</p>';
    return;
  }

  box.innerHTML = `
    <h3 class="sub-head">確定した監督</h3>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>監督</th><th>クラブ</th><th>チーム</th></tr></thead>
        <tbody>
          ${fixedList.map((m) => `
            <tr${m.is_mine ? ' class="row-today"' : ''}>
              <td>${esc(m.name)}</td>
              <td class="muted">${esc(m.club)}</td>
              <td>${esc(m.taken_by)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/**
 * 選択中カテゴリの監督でプルダウンを組み直す。
 *
 * 埋まっている監督は選択肢に残したうえで無効にする。
 * 消してしまうと「なぜ選べないのか」が分からない。
 */
function renderManagerSelect() {
  const d = managerData;
  const cat = document.getElementById('mg-category').value;
  const list = (d.managers && d.managers[cat]) || [];
  const sel = document.getElementById('mg-select');

  sel.innerHTML =
    '<option value="">監督を選択</option>' +
    list
      .map((m) => {
        const label = m.taken
          ? m.name + '（' + m.club + '・' + m.taken_by + 'で確定）'
          : m.name + '（' + m.club + '）';
        const selected = d.my_pick && d.my_pick.manager_id === m.manager_id;
        return '<option value="' + esc(m.manager_id) + '"' +
          (m.taken && !m.is_mine ? ' disabled' : '') +
          (selected ? ' selected' : '') +
          '>' + esc(label) + '</option>';
      })
      .join('');
}

/**
 * 使用監督を申告する。
 */
async function onDeclareManager() {
  const managerId = document.getElementById('mg-select').value;
  if (!managerId) {
    setResult('mg-result', false, '監督を選んでください。');
    return;
  }

  if (managerData.first_come &&
      !confirm('第二次は先着順です。\n申告するとその場で確定し、あとから変更できません。\n\nよろしいですか？')) {
    return;
  }

  const btn = document.getElementById('mg-submit');
  btn.disabled = true;
  setResult('mg-result', true, '申告中...');

  const payload = {
    season_id: document.getElementById('mg-season').value,
    manager_id: managerId,
  };
  if (currentUser.role === 'organizer') {
    payload.team_id = document.getElementById('mg-team').value;
  }

  const res = await callApi('declareManager', payload);
  btn.disabled = false;

  if (!res.ok) {
    setResult('mg-result', false, res.error);
    return;
  }

  setResult(
    'mg-result', true,
    res.data.manager_name + ' を申告しました（' + res.data.status + '）。'
  );
  await loadManagerStatus();
}

// ---------------------------------------------------------------------------
// 使用監督の受付（主催者）
// ---------------------------------------------------------------------------

/** listManagers の結果 */
let managerMasterRows = [];

/**
 * 運営タブの監督セクションを読み込む。
 */
async function loadManagerAdmin() {
  const btn = document.getElementById('mr-save-round');
  if (!btn.dataset.bound) {
    btn.onclick = onSaveManagerRound;
    document.getElementById('mr-draw').onclick = onDrawManagers;
    document.getElementById('mr-master-save').onclick = onSaveManagerMaster;
    btn.dataset.bound = '1';
  }

  await loadManagerPicks();
  await loadManagerMaster();
}

/**
 * 申告の一覧を描画する。
 */
async function loadManagerPicks() {
  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  setLoading('mr-list');

  const res = await callApi('listManagerPicks', { season_id: seasonId });
  if (!res.ok) {
    setError('mr-list', '申告一覧を取得できませんでした: ' + res.error);
    return;
  }

  const d = res.data;
  document.getElementById('mr-round').value = String(d.round);

  const dupes = d.duplicates.length
    ? '<p><strong>抽選が必要な監督:</strong></p><ul class="detail-grid-list">' +
      d.duplicates
        .map((x) => '<li>' + esc(x.manager_name) + ' — ' + esc(x.teams.join(' / ')) + '</li>')
        .join('') + '</ul>'
    : '<p class="muted note-sm">重複はありません。</p>';

  const undeclared = d.undeclared.length
    ? '<p class="muted note-sm">未申告: ' +
      d.undeclared.map((t) => esc(t.team_name)).join(' / ') + '</p>'
    : '<p class="muted note-sm">全チームが申告済みです。</p>';

  document.getElementById('mr-summary').innerHTML = `
    <div class="${d.duplicates.length ? 'warn-box' : 'hint-box'}">
      申告中 <strong>${d.declared}</strong> 件 ／ 確定 <strong>${d.fixed}</strong> 件
      ${dupes}
      ${undeclared}
    </div>`;

  document.getElementById('mr-draw').disabled = d.declared === 0;

  const box = document.getElementById('mr-list');

  if (d.picks.length === 0) {
    box.innerHTML = '<p class="muted">まだ申告がありません。</p>';
    return;
  }

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>チーム</th><th>監督</th><th>クラブ</th><th>回</th><th>状態</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${d.picks.map((p) => `
            <tr>
              <td>${esc(p.team_name)}</td>
              <td>${esc(p.manager_name)}</td>
              <td class="muted">${esc(p.club)}</td>
              <td class="num">${p.round}</td>
              <td>${esc(p.status)}</td>
              <td>
                <button type="button" class="btn btn-secondary btn-sm mr-clear"
                        data-id="${esc(p.pick_id)}">取消</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  box.querySelectorAll('.mr-clear').forEach((b) => {
    b.onclick = () => onClearManagerPick(b.dataset.id);
  });
}

/**
 * 受付状態を保存する。
 */
async function onSaveManagerRound() {
  const round = Number(document.getElementById('mr-round').value);

  const btn = document.getElementById('mr-save-round');
  btn.disabled = true;
  setResult('mr-result', true, '保存中...');

  const res = await callApi('setManagerRound', { round });
  btn.disabled = false;

  if (!res.ok) {
    setResult('mr-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult('mr-result', true, '受付を「' + res.data.label + '」にしました。');
  await loadManagerPicks();
}

/**
 * 第一次の抽選を実行する。
 */
async function onDrawManagers() {
  if (!confirm(
    '第一次の抽選を実行します。\n\n' +
    '重複した監督は無作為に1チームが選ばれ、他は落選になります。\n' +
    '重複していない申告はそのまま確定します。\n\n取り消せません。よろしいですか？'
  )) return;

  const btn = document.getElementById('mr-draw');
  btn.disabled = true;
  setResult('mr-result', true, '抽選中...');

  const res = await callApi('drawManagers', {
    season_id: document.getElementById('sp-season').value,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('mr-result', false, '抽選できません: ' + res.error);
    return;
  }

  const d = res.data;
  setResult('mr-result', true, d.fixed_count + ' 件が確定しました。');

  const lots = d.lotteries.length
    ? '<h4 class="rank-title">抽選の結果</h4><ul class="detail-grid-list">' +
      d.lotteries
        .map((l) =>
          '<li>' + esc(l.manager_name) + '：' + esc(l.entries.join(' / ')) +
          ' → <strong>' + esc(l.winner) + '</strong> が当選' +
          '（落選: ' + esc(l.losers.join(' / ')) + '）</li>')
        .join('') + '</ul>'
    : '<p class="muted">抽選が必要な重複はありませんでした。</p>';

  document.getElementById('mr-report').innerHTML = `
    <h3 class="sub-head">抽選の結果</h3>
    <p>確定 <strong>${d.fixed_count}</strong> 件 ／ 落選 <strong>${d.lost_count}</strong> 件</p>
    ${lots}
    <p class="muted note-sm">${esc(d.note)}</p>`;

  await loadManagerPicks();
}

/**
 * 申告を取り消す。
 *
 * @param {string} pickId
 */
async function onClearManagerPick(pickId) {
  if (!confirm('この申告を取り消します。監督は空きに戻ります。よろしいですか？')) return;

  const res = await callApi('clearManagerPick', { pick_id: pickId });
  if (!res.ok) {
    setResult('mr-result', false, '取り消せません: ' + res.error);
    return;
  }

  await loadManagerPicks();
}

/**
 * 監督マスタを読み込んで編集欄を作る。
 */
async function loadManagerMaster() {
  const res = await callApi('listManagers', {});
  if (!res.ok) {
    setResult('mr-master-result', false, 'マスタを取得できませんでした: ' + res.error);
    return;
  }

  managerMasterRows = res.data.managers;

  const rows = managerMasterRows
    .map((m, i) => `
      <tr>
        <td class="muted">${esc(m.category)}</td>
        <td>${esc(m.club)}</td>
        <td><input type="text" class="mgm-name" data-i="${i}" value="${esc(m.name)}"
                   placeholder="監督名" /></td>
        <td>
          <label class="check-label">
            <input type="checkbox" class="mgm-active" data-i="${i}" ${m.active ? 'checked' : ''} />
            使う
          </label>
        </td>
      </tr>`)
    .join('');

  document.getElementById('mr-master').innerHTML = `
    <p class="muted note-sm">
      名前が未入力: <strong>${res.data.unnamed}</strong> / ${res.data.total} クラブ
    </p>
    <div class="table-wrap scroll-list">
      <table class="data-table">
        <thead><tr><th>区分</th><th>クラブ</th><th>監督名</th><th>選択肢</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * 監督名をまとめて保存する。
 *
 * 変更のあった行だけ送る。40行を毎回全部送ると通信が重いため。
 */
async function onSaveManagerMaster() {
  const changed = [];

  document.querySelectorAll('.mgm-name').forEach((el) => {
    const i = Number(el.dataset.i);
    const row = managerMasterRows[i];
    const active = document.querySelector('.mgm-active[data-i="' + i + '"]').checked;

    if (el.value.trim() === row.name && active === row.active) return;
    changed.push({ ...row, name: el.value.trim(), active });
  });

  if (changed.length === 0) {
    setResult('mr-master-result', true, '変更はありません。');
    return;
  }

  const btn = document.getElementById('mr-master-save');
  btn.disabled = true;
  setResult('mr-master-result', true, changed.length + ' 件を保存中...');

  let failed = 0;
  for (const m of changed) {
    // 名前が空のまま「使う」にすると選択肢に出ないので、そのまま送って構わない
    const res = await callApi('upsertManager', {
      manager_id: m.manager_id,
      name: m.name || '（未定）',
      club: m.club,
      category: m.category,
      active: m.active,
    });
    if (!res.ok) failed++;
  }

  btn.disabled = false;

  setResult(
    'mr-master-result',
    failed === 0,
    failed === 0
      ? changed.length + ' 件を保存しました。'
      : failed + ' 件の保存に失敗しました。'
  );

  await loadManagerMaster();
}

// ---------------------------------------------------------------------------
// 画面: スポンサー契約（参加者）
// ---------------------------------------------------------------------------

/** getSponsorOptions の結果 */
let sponsorData = null;

/**
 * スポンサータブを初期化する。
 */
async function renderSponsor() {
  const seasons = await loadSeasons();
  fillSelect('sn-season', seasons, 'season_id', 'name');

  const wrap = document.getElementById('sn-team-wrap');
  if (currentUser.role === 'organizer') {
    wrap.style.display = '';
    fillSelect('sn-team', (await loadTeams()).filter((t) => t.active), 'team_id', 'name');
  } else {
    wrap.style.display = 'none';
  }

  const sel = document.getElementById('sn-season');
  if (!sel.dataset.bound) {
    sel.onchange = loadSponsorOptions;
    document.getElementById('sn-team').onchange = loadSponsorOptions;
    sel.dataset.bound = '1';
  }

  await loadSponsorOptions();
}

/**
 * スポンサー一覧と自分の契約を読み込む。
 */
async function loadSponsorOptions() {
  const seasonId = document.getElementById('sn-season').value;
  if (!seasonId) return;

  setLoading('sn-list');

  const payload = { season_id: seasonId };
  if (currentUser.role === 'organizer') {
    payload.team_id = document.getElementById('sn-team').value;
  }

  const res = await callApi('getSponsorOptions', payload);
  if (!res.ok) {
    setError('sn-list', 'スポンサーの情報を取得できませんでした: ' + res.error);
    return;
  }

  sponsorData = res.data;
  renderSponsorStatus();
  renderSponsorList();
}

/**
 * 受付状態と自分の契約を上部に出す。
 */
function renderSponsorStatus() {
  const d = sponsorData;
  const box = document.getElementById('sn-status');

  const mine = d.my_contract
    ? `
      <p>
        現在の契約: <strong>${esc(d.my_contract.sponsor_name)}</strong>
        （契約金 ${esc(formatMoney(d.my_contract.contract_fee))}
        ／ ${esc(d.my_contract.quota_label)}
        ／ 未達なら ${esc(formatMoney(d.my_contract.penalty))}）
        ${d.my_contract.result !== '未判定'
          ? '<span class="' + (d.my_contract.result === '達成' ? 'tag-ok' : 'tag-ng') + '">' +
            esc(d.my_contract.result) + '</span>'
          : ''}
      </p>`
    : '<p class="muted">まだ契約していません。</p>';

  box.innerHTML = `
    <div class="${d.open ? 'hint-box' : 'warn-box'}">
      <strong>${esc(d.team_name)}</strong>
      ${d.open
        ? '／ 契約を受け付けています。締切までは何度でも変更できます。'
        : '／ <strong>受付期間外です。</strong>変更が必要な場合は主催者に連絡してください。'}
      ${mine}
    </div>`;
}

/**
 * スポンサーをカードで並べる。
 *
 * 契約金・ノルマ・罰金を同じ大きさで並べる。
 * 契約金だけが目立つと、罰金を見落としたまま選んでしまう。
 */
function renderSponsorList() {
  const d = sponsorData;
  const box = document.getElementById('sn-list');

  if (d.sponsors.length === 0) {
    box.innerHTML = '<p class="muted">このシーズンのスポンサーはまだ設定されていません。</p>';
    return;
  }

  const settled = d.my_contract && d.my_contract.result !== '未判定';
  const canChoose = (d.open || currentUser.role === 'organizer') && !settled;

  box.innerHTML = d.sponsors
    .map((s) => `
      <div class="card sponsor-card${s.is_mine ? ' sponsor-mine' : ''}${s.unlocked ? '' : ' sponsor-locked'}">
        <div class="claim-head">
          <strong>${esc(s.name)}</strong>
          ${s.is_mine ? '<span class="tag-ok">契約中</span>' : ''}
          ${s.unlocked ? '' : '<span class="tag-ng">条件未達</span>'}
        </div>
        <div class="sponsor-terms">
          <div>
            <span class="stat-label">契約金</span>
            <span class="stat-value stat-sm">${esc(formatMoney(s.contract_fee))}</span>
          </div>
          <div>
            <span class="stat-label">ノルマ</span>
            <span class="stat-value stat-sm">${esc(s.quota_label)}</span>
          </div>
          <div>
            <span class="stat-label">未達の罰金</span>
            <span class="stat-value stat-sm">${s.penalty > 0 ? esc(formatMoney(s.penalty)) : 'なし'}</span>
          </div>
        </div>
        ${s.unlock_label
          ? '<p class="note-sm' + (s.unlocked ? ' muted' : ' text-ng') + '">解放条件: ' +
            esc(s.unlock_label) +
            (s.unlocked ? '' : '（' + esc(s.unlock_reason) + '）') + '</p>'
          : ''}
        ${s.note ? '<p class="muted note-sm">' + esc(s.note) + '</p>' : ''}
        <p class="muted note-sm">契約中のチーム: ${s.contracted} 件</p>
        ${canChoose && !s.is_mine && s.unlocked
          ? '<button type="button" class="btn btn-primary btn-sm sn-choose" data-id="' +
            esc(s.sponsor_id) + '">このスポンサーと契約</button>'
          : ''}
        ${canChoose && !s.is_mine && !s.unlocked
          ? '<p class="muted note-sm">条件を満たすと選べるようになります。</p>'
          : ''}
      </div>`)
    .join('');

  box.querySelectorAll('.sn-choose').forEach((b) => {
    b.onclick = () => onChooseSponsor(b.dataset.id);
  });
}

/**
 * スポンサーと契約する。
 *
 * @param {string} sponsorId
 */
async function onChooseSponsor(sponsorId) {
  const d = sponsorData;
  const s = d.sponsors.find((x) => x.sponsor_id === sponsorId);
  if (!s) return;

  const msg =
    esc(s.name) + ' と契約します。\n\n' +
    '契約金 ' + formatMoney(s.contract_fee) + ' がすぐに予算へ入ります。\n' +
    'ノルマ: ' + s.quota_label + '\n' +
    (s.penalty > 0
      ? '未達の場合、シーズン終了時に ' + formatMoney(s.penalty) + ' が引かれます。\n'
      : '') +
    (d.my_contract ? '\n現在の契約は解除され、契約金は返金されます。\n' : '') +
    '\nよろしいですか？';

  if (!confirm(msg)) return;

  const payload = {
    season_id: document.getElementById('sn-season').value,
    sponsor_id: sponsorId,
  };
  if (currentUser.role === 'organizer') {
    payload.team_id = document.getElementById('sn-team').value;
  }

  const res = await callApi('chooseSponsor', payload);
  if (!res.ok) {
    alert('契約できません: ' + res.error);
    return;
  }

  await loadSponsorOptions();
}

// ---------------------------------------------------------------------------
// スポンサーの設定（主催者）
// ---------------------------------------------------------------------------

/**
 * 運営タブのスポンサーセクションを読み込む。
 */
async function loadSponsorAdmin() {
  const btn = document.getElementById('sa-save-open');
  if (!btn.dataset.bound) {
    btn.onclick = onSaveSponsorOpen;
    document.getElementById('sa-add').onclick = () => onEditSponsor(null);
    document.getElementById('sa-copy').onclick = onCopySponsors;
    btn.dataset.bound = '1';
  }

  const seasonId = document.getElementById('sp-season').value;
  if (!seasonId) return;

  // 複製元の候補は自分以外のシーズン
  const seasons = (await loadSeasons()).filter((s) => s.season_id !== seasonId);
  fillSelect('sa-copy-from', seasons, 'season_id', 'name', '複製元を選択');

  setLoading('sa-list');

  const res = await callApi('listSponsors', { season_id: seasonId });
  if (!res.ok) {
    setError('sa-list', 'スポンサーを取得できませんでした: ' + res.error);
    return;
  }

  const d = res.data;
  // 解放条件の「判定するシーズン」で前シーズンを選べるようにする
  d.all_seasons = await loadSeasons();
  sponsorAdminData = d;

  document.getElementById('sa-open').checked = d.open;

  document.getElementById('sa-summary').innerHTML = `
    <div class="${d.uncontracted.length ? 'warn-box' : 'hint-box'}">
      スポンサー <strong>${d.sponsors.length}</strong> 社
      ／ 契約済み <strong>${d.contracts.length}</strong> チーム
      ${d.uncontracted.length
        ? '<p class="muted note-sm">未契約: ' +
          d.uncontracted.map((t) => esc(t.team_name)).join(' / ') + '</p>'
        : '<p class="muted note-sm">全チームが契約済みです。</p>'}
    </div>`;

  renderSponsorAdminList(d);
  renderSponsorContracts(d);
}

/**
 * スポンサー一覧（主催者）を描く。
 *
 * @param {Object} d listSponsors の結果
 */
function renderSponsorAdminList(d) {
  const box = document.getElementById('sa-list');

  if (d.sponsors.length === 0) {
    box.innerHTML = '<p class="muted">まだスポンサーがありません。</p>';
    return;
  }

  box.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>スポンサー</th><th class="num">契約金</th><th>ノルマ</th>
            <th class="num">罰金</th><th>解放条件</th><th>契約チーム</th><th>使う</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${d.sponsors.map((s) => `
            <tr${s.active ? '' : ' class="row-inactive"'}>
              <td>${esc(s.name)}${s.note ? '<br><span class="muted note-sm">' + esc(s.note) + '</span>' : ''}</td>
              <td class="num">${esc(formatMoney(s.contract_fee))}</td>
              <td>${esc(s.quota_label)}</td>
              <td class="num">${s.penalty > 0 ? esc(formatMoney(s.penalty)) : '—'}</td>
              <td class="muted">${s.unlock_label
                ? esc(s.unlock_label) +
                  (s.unlock_type === '指定'
                    ? '<br><span class="note-sm">' + s.unlock_teams.length + 'チームに解放</span>'
                    : '')
                : '—'}</td>
              <td class="muted">${s.teams.length ? esc(s.teams.join(' / ')) : '—'}</td>
              <td>${s.active ? '○' : '×'}</td>
              <td>
                <button type="button" class="btn btn-secondary btn-sm sa-edit"
                        data-id="${esc(s.sponsor_id)}">編集</button>
                <button type="button" class="btn btn-secondary btn-sm sa-del"
                        data-id="${esc(s.sponsor_id)}">削除</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  box.querySelectorAll('.sa-edit').forEach((b) => {
    b.onclick = () => onEditSponsor(d.sponsors.find((s) => s.sponsor_id === b.dataset.id));
  });
  box.querySelectorAll('.sa-del').forEach((b) => {
    b.onclick = () => onDeleteSponsor(b.dataset.id);
  });
}

/**
 * 契約状況を出す。判定済みなら結果も出す。
 *
 * @param {Object} d
 */
function renderSponsorContracts(d) {
  const box = document.getElementById('sa-contracts');

  if (d.contracts.length === 0) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = `
    <h3 class="sub-head">契約状況</h3>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>チーム</th><th>スポンサー</th><th class="num">契約金</th><th>結果</th><th class="num">罰金</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${d.contracts.map((c) => `
            <tr>
              <td>${esc(c.team_name)}</td>
              <td>${esc(c.sponsor_name)}<br><span class="muted note-sm">${esc(c.quota_label)}</span></td>
              <td class="num">${esc(formatMoney(c.contract_fee))}</td>
              <td>${c.result === '未判定'
                ? '<span class="muted">未判定</span>'
                : '<span class="' + (c.result === '達成' ? 'tag-ok' : 'tag-ng') + '">' + esc(c.result) + '</span>'}</td>
              <td class="num">${c.penalty_paid > 0 ? '−' + esc(formatMoney(c.penalty_paid)) : '—'}</td>
              <td>${c.result === '未判定'
                ? '<button type="button" class="btn btn-secondary btn-sm sa-clear" data-id="' +
                  esc(c.contract_id) + '">取消</button>'
                : '<span class="muted">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="muted note-sm">
      ノルマの判定はシーズン終了処理で自動的に行われ、未達なら罰金が引かれます。
    </p>`;

  box.querySelectorAll('.sa-clear').forEach((b) => {
    b.onclick = () => onClearTeamSponsor(b.dataset.id);
  });
}

/**
 * 受付状態を保存する。
 */
async function onSaveSponsorOpen() {
  const open = document.getElementById('sa-open').checked;

  const btn = document.getElementById('sa-save-open');
  btn.disabled = true;
  setResult('sa-open-result', true, '保存中...');

  const res = await callApi('setSponsorOpen', { open });
  btn.disabled = false;

  if (!res.ok) {
    setResult('sa-open-result', false, '保存できません: ' + res.error);
    return;
  }

  setResult('sa-open-result', true, open ? '受付中にしました。' : '受付を停止しました。');
}

/** listSponsors の結果（設定フォームで使い回す） */
let sponsorAdminData = null;

/**
 * スポンサーの追加・編集フォームを出す。
 *
 * 項目が10近くあるので、prompt を連打させると
 * 途中で間違えたときに最初からやり直しになる。
 * 1枚のフォームにまとめて、保存前に全体を見直せるようにする。
 *
 * @param {Object|null} s 既存のスポンサー。null なら新規
 */
function onEditSponsor(s) {
  const d = sponsorAdminData;
  if (!d) return;

  const box = document.getElementById('sa-form');
  const v = s || {
    sponsor_id: '', name: '', contract_fee: 0,
    quota_type: 'なし', quota_value: '', quota_type2: 'なし', quota_value2: '',
    penalty: 0, unlock_type: 'なし', unlock_season_id: '', unlock_value: '',
    unlock_teams: [], unlock_note: '', note: '', active: true,
  };

  const million = (n) => (Number(n) || 0) / 1000000;

  box.innerHTML = `
    <div class="card sponsor-form">
      <h3 class="sub-head">${s ? 'スポンサーを編集' : 'スポンサーを追加'}</h3>

      <div class="form-grid">
        <label>
          スポンサー名
          <input type="text" id="sf-name" value="${esc(v.name)}" />
        </label>
        <label>
          契約金 <span class="unit-hint">100万円単位</span>
          <input type="number" id="sf-fee" min="0" step="1" value="${million(v.contract_fee)}" />
        </label>
      </div>

      <h4 class="sub-head-sm">ノルマ</h4>
      <p class="muted note-sm">
        2つ設定すると<strong>どちらか達成すればよい</strong>という条件になります。
      </p>
      ${quotaRowHtml(1, v.quota_type, v.quota_value, d)}
      ${quotaRowHtml(2, v.quota_type2, v.quota_value2, d)}

      <div class="form-grid">
        <label>
          未達時の罰金 <span class="unit-hint">100万円単位</span>
          <input type="number" id="sf-penalty" min="0" step="1" value="${million(v.penalty)}" />
        </label>
      </div>

      <h4 class="sub-head-sm">解放条件</h4>
      <p class="muted note-sm">
        条件を満たしたチームだけが選べるようになります。
        <strong>順位</strong>はツールに入っているシーズンの順位表から自動で判定し、
        <strong>指定</strong>は選んだチームだけに開きます。
        過去シーズンの成績がツールに無い場合は「指定」を使ってください。
      </p>
      <div class="form-grid">
        <label>
          種別
          <select id="sf-unlock-type">
            ${d.unlock_types.map((t) =>
              '<option value="' + esc(t) + '"' + (v.unlock_type === t ? ' selected' : '') +
              '>' + esc(t) + '</option>').join('')}
          </select>
        </label>
        <label id="sf-unlock-season-wrap">
          判定するシーズン
          <select id="sf-unlock-season"></select>
        </label>
        <label id="sf-unlock-value-wrap">
          何位以内
          <input type="number" id="sf-unlock-value" min="1" step="1" value="${esc(v.unlock_value)}" />
        </label>
      </div>
      <div id="sf-unlock-teams-wrap">
        <p class="muted note-sm">選べるチーム</p>
        <div class="check-grid">
          ${d.teams.map((t) =>
            '<label class="check-label"><input type="checkbox" class="sf-team" value="' +
            esc(t.team_id) + '"' +
            (v.unlock_teams.indexOf(t.team_id) !== -1 ? ' checked' : '') + ' /> ' +
            esc(t.team_name) + '</label>').join('')}
        </div>
      </div>

      <div class="form-grid">
        <label>
          解放条件の説明文 <span class="unit-hint">参加者の画面にこのまま出ます</span>
          <input type="text" id="sf-unlock-note" value="${esc(v.unlock_note)}"
                 placeholder="例: Season7〜13でGM1所属かつタイトル獲得" />
        </label>
        <label>
          備考
          <input type="text" id="sf-note" value="${esc(v.note)}" />
        </label>
        <label class="check-label">
          <input type="checkbox" id="sf-active" ${v.active ? 'checked' : ''} />
          選択肢に出す
        </label>
      </div>

      <div class="form-actions">
        <button type="button" id="sf-save" class="btn btn-primary">保存</button>
        <button type="button" id="sf-cancel" class="btn btn-secondary">キャンセル</button>
        <span id="sf-result" class="form-msg"></span>
      </div>
    </div>`;

  // 判定シーズンは自分以外も含めて全部から選べる（前シーズンを指すため）
  fillSelect('sf-unlock-season', d.all_seasons, 'season_id', 'name', 'シーズンを選択');
  document.getElementById('sf-unlock-season').value = v.unlock_season_id || '';

  [1, 2].forEach((n) => {
    document.getElementById('sf-qtype' + n).onchange = () => syncQuotaRow(n);
    syncQuotaRow(n);
  });

  document.getElementById('sf-unlock-type').onchange = syncUnlockRow;
  syncUnlockRow();

  document.getElementById('sf-save').onclick = () => onSaveSponsorForm(v.sponsor_id);
  document.getElementById('sf-cancel').onclick = () => { box.innerHTML = ''; };

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * ノルマ1行ぶんの HTML。
 *
 * @param {number} n 1 か 2
 * @param {string} type
 * @param {string} value
 * @param {Object} d listSponsors の結果
 * @returns {string}
 */
function quotaRowHtml(n, type, value, d) {
  return `
    <div class="form-grid">
      <label>
        ${n === 1 ? 'ノルマ' : 'または'}
        <select id="sf-qtype${n}">
          ${d.quota_types.map((t) =>
            '<option value="' + esc(t) + '"' + (type === t ? ' selected' : '') +
            '>' + esc(t) + '</option>').join('')}
        </select>
      </label>
      <label id="sf-qrank-wrap${n}">
        何位以内
        <input type="number" id="sf-qrank${n}" min="1" step="1"
               value="${type === 'リーグ順位' ? esc(value) : ''}" />
      </label>
      <label id="sf-qcup-wrap${n}">
        リーグ杯の成績
        <select id="sf-qcup${n}">
          ${d.cup_goals.map((g) =>
            '<option value="' + esc(g) + '"' + (value === g ? ' selected' : '') +
            '>' + esc(g) + '</option>').join('')}
        </select>
      </label>
    </div>`;
}

/**
 * ノルマの種別に応じて入力欄を出し分ける。
 *
 * @param {number} n
 */
function syncQuotaRow(n) {
  const t = document.getElementById('sf-qtype' + n).value;
  document.getElementById('sf-qrank-wrap' + n).style.display = t === 'リーグ順位' ? '' : 'none';
  document.getElementById('sf-qcup-wrap' + n).style.display = t === 'リーグ杯' ? '' : 'none';
}

/**
 * 解放条件の種別に応じて入力欄を出し分ける。
 */
function syncUnlockRow() {
  const t = document.getElementById('sf-unlock-type').value;
  document.getElementById('sf-unlock-season-wrap').style.display = t === '順位' ? '' : 'none';
  document.getElementById('sf-unlock-value-wrap').style.display = t === '順位' ? '' : 'none';
  document.getElementById('sf-unlock-teams-wrap').style.display = t === '指定' ? '' : 'none';
}

/**
 * フォームの内容を保存する。
 *
 * @param {string} sponsorId 空なら新規
 */
async function onSaveSponsorForm(sponsorId) {
  const q = (n) => {
    const t = document.getElementById('sf-qtype' + n).value;
    if (t === 'リーグ順位') return { type: t, value: document.getElementById('sf-qrank' + n).value };
    if (t === 'リーグ杯') return { type: t, value: document.getElementById('sf-qcup' + n).value };
    return { type: 'なし', value: '' };
  };

  const q1 = q(1);
  const q2 = q(2);

  const teams = [...document.querySelectorAll('.sf-team:checked')].map((c) => c.value);

  const btn = document.getElementById('sf-save');
  btn.disabled = true;
  setResult('sf-result', true, '保存中...');

  const res = await callApi('upsertSponsor', {
    sponsor_id: sponsorId,
    season_id: document.getElementById('sp-season').value,
    name: document.getElementById('sf-name').value.trim(),
    contract_fee: (Number(document.getElementById('sf-fee').value) || 0) * 1000000,
    quota_type: q1.type,
    quota_value: q1.value,
    quota_type2: q2.type,
    quota_value2: q2.value,
    penalty: (Number(document.getElementById('sf-penalty').value) || 0) * 1000000,
    unlock_type: document.getElementById('sf-unlock-type').value,
    unlock_season_id: document.getElementById('sf-unlock-season').value,
    unlock_value: document.getElementById('sf-unlock-value').value,
    unlock_teams: teams,
    unlock_note: document.getElementById('sf-unlock-note').value.trim(),
    note: document.getElementById('sf-note').value.trim(),
    active: document.getElementById('sf-active').checked,
  });

  btn.disabled = false;

  if (!res.ok) {
    setResult('sf-result', false, '保存できません: ' + res.error);
    return;
  }

  document.getElementById('sa-form').innerHTML = '';
  await loadSponsorAdmin();
}

/**
 * スポンサーを削除する。
 *
 * @param {string} sponsorId
 */
async function onDeleteSponsor(sponsorId) {
  if (!confirm('このスポンサーを削除します。よろしいですか？')) return;

  const res = await callApi('deleteSponsor', { sponsor_id: sponsorId });
  if (!res.ok) {
    setResult('sa-result', false, res.error);
    return;
  }

  await loadSponsorAdmin();
}

/**
 * 別のシーズンから複製する。
 */
async function onCopySponsors() {
  const from = document.getElementById('sa-copy-from').value;
  if (!from) {
    setResult('sa-result', false, '複製元のシーズンを選んでください。');
    return;
  }

  const res = await callApi('copySponsors', {
    from_season_id: from,
    to_season_id: document.getElementById('sp-season').value,
  });

  if (!res.ok) {
    setResult('sa-result', false, res.error);
    return;
  }

  setResult(
    'sa-result', true,
    res.data.copied + ' 社を複製しました。' +
    (res.data.skipped ? '（同名の ' + res.data.skipped + ' 社はスキップ）' : '')
  );
  await loadSponsorAdmin();
}

/**
 * チームの契約を取り消す。
 *
 * @param {string} contractId
 */
async function onClearTeamSponsor(contractId) {
  if (!confirm('この契約を取り消します。契約金も返金されます。よろしいですか？')) return;

  const res = await callApi('clearTeamSponsor', { contract_id: contractId });
  if (!res.ok) {
    setResult('sa-result', false, res.error);
    return;
  }

  setResult('sa-result', true, '契約を取り消しました（返金 ' + formatMoney(res.data.refunded) + '）。');
  await loadSponsorAdmin();
}
