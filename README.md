# GM_League

J リーグ選手限定の eFootball 私設大会を運営するための集計ツール。
独自通貨・移籍市場・特別ルール（強奪）・承認制フローを備える。

- **フロント**：GitHub Pages（HTML/CSS/Vanilla JS・ビルド不要）
- **認証**：Google Identity Services
- **バックエンド**：Google Apps Script Web App
- **DB**：Google Sheets（1シート = 1テーブル・全19シート）

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
├─ public.html       # 公開ページ（ログイン不要・順位表/移籍動向/参加者一覧）
├─ register.html     # 参加登録ページ（合言葉 → ログイン → 申請）
├─ style.css         # 共通スタイルシート
├─ gas/              # GAS ソースのミラー（正は GAS エディタ側）
│   ├─ Code.gs         # doPost エントリポイント・action ルーティング
│   ├─ auth.gs         # トークン検証・whoami
│   ├─ config.gs       # Config シート読み取りヘルパ
│   ├─ lib.gs          # Sheets 読み書きヘルパ・LockService ラッパ
│   ├─ setupSheets.gs  # 全19シート作成・Config / Clubs 初期値投入（冪等）
│   ├─ api_master.gs     # Phase 1: マスタ & 閲覧
│   ├─ api_entry.gs      # Phase 2: エントリー提出・承認
│   ├─ api_transfer.gs   # Phase 3: 移籍
│   ├─ api_protection.gs # Phase 4: プロテクト
│   ├─ api_match.gs      # Phase 5: 試合集計
│   ├─ api_stats.gs      # Phase 6: 集計表示
│   ├─ api_season.gs     # Phase 7: 経済周辺・シーズン進行・賞金支給
│   ├─ api_division.gs   # ディビジョン割り当て・GMスーパーカップ
│   ├─ api_signup.gs     # 参加登録（合言葉・申請・承認）
│   ├─ api_public.gs     # 認証不要の公開データ
│   ├─ api_realtransfer.gs # 現実移籍・辞退・チーム変更の反映
│   ├─ api_claims.gs     # 補填の請求（払い戻し / 入れ替え）と精算
│   └─ seed.gs         # テストデータ投入・削除（手動実行）
├─ SPEC.md           # 確定仕様（データモデル・経済ルール・API 一覧・画面一覧）
├─ OPERATION.md      # 主催者向け運用マニュアル
├─ GUIDE.md          # 参加者向け使い方ガイド
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
| `api_division` | `gas/api_division.gs` |
| `api_signup` | `gas/api_signup.gs` |
| `api_public` | `gas/api_public.gs` |
| `api_realtransfer` | `gas/api_realtransfer.gs` |
| `api_claims` | `gas/api_claims.gs` |
| `seed` | `gas/seed.gs` |

> 貼り付け後、**行数がリポジトリ側と一致しているか必ず確認する。**
> 末尾が切れていると「Unexpected end of input」で実行できない。

### Step 3：シートを一括作成（`setupAll` を実行）

1. エディタ上部の関数選択プルダウンで **`setupAll`** を選ぶ
2. **▶ 実行** をクリック
3. 初回のみ権限承認 → 「詳細」→「GMリーグ管理（安全ではないページ）に移動」→「許可」
4. 「実行ログ」で 19 シート作成・Config の投入・Clubs 60 件の投入を確認

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
| 1 | マスタ & 閲覧 | ✅ 完了 |
| 2 | エントリー | ✅ 完了 |
| 3 | 移籍 | ✅ 完了 |
| 4 | プロテクト | ✅ 完了 |
| 5 | 試合集計 | ✅ 完了 |
| 6 | 集計表示 | ✅ 完了 |
| 7 | 経済周辺 & シーズン進行 | ✅ 完了 |
| 8 | 仕上げ | ✅ 完了 |

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

### Phase 2：エントリー

