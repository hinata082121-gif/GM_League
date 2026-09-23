const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t, eq, ok, report } = require('./harness');
const { env } = require('./sp-fixture');

// 対戦表のランダム性と、ホーム・アウェイの連続上限。
//
//   - 2巡目は1巡目のホームアウェイを入れ替えただけの並びにしない
//   - ホームは最大3節連続、アウェイは最大2節連続（試合なしの節は詰めて数える）

function rngOf(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const teamsOf = (n) => Array.from({ length: n }, (_, i) => 't' + i);
const key = (m) => [m.home, m.away].sort().join('|');

function streaks(rounds, team) {
  const seq = [];
  rounds.forEach((ms) => {
    const m = ms.find((x) => x.home === team || x.away === team);
    if (m) seq.push(m.home === team ? 'H' : 'A');
  });
  let h = 0, a = 0, maxH = 0, maxA = 0;
  seq.forEach((v) => {
    if (v === 'H') { h++; a = 0; maxH = Math.max(maxH, h); } else { a++; h = 0; maxA = Math.max(maxA, a); }
  });
  return { maxH, maxA, home: seq.filter((v) => v === 'H').length, away: seq.filter((v) => v === 'A').length };
}

function check(rounds, teams, legs) {
  const n = rounds.length / legs;
  // 総当たり: 各組み合わせが legs 回、2巡なら向きが1回ずつ
  const seen = {};
  rounds.forEach((ms) => ms.forEach((m) => {
    const k = key(m);
    seen[k] = seen[k] || [];
    seen[k].push(m.home);
  }));
  eq(Object.keys(seen).length, teams.length * (teams.length - 1) / 2, '組み合わせの数');
  Object.values(seen).forEach((homes) => {
    eq(homes.length, legs);
    if (legs === 2) ok(homes[0] !== homes[1], '2巡でホームが入れ替わっていない');
  });
  // 1節に同じチームが2回出ない
  rounds.forEach((ms) => {
    const ts = ms.flatMap((m) => [m.home, m.away]);
    eq(new Set(ts).size, ts.length, '同じ節に2回出ている');
  });
  // 連続の上限
  teams.forEach((tm) => {
    const s = streaks(rounds, tm);
    ok(s.maxH <= 3, tm + ' がホーム ' + s.maxH + ' 連続');
    ok(s.maxA <= 2, tm + ' がアウェイ ' + s.maxA + ' 連続');
  });
  // 2チームだと1巡1節しかなく、並べ替えようがない
  if (legs === 2 && n > 1) {
    // どの節も1巡目の同じ位置と別の組み合わせ
    for (let i = 0; i < n; i++) {
      const a = rounds[i].map(key).sort().join(',');
      const b = rounds[n + i].map(key).sort().join(',');
      ok(a !== b, '第' + (i + 1) + '節と第' + (n + i + 1) + '節が同じ組み合わせ');
    }
    // 境目で同じ相手と連戦しない
    const last = new Set(rounds[n - 1].map(key));
    ok(!rounds[n].some((m) => last.has(key(m))), '1巡目最終節と2巡目第1節で同じ相手');
  }
}

t('7チーム2巡: 総当たり・並びの違い・連続上限をすべて満たす（100通り）', () => {
  const e = env();
  for (let s = 1; s <= 100; s++) {
    const rounds = e._roundRobin(teamsOf(7), 2, rngOf(s));
    eq(rounds.length, 14);
    check(rounds, teamsOf(7), 2);
  }
});

t('2〜12チームで2巡・1巡とも条件を満たす', () => {
  const e = env();
  for (let n = 2; n <= 12; n++) {
    for (let s = 1; s <= 5; s++) {
      check(e._roundRobin(teamsOf(n), 2, rngOf(n * 100 + s)), teamsOf(n), 2);
      check(e._roundRobin(teamsOf(n), 1, rngOf(n * 100 + s)), teamsOf(n), 1);
    }
  }
});

t('ホームとアウェイの数は各チーム同じ', () => {
  const e = env();
  const rounds = e._roundRobin(teamsOf(7), 2, rngOf(42));
  teamsOf(7).forEach((tm) => {
    const s = streaks(rounds, tm);
    eq(s.home, 6);
    eq(s.away, 6);
  });
});

t('作るたびに違う対戦表になる', () => {
  const e = env();
  const a = JSON.stringify(e._roundRobin(teamsOf(7), 2, rngOf(1)));
  const b = JSON.stringify(e._roundRobin(teamsOf(7), 2, rngOf(2)));
  ok(a !== b);
});

t('2巡目は1巡目のホームアウェイを入れ替えただけにならない', () => {
  const e = env();
  const rounds = e._roundRobin(teamsOf(7), 2, rngOf(7));
  const mirrored = rounds.slice(0, 7).every((ms, i) =>
    ms.map(key).sort().join(',') === rounds[7 + i].map(key).sort().join(','));
  eq(mirrored, false);
});

t('乱数を渡さなくても作れる（本番の呼び方）', () => {
  const e = env();
  const rounds = e._roundRobin(teamsOf(7), 2);
  check(rounds, teamsOf(7), 2);
});

t('連続の上限は Config で変えられる', () => {
  const e = env({ fixture_max_home_streak: 2, fixture_max_away_streak: 2 });
  for (let s = 1; s <= 20; s++) {
    const rounds = e._roundRobin(teamsOf(7), 2, rngOf(s));
    teamsOf(7).forEach((tm) => ok(streaks(rounds, tm).maxH <= 2));
  }
});

t('GAS の関数名が他のファイルと重ならない', () => {
  // GAS はすべてのファイルが1つの名前空間に入る。同名の関数は後から読んだ方で
  // 上書きされ、別の機能が黙って壊れる（_shuffle が使用監督の抽選と重なりかけた）
  const dir = path.join(__dirname, '..', 'gas');
  const seen = {};
  const dup = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen[m[1]]) dup.push(m[1] + ' (' + seen[m[1]] + ' / ' + f + ')');
      else seen[m[1]] = f;
    }
  });
  eq(dup, []);
});

report('fixturerandom.js');
