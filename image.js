/**
 * image.js — X 投稿用の画像（順位表・対戦表）を書き出す
 *
 * 画面の見た目をそのまま撮るのではなく、canvas に描き直す。
 *   - 縦横比を 3:4（1080 × 1440）に固定できる。X のタイムラインで切れずに出る
 *   - スマホの画面幅に左右されない。誰が書き出しても同じ画像になる
 *   - 外部のライブラリやサービスを使わない（読み込み先を増やさない）
 *
 * 書き出した画像はプレビューで見せ、「画像を保存」と「共有」を選んでもらう。
 * iPhone はダウンロードが「ファイル」に入るので、写真に入れたいときは
 * 共有メニューか、プレビュー画像の長押しで保存してもらう。
 *
 * 依存: views.js（esc）
 */

/** 画像の大きさ。3:4 */
const SHARE_W = 1080;
const SHARE_H = 1440;

/** 色。style.css のトークンに合わせる */
const SHARE_COLORS = {
  primary: '#1a73e8',
  header:  '#0b3d91',
  text:    '#202124',
  sub:     '#5f6368',
  line:    '#dadce0',
  stripe:  '#f6f8fc',
  win:     '#188038',
  winBg:   '#e6f4ea',
  bg:      '#ffffff',
};

const SHARE_FONT = "'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', 'Meiryo', sans-serif";

/**
 * 指定の太さ・大きさのフォント文字列。
 *
 * @param {number} px
 * @param {number} [weight=400]
 * @returns {string}
 */
function shareFont(px, weight) {
  return (weight || 400) + ' ' + px + 'px ' + SHARE_FONT;
}

/**
 * 幅に収まるまで文字を小さくして描く。それでも入らなければ末尾を「…」で切る。
 *
 * 長いクラブ名（ジェフユナイテッド千葉 など）で列からはみ出さないようにする。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} maxW
 * @param {number} px 基準の文字サイズ
 * @param {number} weight
 * @param {string} [align='left']
 */
function shareFitText(ctx, text, x, y, maxW, px, weight, align) {
  let size = px;
  ctx.font = shareFont(size, weight);
  while (ctx.measureText(text).width > maxW && size > px * 0.7) {
    size -= 1;
    ctx.font = shareFont(size, weight);
  }
  let s = String(text);
  if (ctx.measureText(s).width > maxW) {
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    s += '…';
  }
  ctx.textAlign = align || 'left';
  ctx.fillText(s, x, y);
}

/**
 * 画像の土台（背景・見出し・足もと）を描き、本文を描ける範囲を返す。
 *
 * @param {string} title    大見出し（例: GM1リーグ 順位表）
 * @param {string} subtitle 小見出し（例: Season15 ／ 10月11日時点）
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, top: number, bottom: number, left: number, right: number}}
 */
function shareCanvas(title, subtitle) {
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';

  ctx.fillStyle = SHARE_COLORS.bg;
  ctx.fillRect(0, 0, SHARE_W, SHARE_H);

  // 見出しの帯
  const headH = 210;
  ctx.fillStyle = SHARE_COLORS.header;
  ctx.fillRect(0, 0, SHARE_W, headH);
  ctx.fillStyle = SHARE_COLORS.primary;
  ctx.fillRect(0, headH - 10, SHARE_W, 10);

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = shareFont(30, 700);
  ctx.textAlign = 'left';
  ctx.fillText('GM League', 60, 58);

  ctx.fillStyle = '#ffffff';
  shareFitText(ctx, title, 60, 118, SHARE_W - 120, 58, 800);

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  shareFitText(ctx, subtitle, 60, 172, SHARE_W - 120, 28, 500);

  // 足もと
  ctx.fillStyle = SHARE_COLORS.sub;
  ctx.font = shareFont(22, 500);
  ctx.textAlign = 'right';
  ctx.fillText('gm-league-eight.vercel.app', SHARE_W - 60, SHARE_H - 36);

  return { canvas, ctx, top: headH + 36, bottom: SHARE_H - 76, left: 48, right: SHARE_W - 48 };
}