| action | 権限 | payload | 内容 |
|---|---|---|---|
| `getEntryStatus` | チーム | `season_id`, `team_id?` | 提出状況＋選択可能な選手（他チーム確保済みを除外） |
| `submitEntryList` | チーム | `season_id`, `team_id?`, `player_ids` | 提出。Rosters に `申請中` で保存 |
| `listEntryLists` | 主催者 | `season_id` | 全チームの提出状況 |
| `approveEntryList` | 主催者 | `season_id`, `team_id` | 承認 → Rosters を `在籍` に |
| `rejectEntryList` | 主催者 | `season_id`, `team_id` | 差戻 → `申請中` の行を削除 |
| `listSeasonStatuses` | 全員 | — | シーズン状態の選択肢 |
| `setSeasonStatus` | 主催者 | `season_id`, `status` | シーズン状態の切替 |

> エントリーを試すには、シーズン状態を「エントリー承認」画面で **`エントリー受付`** にする。
> `seedTestData` はシーズンを `準備中` で作り直すため、**seed を実行した後に**状態を変更すること。

### Phase 3：移籍

| action | 権限 | payload | 内容 |
|---|---|---|---|
| `getTransferOptions` | 全員 | `season_id`, `team_id?` | 市場状況・使える予算・形態別コスト・獲得候補 |
| `requestTransfer` | チーム | `season_id`, `to_team?`, `player_id`, `method`, `gross_fee?` | 移籍申請 |
| `respondTransfer` | 売り手 | `transfer_id`, `agree` | 同意／拒否 |
| `registerAuction` | 主催者 | `season_id`, `to_team`, `player_id`, `gross_fee` | オークション結果の登録 |
| `listTransfers` | 全員 | `season_id`, `pending_only?` | 移籍一覧 |
| `approveTransfer` | 主催者 | `transfer_id` | 承認（Rosters 移動 + BudgetTx 計上） |
| `rejectTransfer` | 主催者 | `transfer_id` | 差戻 |

> **獲得チームは `to_team` で渡す**（`team_id` ではない）。フロントの `requestTransfer` 呼び出しで
> 取り違えて「獲得チームが特定できません」になった実績あり。
>
> 移籍を試すには、シーズン状態を **`移籍市場1`** または **`移籍市場2`** にする。
> 予算は申請した時点で押さえられ、差戻・売り手拒否で解放される。

### Phase 4：プロテクト

| action | 権限 | payload | 内容 |
|---|---|---|---|
| `getProtectionStatus` | チーム | `season_id`, `team_id?` | フェーズ・残枠・次の料金・設定可能な選手 |
| `setProtection` | チーム | `season_id`, `team_id?`, `player_id` | 設定（有料は即時 BudgetTx 計上） |
| `getProtections` | 全員 | `season_id`, `window?` | プロテクト掲示 |

> tier は指定せず、フェーズと消費枠数から**自動で決まる**（無料1→無料2、有料1→有料2→有料3）。
> 受付期間は §7.3 のとおり時刻から導出する。シーズン status では判定していない。
>
> **解除できない。放出しても枠は戻らない。** `Protections` の行を削除する処理は存在しない。

### Phase 5：試合集計

| action | 権限 | payload | 内容 |
|---|---|---|---|
| `getMatchOptions` | 全員 | `season_id`, `home_team?`, `away_team?` | 両軍の選手一覧・オウンゴールの番兵値 |
| `listMatches` | 全員 | `season_id`, `stage?`, `status?` | 試合一覧 |
| `getMatchDetail` | 全員 | `match_id` | 得点・シュート・GK の明細 |
| `submitMatchResult` | 当事者/主催者 | 下記参照 | 試合結果の申請 |
| `approveMatch` | 主催者 | `match_id` | 承認 |
| `rejectMatch` | 主催者 | `match_id` | 差戻 |
| `correctMatch` | 主催者 | `match_id` + 申請と同じ内容 | 全項目を差し替え |

`submitMatchResult` の payload:

```
{
  season_id, stage: 'league'|'tournament', round,
  tie_id?, leg?, home_team, away_team, home_score, away_score, home_pk?, away_pk?,
  goals:      [{ team_id, scorer_id, assist_id? }],
  team_stats: [{ team_id, shots, shots_on_target }],
  gk_stats:   [{ team_id, gk_player_id, saves }]
}
```

