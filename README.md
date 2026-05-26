# GM_League

J リーグ選手限定の eFootball 私設大会を運営するための集計ツール。  
独自通貨・移籍市場・特別ルール（強奪）・承認制フローを備える。

- **フロント**：GitHub Pages（HTML/CSS/Vanilla JS）
- **認証**：Google Identity Services
- **バックエンド**：Google Apps Script（clasp 管理）
- **DB**：Google Sheets

公開 URL：https://hinata082121-gif.github.io/GM_League/

---

## ディレクトリ構成

```
/
├─ index.html        # ログイン画面（GitHub Pages root 公開）
├─ config.js         # 設定値一元管理（OAuthClientID / GAS URL）
├─ auth.js           # Google Identity Services ログイン処理
├─ app.js            # GAS API 共通 fetch ラッパ（callApi）
├─ style.css         # 共通スタイルシート
├─ gas/              # clasp 管理の GAS ソース
│   ├─ .clasp.json   # scriptId（デプロイ後に記入）
│   ├─ appsscript.json
│   ├─ Code.gs       # doPost エントリポイント・ルーティング
│   ├─ auth.gs       # トークン検証・whoami
│   ├─ config.gs     # Config シート読み取りヘルパ
│   ├─ lib.gs        # Sheets 読み書きヘルパ・LockService ラッパ
│   └─ setupSheets.gs# 全14シート作成・Config 初期値投入
├─ SPEC.md           # 確定仕様（データモデル・経済ルール・API 一覧）
├─ PROJECT.md        # 方針・進捗管理
└─ CLAUDE.md         # Claude Code 用ガイドライン
```

---

## セットアップ手順

### 前提

| ツール | バージョン確認 | インストール先 |
|--------|--------------|--------------|
| Node.js | `node -v` | https://nodejs.org/ |
| clasp  | `clasp -v`  | `npm install -g @google/clasp` |

---

### Step 1：clasp ログイン

```bash
clasp login
```

ブラウザが開くので Google アカウントでログインして許可する。

---

### Step 2：GAS プロジェクトを作成し scriptId を記入

1. https://script.google.com にアクセス
2. 「新しいプロジェクト」→ プロジェクト名を **GM_League** に変更
3. スクリプト URL から scriptId をコピー  
   例：`https://script.google.com/home/projects/<ここがscriptId>/edit`
4. `gas/.clasp.json` の `"PLACEHOLDER_SCRIPT_ID"` を書き換える

```json
{
  "scriptId": "あなたのscriptId",
  "rootDir": "."
}
```

---

### Step 3：GAS にファイルをアップロード

```bash
cd gas
clasp push
```

成功すると GAS エディタに `Code.gs`, `auth.gs`, `config.gs`, `lib.gs`, `setupSheets.gs` が反映される。

---

### Step 4：Google Sheets のシートを一括作成（`setupAll` を実行）

> ここが最初の手動実行ステップ。以下を順番に行う。

#### 4-1. GAS エディタを開く

```bash
clasp open
```

または https://script.google.com でプロジェクトを開く。

#### 4-2. 実行する関数を選択

エディタ上部のツールバーにある関数選択プルダウン（デフォルトは「関数を選択」）をクリックし、  
**`setupAll`** を選択する。

```
[ setupAll ▼ ]  ▶実行  🐛デバッグ
```

#### 4-3. 「実行」ボタンを押す

▶ ボタンをクリックする。

#### 4-4. 権限承認ダイアログが出たら許可する

初回実行時のみ以下の手順が必要。

1. 「権限を確認」をクリック
2. Google アカウントを選択
3. 「このアプリは Google で確認されていません」と出たら  
   「詳細」→「GM_League（安全ではないページ）に移動」をクリック
4. 「許可」をクリック

> ⚠️ 「確認されていません」は自分のスクリプトに対してよく出る表示。  
>    自分で作ったプロジェクトなので安全に許可できる。

#### 4-5. 実行ログを確認する

「実行ログ」タブ（または表示メニュー →「ログ」）を開いて確認する。

**正常時のログ例：**

