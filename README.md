# GM_League

J リーグ選手限定の eFootball 私設大会を運営するための集計ツール。
独自通貨・移籍市場・特別ルール（強奪）・承認制フローを備える。

- **フロント**：GitHub Pages（HTML/CSS/Vanilla JS・ビルド不要）
- **認証**：Google Identity Services
- **バックエンド**：Google Apps Script Web App
- **DB**：Google Sheets（1シート = 1テーブル・全15シート）

公開 URL：https://hinata082121-gif.github.io/GM_League/

---

## ⚠️ この運用ルールを外さないこと

| ルール | 理由 |
|---|---|
| **clasp は使わない。** GAS の編集はスプレッドシートの「拡張機能 → Apps Script」からブラウザで直接行う | 初回セットアップで詰まったため方針転換。`gas/` 配下はミラー（バックアップ兼レビュー用）で、**正は GAS エディタ側** |
| **再デプロイで「新しいデプロイ」を作らない。** 既存デプロイの編集で新バージョンを出す | 新規デプロイだと URL が変わり `config.js` の更新が毎回必要になる |
| **GAS に貼るコードは行末コメントを避ける** | 貼り付け時に日本語コメントが途中改行され構文エラーになった実績あり |
| **書き込みは必ず GAS 経由。** フロントから Sheets 直書きしない | 予算・プロテクト・承認の改ざん防止（SPEC.md §3 原則1） |
| **金額・率・人数は Config シート参照。** コードに直書きしない | 運用中の調整を想定 |

詳細な設計原則は `SPEC.md §3` / `CLAUDE.md` を参照。

---

## ディレクトリ構成

```
/
├─ index.html        # ログイン画面（GitHub Pages root 公開）
├─ config.js         # 設定値一元管理（OAuthClientID / GAS URL / SpreadsheetID）
├─ auth.js           # Google Identity Services ログイン処理
├─ app.js            # GAS API 共通 fetch ラッパ（callApi）
├─ style.css         # 共通スタイルシート
├─ gas/              # GAS ソースのミラー（正は GAS エディタ側）
│   ├─ Code.gs         # doPost エントリポイント・action ルーティング
│   ├─ auth.gs         # トークン検証・whoami
│   ├─ config.gs       # Config シート読み取りヘルパ
│   ├─ lib.gs          # Sheets 読み書きヘルパ・LockService ラッパ
│   ├─ setupSheets.gs  # 全15シート作成・Config / Clubs 初期値投入（冪等）
│   ├─ api_master.gs   # Phase 1: マスタ & 閲覧の action ハンドラ
│   └─ seed.gs         # テストデータ投入・削除（手動実行）
├─ SPEC.md           # 確定仕様（データモデル・経済ルール・API 一覧・画面一覧）
├─ PROJECT.md        # 方針・進捗管理
└─ CLAUDE.md         # Claude Code 用ガイドライン
```

> GAS エディタ上のエントリファイル名は `コード.gs`（デフォルト名）。
> リポジトリ側の `Code.gs` と同じ中身を指す。

---

## セットアップ手順（初回のみ）

### Step 1：GAS プロジェクトを開く