> **オウンゴールは `scorer_id` に `__OG__`** を入れ、`team_id` は**得点が入った側**にする。
> ランキング集計では除外する（SPEC.md §10.4）。
>
> 得点者の件数はスコアと一致必須。画面側は得点者の入力行をスコアに連動させて生成するため、
> 不一致が構造的に起きない。
>
> 同じ節・同じ対戦は1件のみ。home/away を入れ替えても重複として検出する。

### Phase 6：集計表示（すべて読み取り専用・全ロール可）

| action | payload | 内容 |
|---|---|---|
| `getStandings` | `season_id`, `division?` | リーグ順位表（シーズン1・2合算）。`division` は `GM1` / `GM2` |
| `getTournament` | `season_id`, `stage?` | トーナメント表（tie_id で束ね、合計スコアと各レグ）。`stage` 既定は `tournament` |
| `getRankings` | `season_id`, `competition?` | 得点 / アシスト / セーブ数 / シュートセーブ率 |

> **集計対象は `status=承認` の試合のみ。** 結果はシートに保存せず毎回導出する（設計原則5）。
>
> タイブレークは 勝点 → 得失点差 → 総得点 → 直接対決（同点チーム間のミニリーグ）。
> すべて並ぶ場合は**同順位**として返す（`tied: true`）。判断根拠として `h2h` も各行に含める。
>
> トーナメントは**1stレグのホーム側を基準に**合計スコアと PK を正規化して返す。
>
> `competition` は `GM1リーグ` / `GM2リーグ` / `GMリーグ杯` / `GMスーパーカップ`。
> 省略すると全大会の合算になる。リーグは**両チームが同じディビジョンの試合**だけを拾う。
>
> シュートセーブ率の分母は「出場試合における相手チームの `shots_on_target` 合計」。
> `min_matches_for_save_rate`（既定2）未満の GK は除外する。

### Phase 7：経済周辺 & シーズン進行

| action | 権限 | payload | 内容 |
|---|---|---|---|
| `getSeasonProgress` | 全員 | `season_id` | 現在の状態・次の遷移・実施済みの経済処理 |
| `addPenalty` | 主催者 | `season_id`, `team_id`, `amount`, `note?` | 罰金の計上 |
| `addCompensation` | 主催者 | `season_id`, `team_id`, `player_id`, `kind` | 補填金（80% / 90%） |
| `applySponsorIncome` | 主催者 | `season_id`, `entries:[{team_id,amount}]` | スポンサー収益の反映 |
| `advanceSeason` | 主催者 | `season_id` | 状態を1つ進める |
| `closeSeason` | 主催者 | `season_id`, `next_season_id?` | シーズン終了処理（**全賞金をここで支給**） |
| `getRealTransferTargets` | 主催者 | `season_id`, `keyword?`, `only_owned?` | 現実移籍の反映対象と補填額 |
| `applyRealTransfers` | 主催者 | `season_id`, `player_ids[]`, `note?` | 一括で eligible=false にして補填金を即時計上 |
| `restorePlayerEligible` | 主催者 | `player_id` | 誤って外した選手を戻す |
| `withdrawTeam` | 主催者 | `season_id`, `team_id`, `kind`, `new_club?` | 辞退 / チーム変更 |
| `getMyClaims` | team | `season_id`, `team_id?` | 自分の補填請求と入れ替え候補 |
| `chooseClaim` | team | `claim_id`, `choice`, `replacement_player_id?` | 払い戻し / 入れ替えを選ぶ |
| `listClaims` | 主催者 | `season_id`, `status?` | 請求一覧 |
| `overrideClaim` | 主催者 | `claim_id`, `choice`, `replacement_player_id?` | 代行入力（期限後も可） |
| `voidClaim` | 主催者 | `claim_id` | 請求の無効化 |
| `settleClaims` | 主催者 | `season_id`, `force?` | 期限後の一括精算 |
| `getSeasonDivisions` | 全員 | `season_id` | ディビジョン割り当ての現状 |
| `setSeasonDivisions` | 主催者 | `season_id`, `assignments:[{team_id,division}]` | GM1 / GM2 の割り当て |
| `getSuperCup` | 全員 | `season_id` | スーパーカップの設定と前季王者の候補 |
| `setSuperCup` | 主催者 | `season_id`, `team_a`, `team_b`, `streamed`, `note?` | 出場チームと配信有無 |