/** 今日の日付（例: 10月11日時点） */
function shareToday() {
  const d = new Date();
  return (d.getMonth() + 1) + '月' + d.getDate() + '日時点';
}

// =============================================================================
// 順位表
// =============================================================================

/**
 * 順位表の画像を作る。
 *
 * @param {Object} d getStandings の data
 * @param {string} seasonName
 * @param {string} leagueName 例: GM1リーグ
 * @returns {HTMLCanvasElement}
 */
function drawStandingsImage(d, seasonName, leagueName) {
  const c = shareCanvas(leagueName + ' 順位表', seasonName + ' ／ ' + shareToday() + ' ／ 承認済み ' + d.match_count + ' 試合');
  const { ctx } = c;

  // 列: 順位・チーム・試合・勝・分・敗・得失・勝点
  const cols = [
    { key: 'rank',   label: '順位', w: 100, align: 'center' },
    { key: 'team',   label: 'チーム', w: 0, align: 'left' },
    { key: 'played', label: '試合', w: 86, align: 'center' },
    { key: 'won',    label: '勝', w: 70, align: 'center' },
    { key: 'drawn',  label: '分', w: 70, align: 'center' },
    { key: 'lost',   label: '敗', w: 70, align: 'center' },
    { key: 'gd',     label: '得失', w: 96, align: 'center' },
    { key: 'points', label: '勝点', w: 110, align: 'center' },
  ];
  const fixed = cols.reduce((s, k) => s + k.w, 0);
  cols[1].w = (c.right - c.left) - fixed;

  let x = c.left;
  cols.forEach((k) => { k.x = x; x += k.w; });

  // 見出し行
  const headRowH = 56;
  ctx.fillStyle = SHARE_COLORS.stripe;
  ctx.fillRect(c.left, c.top, c.right - c.left, headRowH);
  ctx.fillStyle = SHARE_COLORS.sub;
  cols.forEach((k) => {
    ctx.font = shareFont(24, 700);
    ctx.textAlign = k.align === 'left' ? 'left' : 'center';
    ctx.fillText(k.label, k.align === 'left' ? k.x + 16 : k.x + k.w / 2, c.top + headRowH / 2);
  });

  const rows = d.table || [];
  const avail = c.bottom - (c.top + headRowH);
  const rowH = Math.min(84, Math.floor(avail / Math.max(rows.length, 8)));
  const fontPx = Math.max(22, Math.min(34, Math.floor(rowH * 0.42)));

  rows.forEach((r, i) => {
    const y = c.top + headRowH + i * rowH;
    if (i % 2 === 1) {
      ctx.fillStyle = SHARE_COLORS.stripe;
      ctx.fillRect(c.left, y, c.right - c.left, rowH);
    }
    ctx.strokeStyle = SHARE_COLORS.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.left, y + rowH);
    ctx.lineTo(c.right, y + rowH);
    ctx.stroke();

    const mid = y + rowH / 2;
    const cell = (k, text, weight, color) => {
      ctx.fillStyle = color || SHARE_COLORS.text;
      if (k.align === 'left') shareFitText(ctx, text, k.x + 16, mid, k.w - 24, fontPx, weight, 'left');
      else shareFitText(ctx, text, k.x + k.w / 2, mid, k.w - 8, fontPx, weight, 'center');
    };

    // 上位3チームは順位を色で目立たせる
    if (r.rank <= 3 && r.played > 0) {
      ctx.fillStyle = r.rank === 1 ? '#f9ab00' : (r.rank === 2 ? '#9aa0a6' : '#c5893f');
      ctx.beginPath();
      ctx.arc(cols[0].x + cols[0].w / 2, mid, Math.min(26, rowH * 0.36), 0, Math.PI * 2);
      ctx.fill();
      cell(cols[0], String(r.rank), 800, '#ffffff');
    } else {
      cell(cols[0], String(r.rank) + (r.tied ? '=' : ''), 700);
    }

    cell(cols[1], r.team_name, 700);
    cell(cols[2], String(r.played), 500);
    cell(cols[3], String(r.won), 500);
    cell(cols[4], String(r.drawn), 500);
    cell(cols[5], String(r.lost), 500);
    cell(cols[6], (r.gd > 0 ? '+' : '') + r.gd, 500, r.gd > 0 ? SHARE_COLORS.win : (r.gd < 0 ? '#d93025' : SHARE_COLORS.text));
    cell(cols[7], String(r.points), 800, SHARE_COLORS.primary);
  });

  return c.canvas;
}

