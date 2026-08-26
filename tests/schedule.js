const { t, eq, ok, report } = require('./harness');
const { env, scheduleRows, dateOf } = require('./sc-fixture');

// ---- ひな型 ----------------------------------------------------------------

t('ひな型は日数の順に並ぶ', () => {
  const e = env();
  const rows = e.getScheduleTemplate('ORG').data.rows;
  eq(rows[0].label, 'エントリー変更締切');
  eq(rows[0].day_offset, -14);
  eq(rows[rows.length - 1].label, 'リーグ戦開幕');
  eq(rows[rows.length - 1].day_offset, 0);
});

t('同じ日は登録順を保つ', () => {
  const e = env();
  const rows = e.getScheduleTemplate('ORG').data.rows;
  const same = rows.filter((r) => r.day_offset === -13).map((r) => r.label);
  eq(same, ['スポンサー申告締切日', '無料プロテクト締切']);
});

t('ひな型は主催者のみ', () => {
  const e = env();
  eq(e.getScheduleTemplate('A').ok, false);
});

t('ひな型を丸ごと差し替えられる', () => {
  const e = env();
  const r = e.saveScheduleTemplate('ORG', {
    rows: [
      { day_offset: -5, label: '新しい予定A' },
      { day_offset: 0, label: 'リーグ戦開幕' },
    ],
  });
  eq(r.ok, true);
  eq(r.data.count, 2);
  eq(e.getScheduleTemplate('ORG').data.rows.length, 2);
});

t('名前が空の行は捨てる', () => {
  const e = env();
  e.saveScheduleTemplate('ORG', {
    rows: [
      { day_offset: -5, label: '有効' },
      { day_offset: -4, label: '   ' },
      { day_offset: 0, label: '開幕' },
    ],
  });
  eq(e.getScheduleTemplate('ORG').data.rows.length, 2);
});

t('空のひな型は保存できない', () => {
  const e = env();
  eq(e.saveScheduleTemplate('ORG', { rows: [] }).ok, false);
});

t('ひな型の保存は主催者のみ', () => {
  const e = env();
  eq(e.saveScheduleTemplate('A', { rows: [{ day_offset: 0, label: 'x' }] }).ok, false);
});

// ---- 生成 ------------------------------------------------------------------

t('開幕日を指定すると全部の日付が決まる', () => {
  const e = env();
  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  eq(r.ok, true);
  eq(r.data.count, 6);

  eq(dateOf(e, 'リーグ戦開幕'), '2026-06-01');
  eq(dateOf(e, 'エントリー変更締切'), '2026-05-18');   // 開幕の14日前
  eq(dateOf(e, '無料プロテクト締切'), '2026-05-19');
  eq(dateOf(e, '移籍期間［終］'), '2026-05-24');
  eq(dateOf(e, '（空き日）'), '2026-05-25');
});

t('月をまたいでも正しく計算される', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-03-05' });
  eq(dateOf(e, 'エントリー変更締切'), '2026-02-19');
});

t('うるう年をまたいでも正しい', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2028-03-10' });
  eq(dateOf(e, 'エントリー変更締切'), '2028-02-25');   // 2028年は閏年
});

t('翌シーズンは日付だけずれて同じ並びになる', () => {
  const e = env();
  e.__addRow('Seasons', { season_id: 's2', name: '2027シーズン', status: '準備中' });

  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  e.generateSchedule('ORG', { season_id: 's2', opening_date: '2026-12-01' });

  const labels = (sid) =>
    e.getSeasonSchedule('ORG', { season_id: sid }).data.items.map((i) => i.label);

  eq(labels('s1'), labels('s2'));
  eq(e.getSeasonSchedule('ORG', { season_id: 's2' }).data.items[0].date_label, '11月17日');
});

t('既に日程があると上書きなしでは拒否', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-07-01' });
  eq(r.ok, false);
  ok(r.error.includes('既に'), r.error);
  eq(dateOf(e, 'リーグ戦開幕'), '2026-06-01');
});

