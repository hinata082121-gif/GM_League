/**
 * テストを全部走らせる。
 *
 *   node tests/run.js
 *
 * GAS の .gs は Node からは読めないので、harness.js が vm で読み込んで
 * SpreadsheetApp などを差し替えている。Sheets には一切触らない。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .filter((f) => f !== 'harness.js' && f !== 'run.js' && !f.endsWith('-fixture.js'))
  .sort();

let passed = 0;
let failed = 0;

files.forEach((f) => {
  let out;
  let ng = false;

  try {
    out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    ng = true;
  }

  process.stdout.write(out);

  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (m) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  } else if (ng) {
    failed++;
  }
});

console.log('----');
console.log(files.length + ' ファイル / ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