// =============================================================================
// 対戦表（リーグ戦の1節・スーパーカップ）
// =============================================================================

/**
 * 対戦の一覧の画像を作る。報告・承認済みの試合はスコア、未実施は「vs」。
 *
 * 複数の節が混ざっていれば（「第3・4・5節」の期間など）、節ごとに小見出しを付けて並べる。
 * 1期間で20試合を超えても収まるよう、行の高さと文字を試合数に合わせて縮める。
 *
 * @param {Object[]} fixtures getFixtures の fixtures（1節分、または1期間分）
 * @param {string} seasonName
 * @param {string} title 例: GM1リーグ 第5節 / GM1リーグ 第3・4・5節
 * @param {string} [dateText] 期間の日付（例: 10/23〜10/28）。見出しの下に添える
 * @returns {HTMLCanvasElement}
 */
function drawFixturesImage(fixtures, seasonName, title, dateText) {
  const c = shareCanvas(title, seasonName + (dateText ? ' ／ ' + dateText : '') + ' ／ ' + shareToday());
  const { ctx } = c;

  // 節ごとにまとめる（並びは渡された順）
  const groups = [];
  fixtures.forEach((f) => {
    let g = groups.find((x) => x.round === f.round);
    if (!g) { g = { round: f.round, items: [] }; groups.push(g); }
    g.items.push(f);
  });
  const multi = groups.length > 1;

  const n = fixtures.length;
  const gap = n > 10 ? 8 : 18;
  const headH = multi ? 44 : 0;
  const groupGap = multi ? 14 : 0;
  const fixedH = headH * groups.length + groupGap * Math.max(0, groups.length - 1) + gap * Math.max(0, n - groups.length);
  const cardH = Math.min(150, Math.floor((c.bottom - c.top - fixedH) / Math.max(n, 4)));
  const nameW = (c.right - c.left - 260) / 2;
  const namePx = Math.max(20, Math.min(40, Math.floor(cardH * 0.42)));
  const scorePx = Math.max(20, Math.min(52, Math.floor(cardH * 0.5)));
  const radius = Math.min(18, Math.floor(cardH / 3));

  // 試合が少ないとき（GM2 やスーパーカップ）は、上に詰めず縦の中央に寄せる
  const used = fixedH + n * cardH;
  let y = c.top + Math.max(0, Math.floor((c.bottom - c.top - used) / 2));
  const center = (c.left + c.right) / 2;

  groups.forEach((g, gi) => {
    if (multi) {
      ctx.fillStyle = SHARE_COLORS.primary;
      shareFitText(ctx, g.round, c.left, y + headH / 2, 400, 28, 800, 'left');
      y += headH;
    }

    g.items.forEach((f, i) => {
      const mid = y + cardH / 2;

      ctx.fillStyle = SHARE_COLORS.stripe;
      ctx.strokeStyle = SHARE_COLORS.line;
      ctx.lineWidth = 2;
      shareRoundRect(ctx, c.left, y, c.right - c.left, cardH, radius);
      ctx.fill();
      ctx.stroke();

      const approved = f.match_status === '承認' && f.score;

      ctx.fillStyle = SHARE_COLORS.text;
      shareFitText(ctx, f.home_team_name, center - 130, mid, nameW - 24, namePx, 700, 'right');
      shareFitText(ctx, f.away_team_name, center + 130, mid, nameW - 24, namePx, 700, 'left');

      if (approved) {
        const boxH = Math.min(cardH - 8, Math.max(cardH * 0.56, scorePx + 8));
        ctx.fillStyle = SHARE_COLORS.header;
        shareRoundRect(ctx, center - 105, mid - boxH / 2, 210, boxH, Math.min(12, Math.floor(boxH / 3)));
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        shareFitText(ctx, f.score.replace(/\s/g, ''), center, mid, 190, scorePx, 800, 'center');
      } else {
        ctx.fillStyle = SHARE_COLORS.sub;
        shareFitText(ctx, 'vs', center, mid, 190, Math.max(20, Math.min(40, Math.floor(cardH * 0.42))), 700, 'center');
      }

      y += cardH + (i < g.items.length - 1 ? gap : 0);
    });

    if (gi < groups.length - 1) y += groupGap;
  });

  return c.canvas;
}

