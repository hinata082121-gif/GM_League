const { t, eq, ok, report } = require('./harness');
const { env } = require('./sc-fixture');

// 移籍市場の開幕日時は日程表の「移籍期間開幕」から決まる。
// Season15 で開幕日時が日程より1日早く入っていて、有料プロテクトが
// 9/28 23:00 から出てしまった（正しくは 9/29 23:00）。

const PROTECT = {
  protect_free_start_before_days: 6,
  protect_free_before_days: 2,
  protect_paid_before_days: 1,
  protect_paid_start: '23:00',
  market_days: 3,
};

const TEMPLATE = [
  { day_offset: -12, label: '無料プロテクト締切' },
  { day_offset: -10, label: '移籍期間開幕［始］' },
  { day_offset: -8, label: '移籍期間［終］' },
  { day_offset: 0, label: 'リーグ戦開幕' },
];

const ymdh = (d) => {
  const x = new Date(d);
  return `${x.getMonth() + 1}/${x.getDate()} ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}`;
};

function generated() {
  const e = env({ config: PROTECT });
  e.saveScheduleTemplate('ORG', { rows: TEMPLATE });
  const r = e.generateSchedule('ORG', { season_id: 's1', opening_date: '2026-10-10' });
  return { e, r };
}

t('日程を作ると第1次移籍市場の開幕日時が日程の日付の0:00になる', () => {
  const { e, r } = generated();
  eq(r.ok, true);
  ok(r.data.market_open && r.data.market_open.window1_open_at, '開幕日時を返していない');
  const s = e.findRow('Seasons', 'season_id', 's1');
  eq(ymdh(s.window1_open_at), '9/30 0:00');
});

t('有料プロテクトは移籍市場開幕の前日23:00から', () => {
  const { e } = generated();
  const p = e._protectionPeriods(e.findRow('Seasons', 'season_id', 's1'), 1);
  eq(ymdh(p.paidStart), '9/29 23:00');
  eq(ymdh(p.freeEnd), '9/28 23:59');
});

t('日程で移籍期間開幕を動かすと開幕日時もついてくる', () => {
  const { e } = generated();
  const row = e.__rows('SeasonSchedule').slice(1).find((x) => x[3] === '移籍期間開幕［始］');
  const r = e.upsertScheduleItem('ORG', { schedule_id: row[0], season_id: 's1', date: '2026-10-01', label: '移籍期間開幕［始］' });
  eq(r.ok, true);
  eq(ymdh(e.findRow('Seasons', 'season_id', 's1').window1_open_at), '10/1 0:00');
});

t('第二次移籍期間開幕は第2次の開幕日時になる', () => {
  const { e } = generated();
  e.upsertScheduleItem('ORG', { season_id: 's1', date: '2026-11-07', label: '第二次移籍期間開幕［始］' });
  const s = e.findRow('Seasons', 'season_id', 's1');
  eq(ymdh(s.window2_open_at), '11/7 0:00');
  eq(ymdh(s.window1_open_at), '9/30 0:00', '第1次は動かない');
});

t('関係ない予定を直しても開幕日時は動かない', () => {
  const { e } = generated();
  e.upsertScheduleItem('ORG', { season_id: 's1', date: '2026-09-01', label: 'オークション開始' });
  eq(ymdh(e.findRow('Seasons', 'season_id', 's1').window1_open_at), '9/30 0:00');
});

report();