> **`closeSeason` は取り消せない。** 二重実行は「シーズン終了手数料」の有無で判定して拒否する。
>
> 賞金は**同順位・同点なら該当チーム全てに満額**支給する（按分しない）。
> 手数料の母数は賞金計上**後**の残高。
>
> **賞金はすべて `closeSeason` で支給する。** リーグ順位賞金・GMリーグ杯・
> GMスーパーカップ・配信料・大会別得点王をこの順に計上してから手数料を引く。
> シーズン途中で配ると、手数料の母数がチームごとにずれるため。
>
> リーグ順位賞金は**一部制と二部制で金額表が違う**（Config の `prize_gm1_1div_*` /
> `prize_gm1_2div_*`）。二部制になるのは参加チームが `two_division_min_teams` 以上のときだけ。
>
> 配信料は**試合結果と無関係**に、`SuperCup.streamed` が真なら出場2チームへ支給する。
>
> **選手プール（§6.5）**: エントリーは**自クラブの実在選手からのみ**。
> 大会の選手プールは「参加クラブの選手の集合」になる。
>
> 参加クラブでなくなったクラブの選手は `eligible=false` になり、
> エントリー・移籍・引継ぎの3か所で締め出される。**効くのは翌シーズンから**。
>
> **補填はその場で入金しない。** 請求（Claims）を立て、参加者が
> 払い戻しか入れ替えかを選び、**選択期限を過ぎてから** `settleClaims` で精算する。
> 先に入金すると、使い切ってから入れ替えを選ばれて二重取りになるため。
>
> **チーム変更は完全リセット。** スカッド・予算・プロテクト・エントリー・
> 進行中の移籍申請をすべて初期化し、新規参加者と同じ状態にする。
> 戦力と予算を持ち越せるとクラブの乗り換えが有利になってしまうため。
> 予算は行を消さず、差額のマイナス取引を1行足してそろえる（原則3）。
>
> 引継ぎ先シーズンは**主催者が先に作成**しておく。closeSeason は自動生成しない。
> 引継ぎ時は `acquisition_type` と `acquired_cost` を保持する（補填金の母数になるため）。
>
> 半期期限付きは `advanceSeason` の「シーズン1 → 移籍市場2」で離脱。
> 全期期限付き・オークションは `closeSeason` まで残る。
>
> スポンサー収益は当面**主催者がアプリ上で入力**する（Google Form 連携は未実装）。

### 参加登録 & 公開ページ

| action | 権限 | payload | 内容 |
|---|---|---|---|
| `getPublicData` | 誰でも | `season_id?` | 順位表・移籍動向・参加者一覧（読み取り専用） |
| `getSignupInfo` | 誰でも | — | 受付中かどうか。**合言葉は返さない** |
| `getSignupClubs` | 誰でも | — | 選べるクラブ（カテゴリ別・使用済みフラグ付き） |
| `verifySignupCode` | 誰でも | `code` | 合言葉の照合 |
| `submitSignup` | ログインのみ | `code`, `display_name`, `team_name`, `x_id?`, `note?` | 参加申請 |
| `getMySignup` | ログインのみ | — | 自分の申請状況 |
| `listSignups` | 主催者 | `status?` | 申請一覧 |
| `approveSignup` | 主催者 | `signup_id`, `team_name?` | 承認（Users + Teams を作る） |
| `rejectSignup` | 主催者 | `signup_id`, `note?` | 却下 |

> **公開 action には書き込みを置かない。** email などの個人情報も返さない。
>
> 集計関数を内部から認証なしで呼ぶための合鍵 `PUBLIC_ACCESS` は**オブジェクト**。
> JSON で届く token は必ず文字列なので `===` にならず、外部から詐称できない。
>
> `submitSignup` の email は**必ずトークンから取る**。payload の email は無視する。
>
> チーム名は Clubs の実在クラブから選ぶ。許可カテゴリは Config の
> `signup_club_categories`（既定 `J1,J2`）。J3 は選択肢に出さないがデータは残す。
> 検証は `submitSignup` と `approveSignup` の両方で行う。

未実装の action は `{ ok:false, error:"... は Phase N で実装します。" }` を返す。