// =============================================================================
// GMリーグ杯（トーナメント表）
// =============================================================================

/**
 * トーナメント表の画像を作る。縦長に収めるため、ラウンドを上から順に並べる。
 *
 * 各タイは「チームA 合計 − 合計 チームB」と、2レグの内訳を小さく添える。
 * 勝ち上がったチームは緑の太字にする。決まっていない枠は「◯◯の勝者」。
 *
 * @param {Object} b getCupBracket の data
 * @param {string} seasonName
 * @returns {HTMLCanvasElement}
 */
function drawBracketImage(b, seasonName) {
  const c = shareCanvas('GMリーグ杯 トーナメント', seasonName + ' ／ ' + shareToday() +
    (b.champion_name ? ' ／ 優勝 ' + b.champion_name : ''));
  const { ctx } = c;

  const tieName = {};
  b.rounds.forEach((r) => r.ties.forEach((t) => { tieName[t.tie_id] = r.round + ' ' + t.slot; }));

  const tieCount = b.rounds.reduce((s, r) => s + r.ties.length, 0);
  const headH = 44;
  const totalHead = headH * b.rounds.length;
  const rowH = Math.min(96, Math.floor((c.bottom - c.top - totalHead) / tieCount));
  const namePx = Math.max(18, Math.min(30, Math.floor(rowH * 0.36)));
  const legPx = Math.max(14, Math.floor(namePx * 0.62));
  const center = (c.left + c.right) / 2;
  const nameW = (c.right - c.left - 180) / 2;

  let y = c.top;
  b.rounds.forEach((r) => {
    ctx.fillStyle = SHARE_COLORS.primary;
    shareFitText(ctx, r.round, c.left, y + headH / 2, 400, 28, 800, 'left');
    y += headH;

    r.ties.forEach((t, i) => {
      if (i % 2 === 1) {
        ctx.fillStyle = SHARE_COLORS.stripe;
        ctx.fillRect(c.left, y, c.right - c.left, rowH);
      }
      const mid = y + rowH * (t.bye ? 0.5 : 0.4);
      const nameOf = (id, name, from) => (id ? name : (from ? from + ' の勝者' : '未定'));
      const color = (id) => (id && t.winner === id ? SHARE_COLORS.win : (id ? SHARE_COLORS.text : SHARE_COLORS.sub));

      if (t.bye) {
        ctx.fillStyle = color(t.team_a);
        shareFitText(ctx, t.team_a_name, center - 90, mid, nameW - 16, namePx, 700, 'right');
        ctx.fillStyle = SHARE_COLORS.sub;
        shareFitText(ctx, 'シード', center + 90, mid, nameW - 16, Math.floor(namePx * 0.8), 500, 'left');
      } else {
        const a = nameOf(t.team_a, t.team_a_name, t.from[0] && tieName[t.from[0]]);
        const bName = nameOf(t.team_b, t.team_b_name, t.from[1] && tieName[t.from[1]]);
        ctx.fillStyle = color(t.team_a);
        shareFitText(ctx, a, center - 90, mid, nameW - 16, namePx, t.team_a ? 700 : 500, 'right');
        ctx.fillStyle = color(t.team_b);
        shareFitText(ctx, bName, center + 90, mid, nameW - 16, namePx, t.team_b ? 700 : 500, 'left');

        ctx.fillStyle = SHARE_COLORS.text;
        const agg = t.played > 0 ? t.agg_a + ' - ' + t.agg_b : 'vs';
        shareFitText(ctx, agg, center, mid, 160, namePx, 800, 'center');

        // 2レグの内訳・PK・決まり方。合計と読み合わせられるよう、左のチームから見た点で出す
        const legs = t.legs.filter((l) => l.approved).map((l) => {
          const aHome = l.home === t.team_a;
          const sa = aHome ? l.home_score : l.away_score;
          const sb = aHome ? l.away_score : l.home_score;
          const pk = l.home_pk !== null && l.away_pk !== null
            ? '(PK' + (aHome ? l.home_pk + '-' + l.away_pk : l.away_pk + '-' + l.home_pk) + ')'
            : '';
          return (l.leg === '1' ? '1st ' : l.leg === '2' ? '2nd ' : '') + sa + '-' + sb + pk;
        });
        const note = legs.join(' ／ ') + (t.decided_by === 'PK戦' ? ' ／ PK戦で勝ち上がり' : '');
        if (note) {
          ctx.fillStyle = SHARE_COLORS.sub;
          shareFitText(ctx, note, center, y + rowH * 0.78, c.right - c.left - 40, legPx, 500, 'center');
        }
      }
      y += rowH;
    });
  });

  return c.canvas;
}

