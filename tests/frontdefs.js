const fs = require('fs');
const path = require('path');
const { t, eq, report } = require('./harness');

// フロントで呼んでいる関数が、どこかで定義されているか。
//
// views.js を置換で書き換えたときに、隣の関数ごと消してしまったことがある
// （エントリー画面の renderEntryStatusBox など4つ）。構文は正しいままなので
// 読み込みでは気づけず、画面が「読み込み中」のまま止まった。
// 呼び出し側だけ残って定義が消えていないかを機械的に確かめる。

const ROOT = path.join(__dirname, '..');
const FILES = ['app.js', 'auth.js', 'views.js', 'config.js']
  .filter((f) => fs.existsSync(path.join(ROOT, f)));
const src = FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

const defined = new Set();
for (const m of src.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/g)) defined.add(m[1]);

// 自前の関数らしい名前だけを見る（組み込みや DOM のメソッドを拾わないため）
const OWN = /^(render|load|on[A-Z]|update|fill|apply|bind|go|validate|reset|add[A-Z]|show[A-Z]|set(Result|Error|Loading))/;

t('呼び出している自前の関数はすべて定義されている', () => {
  const missing = new Set();
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (!OWN.test(name)) continue;
    if (!defined.has(name)) missing.add(name);
  }
  eq([...missing].sort(), []);
});

report('frontdefs.js');