t('上書きを指定すれば作り直せる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-07-01', overwrite: true });
  eq(r.ok, true);
  eq(scheduleRows(e).length, 6);
  eq(dateOf(e, 'リーグ戦開幕'), '2026-07-01');
});

t('ひな型が空だと生成できない', () => {
  const e = env({ template: false });
  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  eq(r.ok, false);
  ok(r.error.includes('ひな型'), r.error);
});

t('開幕日がないと生成できない', () => {
  const e = env();
  eq(e.generateSchedule('ORG', { season_id: 's1' }).ok, false);
});

t('存在しないシーズンには生成できない', () => {
  const e = env();
  eq(e.generateSchedule('ORG', { season_id: 'nope', opening_date: '2026-06-01' }).ok, false);
});

t('生成は主催者のみ', () => {
  const e = env();
  eq(e.generateSchedule('A', { season_id: 's1', opening_date: '2026-06-01' }).ok, false);
});

t('他シーズンの日程は混ざらない', () => {
  const e = env();
  e.__addRow('Seasons', { season_id: 's2', name: '2027', status: '準備中' });
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  e.generateSchedule('ORG', { season_id: 's2', opening_date: '2026-12-01' });
  eq(e.getSeasonSchedule('ORG', { season_id: 's1' }).data.count, 6);
  eq(scheduleRows(e).length, 12);
});

// ---- 表示 ------------------------------------------------------------------

function withDates(offsetFromToday) {
  // 今日から offsetFromToday 日後を開幕にする
  const e = env();
  const d = new Date();
  d.setDate(d.getDate() + offsetFromToday);
  const iso = [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
  e.generateSchedule('ORG', { season_id: 's1', opening_date: iso });
  return e;
}

t('参加者も日程を見られる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const r = e.getSeasonSchedule('A', { season_id: 's1' });
  eq(r.ok, true);
  eq(r.data.count, 6);
});

t('日付順に並ぶ', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const items = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items;
  const dates = items.map((i) => i.date);
  eq(dates, dates.slice().sort());
});

t('日付と曜日が読みやすい形で返る', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const open = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items
    .find((i) => i.label === 'リーグ戦開幕');
  eq(open.date_label, '6月1日');
  eq(open.weekday, '月');   // 2026-06-01 は月曜
});

t('今日の予定が分かる', () => {
  const e = withDates(0);   // 今日が開幕日
  const d = e.getSeasonSchedule('ORG', { season_id: 's1' }).data;
  eq(d.today_items.length, 1);
  eq(d.today_items[0].label, 'リーグ戦開幕');
  eq(d.today_items[0].is_today, true);
});

t('次の予定が返る', () => {
  const e = withDates(10);   // 開幕は10日後
  const d = e.getSeasonSchedule('ORG', { season_id: 's1' }).data;
  ok(d.next, '次の予定が無い');
  // 開幕が10日後 → 開幕8日前（移籍期間［終］）が今日から2日後で最初の未来
  eq(d.next.label, '移籍期間［終］');
  eq(d.next.days_left, 2);
});

t('過ぎた予定は is_past になる', () => {
  const e = withDates(-1);   // 開幕が昨日
  const d = e.getSeasonSchedule('ORG', { season_id: 's1' }).data;
  ok(d.items.every((i) => i.is_past), '過去判定が漏れている');
  eq(d.next, null);
});

t('消化済みにした予定は次の予定から外れる', () => {
  const e = withDates(10);
  const d1 = e.getSeasonSchedule('ORG', { season_id: 's1' }).data;
  const first = d1.next;

  e.upsertScheduleItem('ORG', {
    schedule_id: first.schedule_id, season_id: 's1',
    date: first.date, label: first.label, done: true,
  });

  const d2 = e.getSeasonSchedule('ORG', { season_id: 's1' }).data;
  ok(d2.next.schedule_id !== first.schedule_id, '消化済みが次の予定のまま');
});

t('日程が無ければ空で返る', () => {
  const e = env();
  const d = e.getSeasonSchedule('ORG', { season_id: 's1' }).data;
  eq(d.count, 0);
  eq(d.next, null);
});