/**
 * 角の丸い四角のパス。古いブラウザは roundRect が無いので自前で引く。
 */
function shareRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// =============================================================================
// プレビューと保存
// =============================================================================

/**
 * 書き出した画像をプレビューで見せ、保存・共有を選んでもらう。
 *
 * 1枚なら (canvas, filename)、複数なら [{ canvas, filename, label }] を渡す。
 * GM1・GM2 の対戦表のように複数あるときは、画像ごとに保存ボタンを付け、
 * 「共有」は全部をまとめて送る（X は1投稿に4枚まで付けられる）。
 *
 * @param {HTMLCanvasElement|Array<{canvas: HTMLCanvasElement, filename: string, label?: string}>} canvas
 * @param {string} [filename] 拡張子なし
 */
function showShareImage(canvas, filename) {
  closeShareImage();
  const items = Array.isArray(canvas) ? canvas : [{ canvas, filename }];
  const list = items.map((it) => ({
    canvas: it.canvas,
    url: it.canvas.toDataURL('image/png'),
    label: it.label || '',
    alt: it.filename,
    name: it.filename.replace(/[\\/:*?"<>|\s]+/g, '_') + '.png',
  }));

  const wrap = document.createElement('div');
  wrap.id = 'share-modal';
  wrap.className = 'share-modal';
  wrap.innerHTML = `
    <div class="share-dialog" role="dialog" aria-label="画像の保存">
      ${list.map((it) => `
        <figure class="share-item">
          <img src="${it.url}" alt="${esc(it.alt)}" class="share-preview" />
          <a class="btn btn-primary btn-sm" href="${it.url}" download="${esc(it.name)}">${
            list.length > 1 && it.label ? esc(it.label) + ' を保存' : '画像を保存'}</a>
        </figure>`).join('')}
      <p class="muted note-sm">3:4（1080×1440）の画像です。スマホは「共有」から X や写真へ、または画像を長押しして保存できます。</p>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="share-native" style="display:none;">${
          list.length > 1 ? list.length + '枚まとめて共有' : '共有'}</button>
        <button type="button" class="btn btn-secondary" id="share-close">閉じる</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeShareImage(); });
  document.getElementById('share-close').onclick = closeShareImage;

  // 共有メニュー（X・写真に保存など）。対応している端末だけ出す
  Promise.all(list.map((it) => new Promise((resolve) => it.canvas.toBlob(resolve, 'image/png'))))
    .then((blobs) => {
      if (!navigator.canShare || blobs.some((b) => !b)) return;
      const files = blobs.map((b, i) => new File([b], list[i].name, { type: 'image/png' }));
      if (!navigator.canShare({ files })) return;
      const btn = document.getElementById('share-native');
      if (!btn) return;
      btn.style.display = '';
      btn.onclick = () => navigator.share({ files }).catch(() => {});
    });
}

/** プレビューを閉じる */
function closeShareImage() {
  const el = document.getElementById('share-modal');
  if (el) el.remove();
}
