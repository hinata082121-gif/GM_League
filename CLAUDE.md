# CLAUDE.md — GM_League

Claude Code がこのリポジトリで作業するときに必ず読むファイル。

## 関連ドキュメント

- **SPEC.md** — 確定仕様（データモデル・経済ルール・GAS API・画面一覧・実装フェーズ）
- **PROJECT.md** — 方針・進捗管理（技術スタック・ロードマップ・リスク）
- **OPERATION.md** — 主催者向け運用マニュアル（本番投入手順・シーズンの回し方・トラブル対応）
- **GUIDE.md** — 参加者向け使い方ガイド

実装の判断に迷ったら **必ず SPEC.md に戻る**。PROJECT.md で現在フェーズを確認する。

---

## 絶対に守る設計原則（SPEC.md §3 転記）

この5つを外すと後で必ず破綻する。実装中に迷ったらここに戻る。

1. **書き込みは必ず GAS 経由。** クライアントから Sheets 直書きしない。予算・プロテクト・承認を改ざんさせないため。読み取りのみ直叩き可。
2. **時刻判定はサーバー（GAS）側。** プロテクト期限・割引時間帯はクライアント時計を信用しない。GAS 内で `new Date()` を使う。
3. **予算残高はカラムで持たない。** 常に BudgetTx の合計（SUM）で算出。残高カラムは二重管理の温床。
4. **移籍は「買い手支払」と「売り手受取」を別カラム。** 特別ルールの「買い手3億・売り手0円」を1カラムでは表せない。
5. **承認前データを集計に混ぜない。** 順位表・ランキングは `status=承認` のデータのみで都度導出。シートに保存しない。

**公開エンドポイントの原則：**

`getPublicData` / `getSignupInfo` / `verifySignupCode` は**トークンなしで誰でも叩ける**。
ここに追加してよいのは読み取り専用の action だけで、書き込みは絶対に置かない。
返す内容に email などの個人情報を含めないこと（`api_public.gs` のテストで検査している）。

集計関数を内部から認証なしで呼ぶための合鍵 `PUBLIC_ACCESS` は**オブジェクト**。
JSON で届く token は必ず文字列なので `===` にならず、外部から詐称できない。
文字列の定数に変えてはいけない。

**補助原則：**
- 金額・人数・率・時刻はすべて Config シート参照（コードへの直書き禁止）。
- GAS の書き込みは LockService で直列化する（同時申請対策）。

---

## GAS 運用ルール（確定・変更禁止）

- **clasp は不採用。** スプレッドシートの「拡張機能 → Apps Script」からブラウザで直接編集・デプロイする。
  `gas/` 配下はミラー（バックアップ兼レビュー用）であり、正はGASエディタ側。
- **再デプロイは「新しいデプロイ」を作らない。**
  「デプロイを管理 → 既存デプロイの編集（鉛筆）→ バージョン：新バージョン → デプロイ」で
  **URLを変えずに**中身だけ更新する。URLが変わると `config.js` の更新が毎回必要になるため。
- **GASへ貼るコードは行末コメント（`// ...`）を避けるか短くする。**
  貼り付け時に日本語コメントが途中改行され構文エラー（Unexpected end of input 等）を起こした実績あり。
  長いファイルを貼るときは全文コピーを確実に行い、貼付後に行数一致を確認する。
- 対象シートは `SpreadsheetApp.openById(SPREADSHEET_ID)` で明示指定する（`getActiveSpreadsheet()` は使わない）。
- 「このアプリは Google で確認されていません」警告は自作スクリプトへの通常表示。詳細→移動→許可で進めてよい。

---

## フロント側の注意

- **フロントのファイルを変更したらハードリロード（Ctrl+Shift+R）する。**
  通常のリロードだとブラウザが古い `app.js` / `auth.js` / `views.js` / `style.css` を
  キャッシュから使い続け、「直したのに直っていない」という誤診につながった実績あり。
- **Google ID トークンは約1時間で失効する。** 失効後は全 API が `invalid_token` になる。
  `auth.js` が JWT の `exp` を読んで残り時間を把握し、5分前に警告バナー、
  失効後は通信せずに赤バナーを出す。**正当性の判定は従来どおり GAS 側のみ**で行い、
  クライアント側の判定は UX 用途に限定する（設計原則2を崩さない）。
