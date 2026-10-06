const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// シーズンを進める操作の二重実行。
//
// 通信が遅れて結果を受け取れず、画面が「失敗」と見せたまま押し直すと、
// 1つ進んだところからもう1つ進んでしまう（移籍市場1 → シーズン1 → 移籍市場2）。
// 画面が見ていた状態（from_status）を添えて送れば、2回目は断れる。

function at(status) {
  const e = env();
  const rows = e.__rows('Seasons');
  const col = rows[0];
  rows.slice(1).find((r) => r[col.indexOf('season_id')] === 's1')[col.indexOf('status')] = status;
  e.__dropCache('Seasons');
  return e;
}

const statusOf = (e) =>
  e.listSeasons('ORG').data.filter((s) => s.season_id === 's1')[0].status;

t('見ていた状態と同じなら1つ進む', () => {
  const e = at('移籍市場1');
  const r = e.advanceSeason('ORG', { season_id: 's1', from_status: '移籍市場1' });
  eq(r.ok, true, r.error);
  eq(r.data.status, 'シーズン1');
  eq(statusOf(e), 'シーズン1');
});

t('同じ画面から押し直した2回目は断り、2つ進まない', () => {
  const e = at('移籍市場1');
  eq(e.advanceSeason('ORG', { season_id: 's1', from_status: '移籍市場1' }).ok, true);

  const second = e.advanceSeason('ORG', { season_id: 's1', from_status: '移籍市場1' });
  eq(second.ok, false);
  ok(second.error.includes('シーズン1'), second.error);
  ok(second.error.includes('何もしていません'), second.error);
  eq(statusOf(e), 'シーズン1', '移籍市場2まで進んでいない');
});

t('from_status を渡さない古い画面でも従来どおり進む', () => {
  const e = at('移籍市場1');
  eq(e.advanceSeason('ORG', { season_id: 's1' }).ok, true);
  eq(statusOf(e), 'シーズン1');
});

t('断ったときは何も書き換えない', () => {
  const e = at('シーズン1');
  const r = e.advanceSeason('ORG', { season_id: 's1', from_status: '移籍市場1' });
  eq(r.ok, false);
  eq(statusOf(e), 'シーズン1');
});

t('主催者以外は進められない', () => {
  const e = at('移籍市場1');
  eq(e.advanceSeason('A', { season_id: 's1', from_status: '移籍市場1' }).ok, false);
  eq(statusOf(e), '移籍市場1');
});

report('advanceguard.js');