// ---- 個別の編集 ------------------------------------------------------------

t('1件だけ日付をずらせる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const item = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items
    .find((i) => i.label === '（空き日）');

  const r = e.upsertScheduleItem('ORG', {
    schedule_id: item.schedule_id, season_id: 's1',
    date: '2026-05-26', label: '（空き日）', note: '1日ずらした',
  });
  eq(r.ok, true);
  eq(r.data.created, false);
  eq(dateOf(e, '（空き日）'), '2026-05-26');
});

t('1件だけずらしても他の日程は動かない', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const item = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items
    .find((i) => i.label === '（空き日）');
  e.upsertScheduleItem('ORG', {
    schedule_id: item.schedule_id, season_id: 's1', date: '2026-05-26', label: '（空き日）',
  });
  eq(dateOf(e, 'リーグ戦開幕'), '2026-06-01');
  eq(dateOf(e, 'エントリー変更締切'), '2026-05-18');
});

t('予定を1件追加できる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const r = e.upsertScheduleItem('ORG', {
    season_id: 's1', date: '2026-05-30', label: '臨時ミーティング',
  });
  eq(r.ok, true);
  eq(r.data.created, true);
  eq(e.getSeasonSchedule('ORG', { season_id: 's1' }).data.count, 7);
});

t('予定を削除できる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const item = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items[0];
  eq(e.deleteScheduleItem('ORG', { schedule_id: item.schedule_id }).ok, true);
  eq(e.getSeasonSchedule('ORG', { season_id: 's1' }).data.count, 5);
});

t('名前が空だと保存できない', () => {
  const e = env();
  eq(e.upsertScheduleItem('ORG', { season_id: 's1', date: '2026-06-01', label: '' }).ok, false);
});

t('日付が無いと保存できない', () => {
  const e = env();
  eq(e.upsertScheduleItem('ORG', { season_id: 's1', label: 'x' }).ok, false);
});

t('編集と削除は主催者のみ', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const item = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items[0];
  eq(e.upsertScheduleItem('A', { season_id: 's1', date: '2026-06-01', label: 'x' }).ok, false);
  eq(e.deleteScheduleItem('A', { schedule_id: item.schedule_id }).ok, false);
});

// ---- 公開ページ ------------------------------------------------------------

t('公開ページに日程が載る', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const d = e.getPublicData({ season_id: 's1' }).data;
  ok(d.schedule, '日程が公開データに無い');
  eq(d.schedule.count, 6);
});

t('日程が無いシーズンでは null', () => {
  const e = env();
  eq(e.getPublicData({ season_id: 's1' }).data.schedule, null);
});

t('公開の日程に個人情報は含まれない', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  const s = JSON.stringify(e.getPublicData({ season_id: 's1' }).data.schedule);
  eq((s.match(/[\w.+-]+@[\w.-]+\.[a-z]+/gi) || []).length, 0);
});

t('トークンなしでも日程を取れる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  eq(e._route('getPublicData', '', { season_id: 's1' }).data.schedule.count, 6);
});

t('getSeasonSchedule は未ログインでは拒否', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-06-01' });
  eq(e._route('getSeasonSchedule', '', { season_id: 's1' }).ok, false);
});

t('開幕日が近すぎると過去日の件数を返す', () => {
  const e = env();
  // 今日を開幕日にすると、準備期間（-23〜-1）がすべて過去になる
  const today = new Date();
  const iso = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: iso });
  eq(r.ok, true);
  ok(r.data.past_count > 0, '過去日が数えられていない');
  ok(r.data.past_count < r.data.count, '開幕当日まで過去に数えている');
});

t('十分先の開幕日なら過去日は0件', () => {
  const e = env();
  const d = new Date();
  d.setDate(d.getDate() + 60);
  const iso = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');

  eq(e.generateSchedule('ORG', { season_id: 's1', opening_date: iso }).data.past_count, 0);
});

// ---- 分類と絞り込み --------------------------------------------------------

