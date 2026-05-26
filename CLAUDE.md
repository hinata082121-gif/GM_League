# CLAUDE.md — GM_League

Claude Code がこのリポジトリで作業するときに必ず読むファイル。

## 関連ドキュメント

- **SPEC.md** — 確定仕様（データモデル・経済ルール・GAS API・画面一覧・実装フェーズ）
- **PROJECT.md** — 方針・進捗管理（技術スタック・ロードマップ・リスク）

実装の判断に迷ったら **必ず SPEC.md に戻る**。PROJECT.md で現在フェーズを確認する。

---

## 絶対に守る設計原則（SPEC.md §3 転記）

この5つを外すと後で必ず破綻する。実装中に迷ったらここに戻る。

1. **書き込みは必ず GAS 経由。** クライアントから Sheets 直書きしない。予算・プロテクト・承認を改ざんさせないため。読み取りのみ直叩き可。
2. **時刻判定はサーバー（GAS）側。** プロテクト期限・割引時間帯はクライアント時計を信用しない。GAS 内で `new Date()` を使う。
3. **予算残高はカラムで持たない。** 常に BudgetTx の合計（SUM）で算出。残高カラムは二重管理の温床。
4. **移籍は「買い手支払」と「売り手受取」を別カラム。** 特別ルールの「買い手3億・売り手0円」を1カラムでは表せない。
5. **承認前データを集計に混ぜない。** 順位表・ランキングは `status=承認` のデータのみで都度導出。シートに保存しない。

**補助原則：**
- 金額・人数・率・時刻はすべて Config シート参照（コードへの直書き禁止）。
- GAS の書き込みは LockService で直列化する（同時申請対策）。

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
├─ config.js         # 設定値一元管理（OAuthClientID・GAS URL等）
├─ auth.js           # Google Identity Services ログイン処理
├─ app.js            # GAS API 共通 fetch ラッパ（callApi関数）
├─ style.css         # スタイルシート
├─ gas/              # clasp 管理の GAS ソース
│   ├─ .clasp.json   # scriptId（デプロイ後に記入）
│   ├─ appsscript.json
│   ├─ Code.gs       # doPost エントリポイント・ルーティング
│   ├─ auth.gs       # トークン検証・whoami
│   ├─ config.gs     # Config シート読み取りヘルパ
│   ├─ lib.gs        # Sheets 読み書きヘルパ・LockService ラッパ
│   └─ setupSheets.gs# 全14シートをヘッダー付きで一括作成
├─ SPEC.md           # 確定仕様
├─ PROJECT.md        # 方針・進捗
└─ CLAUDE.md         # 本ファイル
```

---

## 実装フェーズ（SPEC.md §13）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 基盤：Pages雛形 + Googleログイン + GASスケルトン + Sheetsセットアップ | 🔄 作業中 |
| 1 | マスタ & 閲覧 | ⬜ |
| 2 | エントリー | ⬜ |
| 3 | 移籍 | ⬜ |
| 4 | プロテクト | ⬜ |
| 5 | 試合集計 | ⬜ |
| 6 | 集計表示 | ⬜ |
| 7 | 経済周辺 & シーズン進行 | ⬜ |
| 8 | 仕上げ | ⬜ |

---

## GAS doPost 規約

```
リクエスト: { action: string, token: string, payload: object }
成功レスポンス: { ok: true,  data: any }
失敗レスポンス: { ok: false, error: string }
```