- **GAS はデプロイ直後、一時的に 404 を返すことがある。**
  `callApi` が 1.5 秒後に1回だけ自動リトライする。それでも 404 が続く場合は
  デプロイ設定（URL・アクセス権）を疑う。

---

## アーキテクチャ概要

```
GitHub Pages (index.html + auth.js + app.js)
    │  Google Identity Services でログイン → IDトークン取得
    │
    ▼ callApi(action, payload) — app.js
GAS Web App (gas/Code.gs doPost)
    │  トークン検証 → action ルーティング → 検証 → Sheets 読み書き
    │
    ▼
Google Sheets (spreadsheetId: 1pi8-gYlKfc_fe_F4iY1idp3fD6lJMzMhW2HbLdQ42aM)
```

## 設定値の所在

すべての設定値は `config.js` に集約されている。

```
config.js
  OAUTH_CLIENT_ID   — Google OAuth クライアントID
  SPREADSHEET_ID    — Google SpreadSheet ID
  GAS_URL           — GAS Web App URL（デプロイ後に記入）
```

---

## ファイル構成

```
/
├─ index.html        # ログイン画面（GitHub Pages root公開）
├─ public.html       # 公開ページ（ログイン不要）
├─ register.html     # 参加登録ページ（合言葉が必要）
├─ config.js         # 設定値一元管理（OAuthClientID・GAS URL等）
├─ auth.js           # Google Identity Services ログイン処理
├─ app.js            # GAS API 共通 fetch ラッパ（callApi関数）
├─ views.js          # 全画面のロジック（タブ単位で関数を分けている）
├─ style.css         # スタイルシート
├─ gas/              # GAS ソースのミラー（正はGASエディタ側。clasp不採用）
│   ├─ appsscript.json
│   ├─ Code.gs         # doPost エントリポイント・ルーティング
│   ├─ auth.gs         # トークン検証・whoami
│   ├─ config.gs       # Config シート読み取りヘルパ
│   ├─ lib.gs          # Sheets 読み書きヘルパ・LockService ラッパ
│   ├─ setupSheets.gs  # 全18シート作成・Config / Clubs 初期値投入（冪等）
│   ├─ api_master.gs   # Phase 1: マスタ & 閲覧
│   ├─ api_entry.gs    # Phase 2: エントリー提出・承認
│   ├─ api_transfer.gs # Phase 3: 移籍（コスト算出・承認・オークション）
│   ├─ api_protection.gs # Phase 4: プロテクト（期限ゲート・枠管理）
│   ├─ api_match.gs    # Phase 5: 試合集計（申請・承認・訂正）
│   ├─ api_stats.gs    # Phase 6: 順位表・トーナメント・ランキング
│   ├─ api_season.gs   # Phase 7: 経済周辺・シーズン進行・賞金支給
│   ├─ api_division.gs # ディビジョン割り当て・GMスーパーカップ
│   ├─ api_signup.gs   # 参加登録（合言葉・申請・承認）
│   ├─ api_public.gs   # 認証不要の公開データ
│   ├─ api_realtransfer.gs # 現実移籍の反映（eligible解除＋補填金）
│   └─ seed.gs         # テストデータ投入/削除（手動実行）
├─ SPEC.md           # 確定仕様
├─ OPERATION.md      # 主催者向け運用マニュアル
├─ GUIDE.md          # 参加者向け使い方ガイド
├─ PROJECT.md        # 方針・進捗
└─ CLAUDE.md         # 本ファイル
```

---

## 実装フェーズ（SPEC.md §13）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 基盤：Pages雛形 + Googleログイン + GASスケルトン + Sheetsセットアップ | ✅ |
| 1 | マスタ & 閲覧 | ✅ |
| 2 | エントリー | ✅ |
| 3 | 移籍 | ✅ |
| 4 | プロテクト | ✅ |
| 5 | 試合集計 | ✅ |
| 6 | 集計表示 | ✅ |
| 7 | 経済周辺 & シーズン進行 | ✅ |
| 8 | 仕上げ | ✅ |

---

## GAS doPost 規約

```
リクエスト: { action: string, token: string, payload: object }
成功レスポンス: { ok: true,  data: any }
失敗レスポンス: { ok: false, error: string }
```