t('ラベルから分類が決まる', () => {
  const e = env();
  const c = (label) => e._scheduleCategory(label);

  eq(c('無料プロテクト開始'), 'プロテクト');
  eq(c('使用監督申告開始'), '使用監督');
  eq(c('第二次使用監督申告締切'), '使用監督');
  eq(c('エントリー変更開始'), 'エントリー');
  eq(c('移籍期間開幕［始］'), '移籍');
  eq(c('スポンサー申告締切日'), 'スポンサー');
  eq(c('開幕前EL提出日'), 'EL');
  eq(c('新規募集終了'), '募集');
  eq(c('継続参加者の募集期限'), '募集');
  eq(c('GMスーパーカップ'), '大会');
  eq(c('リーグ戦開幕'), '大会');
  eq(c('リーグ戦日程・対戦表 発表日'), '大会');
  eq(c('（空き日）'), 'その他');
});

t('複数の語を含むラベルは意図した側に寄る', () => {
  const e = env();
  // 「オークション選手掲示」は移籍ではなくオークション
  eq(e._scheduleCategory('オークション選手掲示'), 'オークション');
  // 「エントリー追加選手申告開始」はエントリー
  eq(e._scheduleCategory('エントリー追加選手申告開始'), 'エントリー');
});

t('一覧の各行に分類が付く', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-09-21' });

  const items = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items;
  const catOf = (label) => (items.find((i) => i.label === label) || {}).category;

  eq(catOf('無料プロテクト締切'), 'プロテクト');
  eq(catOf('スポンサー申告締切日'), 'スポンサー');
  eq(catOf('リーグ戦開幕'), '大会');
});

t('使われている分類だけが選択肢になる', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-09-21' });

  const cats = e.getSeasonSchedule('ORG', { season_id: 's1' }).data.categories;
  ok(cats.indexOf('プロテクト') !== -1, 'プロテクトが無い');
  ok(cats.indexOf('スポンサー') !== -1, 'スポンサーが無い');
  ok(cats.indexOf('使用監督') === -1, '使われていない分類が混ざっている');
  eq(cats.length, cats.filter((c, i) => cats.indexOf(c) === i).length);
});

// ---- 有料プロテクトの導出表示 ----------------------------------------------

/** 移籍市場の開幕日を入れて日程を作る */
function withMarket(day) {
  const e = env();
  e.updateRow('Seasons', 'season_id', 's1', { window1_open_at: new Date(2026, 8, day) });
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-09-21' });
  return e;
}

const paidOf = (e) => e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items
  .filter((i) => i.label.indexOf('有料プロテクト開始') === 0);

t('有料プロテクト開始が日程に出る', () => {
  const e = withMarket(11);
  const paid = paidOf(e);

  ok(paid.length >= 1, '有料プロテクト開始が出ていない');
  eq(paid[0].category, 'プロテクト');
  eq(paid[0].derived, true);
  eq(paid[0].schedule_id, '');
  ok(paid[0].note.indexOf('23:00') !== -1, paid[0].note);
});

t('有料プロテクトの日付は移籍市場開幕の1日前', () => {
  const paid = paidOf(withMarket(11));
  eq(paid[0].date.slice(0, 10), '2026-09-10');
});

t('導出項目はシートに書かれない', () => {
  const e = env();
  e.updateRow('Seasons', 'season_id', 's1', { window1_open_at: new Date(2026, 8, 11) });
  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-09-21' });

  eq(e.__rows('SeasonSchedule').length - 1, r.data.count);
  eq(paidOf(e).length > 0, true);
});

t('日程が無ければ導出項目も出ない', () => {
  const e = env();
  e.updateRow('Seasons', 'season_id', 's1', { window1_open_at: new Date(2026, 8, 11) });

  eq(e.getSeasonSchedule('ORG', { season_id: 's1' }).data.count, 0);
});

t('移籍市場の開幕日が未設定なら出ない', () => {
  const e = env();
  e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-09-21' });

  eq(e.getSeasonSchedule('ORG', { season_id: 's1' }).data.items
    .filter((i) => i.derived).length, 0);
});

report('schedule.js');