```
╔══════════════════════════════════════╗
║  GM_League シートセットアップ開始    ║
╚══════════════════════════════════════╝
spreadsheetId: 1pi8-gYlKfc_fe_F4iY1idp3fD6lJMzMhW2HbLdQ42aM
  [sheet] 作成: Users（5 列）
  [sheet] 作成: Seasons（7 列）
  [sheet] 作成: Teams（5 列）
  [sheet] 作成: Players（5 列）
  [sheet] 作成: Rosters（9 列）
  [sheet] 作成: EntryLists（5 列）
  [sheet] 作成: Transfers（12 列）
  [sheet] 作成: Protections（8 列）
  [sheet] 作成: BudgetTx（7 列）
  [sheet] 作成: Matches（14 列）
  [sheet] 作成: MatchGoals（4 列）
  [sheet] 作成: MatchTeamStats（4 列）
  [sheet] 作成: MatchGKStats（4 列）
  [sheet] 作成: Config（2 列）
  [Config] 追加予定: season_prize = 0  // シーズン賞金（未定）
  ...（26 件）
  [Config] 26 件をバッチ書き込みしました。
────────────────────────────────────────
【作成】 14 シート: Users, Seasons, Teams, ...
【スキップ】 0 シート: なし
【Config】 追加 26 件 / スキップ 0 件
════════════════════════════════════════
セットアップ完了。ログを確認してエラーがないことを確認してください。
```

**再実行した場合（冪等）：**

```
  [sheet] スキップ（既存）: Users
  [sheet] スキップ（既存）: Seasons
  ...
【作成】 0 シート: なし
【スキップ】 14 シート: Users, Seasons, ...
【Config】 追加 0 件 / スキップ 26 件
```

---

### Step 5：GAS Web App をデプロイして URL を取得

1. GAS エディタ右上「デプロイ」→「新しいデプロイ」
2. 種類：**ウェブアプリ**
3. 設定：
   - 説明：`GM_League Phase 0`
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**
4. 「デプロイ」→ 表示された URL をコピー

`config.js` の `GAS_URL` にコピーした URL を貼り付ける：

```js
GAS_URL: "https://script.google.com/macros/s/AKfycb.../exec",
```

---

### Step 6：GitHub にプッシュして GitHub Pages を有効化

```bash
git remote add origin https://github.com/hinata082121-gif/GM_League.git
git push -u origin master
```

GitHub リポジトリの Settings → Pages → Source を **`master` ブランチのルート（`/`）** に設定する。

公開 URL：https://hinata082121-gif.github.io/GM_League/

---

### Step 7：動作確認（Phase 0 完了確認）

1. http://localhost:8000 で `index.html` を開く（または GitHub Pages URL）
2. 「Google でサインイン」をクリックしてログイン
3. ブラウザのコンソール（F12）に以下が出れば成功：

```
[auth] ログイン成功。トークンを取得しました。
[app] onSignIn — whoami を呼び出します
[app] whoami 成功: { email: "...", display_name: "...", role: "...", team_id: "..." }
```

> ⚠️ `whoami` は Users シートに登録済みアカウントのみ成功する。  
>    初回は主催者アカウントを Users シートに手動で追加してから確認する。

---

## シートが壊れた・ヘッダーを変更したい場合

`setupAll()` は **既存シートを削除しない**。  
ヘッダーを変更したい場合は：

1. Google Sheets でシートタブを右クリック →「削除」
2. GAS エディタで `setupAll()` を再実行

---

## 開発フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 0 | 基盤：Pages + Google ログイン + GAS スケルトン + Sheets セットアップ | 🔄 作業中 |
| 1 | マスタ & 閲覧 | ⬜ |
| 2 | エントリー | ⬜ |
| 3 | 移籍 | ⬜ |
| 4 | プロテクト | ⬜ |
| 5 | 試合集計 | ⬜ |
| 6 | 集計表示 | ⬜ |
| 7 | 経済周辺 & シーズン進行 | ⬜ |
| 8 | 仕上げ | ⬜ |

詳細は `SPEC.md §13` / `PROJECT.md §5` を参照。