1. [スプレッドシート「GMリーグ管理」](https://docs.google.com/spreadsheets/d/1pi8-gYlKfc_fe_F4iY1idp3fD6lJMzMhW2HbLdQ42aM) を開く
2. メニューの **拡張機能 → Apps Script** をクリック
3. GAS エディタが別タブで開く

### Step 2：ソースを貼り付ける

左の「ファイル」欄で `+` → **スクリプト** を選び、ファイル名を付けて
`gas/` 配下の各ファイルの中身をそのまま貼り付ける。

| GAS エディタ上のファイル名 | 貼り付け元 |
|---|---|
| `コード.gs`（既存） | `gas/Code.gs` |
| `auth` | `gas/auth.gs` |
| `config` | `gas/config.gs` |
| `lib` | `gas/lib.gs` |
| `setupSheets` | `gas/setupSheets.gs` |
| `api_master` | `gas/api_master.gs` |
| `seed` | `gas/seed.gs` |

> 貼り付け後、**行数がリポジトリ側と一致しているか必ず確認する。**
> 末尾が切れていると「Unexpected end of input」で実行できない。

### Step 3：シートを一括作成（`setupAll` を実行）

1. エディタ上部の関数選択プルダウンで **`setupAll`** を選ぶ
2. **▶ 実行** をクリック
3. 初回のみ権限承認 → 「詳細」→「GMリーグ管理（安全ではないページ）に移動」→「許可」
4. 「実行ログ」で 15 シート作成・Config 25 件・Clubs 60 件の投入を確認

> `setupAll` は既存シートを削除しない（冪等）。ヘッダーを変えたい場合は
> 対象シートを手動削除してから再実行する。

### Step 4：Web App としてデプロイ

**初回のみ**「新しいデプロイ」を使う。

1. 右上 **デプロイ → 新しいデプロイ**
2. 種類（歯車）：**ウェブアプリ**
3. 設定：

   | 項目 | 値 |
   |---|---|
   | 説明 | `Phase 0` |
   | 次のユーザーとして実行 | **自分** |
   | アクセスできるユーザー | **全員** |

4. 発行された URL（末尾 `/exec`。`/dev` ではない）をコピー
5. `config.js` の `GAS_URL` に貼り付けて GitHub に push

### Step 5：Users シートに主催者を登録

`whoami` は Users シートに登録済みの email しか通さない。

Users シートの2行目に以下を入力する。

| user_id | email | display_name | role | team_id |
|---|---|---|---|---|
| `u001` | 自分の Gmail | 表示名 | `organizer` | （空欄） |

### Step 6：GitHub Pages を有効化

```bash
git push origin main
```

リポジトリの **Settings → Pages** で Source を `Deploy from a branch`、
Branch を `main` / `/(root)` に設定して Save。

> Pages は**中身のあるブランチがないと公開元を選べない**。
> 先にコンテンツを push してから設定すること。
> また「ローカルにファイルがある」ことと「GitHub に反映されている」ことは別物なので、
> `git status` で未 push が無いか都度確認する。

### Step 7：動作確認

```bash
python -m http.server 8000
```

`http://localhost:8000` を開く（`file://` では Google Sign-In が動かない）。

サインインして、ユーザーバーに表示名と `主催者` バッジが出れば疎通完了。

---

## コードを更新するときの手順

> **ここを間違えると URL が変わって動かなくなる。**

1. GAS エディタで該当ファイルを編集（またはリポジトリから貼り直し）
2. 右上 **デプロイ → デプロイを管理**
3. アクティブなデプロイの **編集（鉛筆アイコン）** をクリック
4. バージョンを **「新バージョン」** に変更
5. **デプロイ** をクリック

これで **URL は変わらず**中身だけ更新される。`config.js` の修正は不要。

リポジトリ側の `gas/` も同じ内容に更新して commit しておくこと。

---

## テストデータの投入・削除

Phase 1 以降の画面確認用に、`seed.gs` で仮データを入れられる。

| 関数 | 内容 |
|---|---|
| `seedTestData` | シーズン1件・チーム3件・選手15件・スカッド15件・初期予算3件を投入 |
| `clearTestData` | 上記で投入した行（ID が `seed_` で始まる行）だけを削除 |

GAS エディタの関数プルダウンから選んで実行する。どちらも冪等。

> 選手名・所属クラブ・チーム名は動作確認用の暫定値。
> 本番の全選手データは `importPlayersCsv` で CSV 一括投入する。
> 初期予算額は Config の `seed_initial_budget` で変更できる。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `GAS URL が設定されていません` | `config.js` の `GAS_URL` がプレースホルダのまま | Step 4-5 を実施 |
| `unregistered` | Users シートに email が無い | Step 5 を実施。新メンバーは OAuth のテストユーザー追加も必要 |
| `invalid_token` | トークン期限切れ | リロードして再ログイン |
| `forbidden_organizer_only` | 主催者専用 action を team ロールで呼んだ | 想定どおりの動作 |
| `http_403` | GAS のアクセス設定が「全員」でない | デプロイ設定を確認 |
| CORS エラー | `GAS_URL` が古い／間違い | デプロイを管理で URL を再確認 |
| `Unexpected end of input` | 貼り付け時に末尾が切れた | 全文コピーし直し、行数を照合 |
| 「Google で確認されていません」 | 自作スクリプトへの通常警告 | 「詳細」→「移動」→「許可」で進めてよい |

---

## 開発フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 0 | 基盤：Pages + Google ログイン + GAS スケルトン + Sheets セットアップ | ✅ 完了 |
| 1 | マスタ & 閲覧 | 🔄 作業中 |
| 2 | エントリー | ⬜ |
| 3 | 移籍 | ⬜ |
| 4 | プロテクト | ⬜ |
| 5 | 試合集計 | ⬜ |
| 6 | 集計表示 | ⬜ |
| 7 | 経済周辺 & シーズン進行 | ⬜ |
| 8 | 仕上げ | ⬜ |

詳細は `SPEC.md §13` / `PROJECT.md §5` を参照。

---

## API 一覧（実装済み）

すべて `doPost` 経由。`{ action, token, payload }` → `{ ok, data }` / `{ ok:false, error }`。

### 認証

| action | 権限 | 内容 |
|---|---|---|
| `whoami` | 全員 | トークンからユーザー情報・ロールを返す |

### Phase 1：読み取り（ログイン済みなら誰でも）

| action | payload | 内容 |
|---|---|---|
| `listPlayers` | `eligible_only?`, `position?` | 選手マスタ（ポジション順） |
| `listTeams` | `active_only?` | チーム一覧 |
| `listSeasons` | — | シーズン一覧 |
| `listClubs` | — | 現実のJリーグクラブ一覧（カテゴリー別） |
| `getTeamSquad` | `team_id`, `season_id?` | スカッド（在籍のみ・ポジション別集計付き） |
| `getTeamBudget` | `team_id`, `season_id?` | 現保有予算（BudgetTx の SUM・reason 別内訳付き） |
| `getMyTeam` | `season_id?` | 自チームのチーム情報＋スカッド＋予算 |

### Phase 1：書き込み（主催者専用）

| action | payload | 内容 |
|---|---|---|
| `listUsers` | — | ユーザー一覧 |
| `listConfig` | — | Config 全件 |
| `upsertPlayer` | `player_id?`, `name`, `position`, `real_club?`, `eligible?` | 選手の追加・更新 |
| `upsertTeam` | `team_id?`, `name`, `owner_user_id?`, `kind?`, `active?` | チームの追加・更新 |
| `upsertUser` | `user_id?`, `email`, `display_name?`, `role?`, `team_id?` | ユーザーの追加・更新（email が一意キー） |
| `importPlayersCsv` | `csv` | CSV 一括登録（ヘッダー `name,position,real_club`） |
| `setConfig` | `key`, `value` | Config 値の更新・追加 |

未実装の action は `{ ok:false, error:"... は Phase N で実装します。" }` を返す。
