# eFootball 大会集計ツール（GM_League）設計仕様書

> Claude Code 実装用の設計ドキュメント。プロジェクトルートに `SPEC.md` として置き、`CLAUDE.md` から参照する。

---

## 0. このドキュメントの使い方

- これは「何を・どう作るか」の確定仕様。金額などの可変値は **すべて `Config` シートに外出し**しており、コードに直書きしない。
- 実装は §13 のフェーズ順で進める。各フェーズは独立して動作確認できる単位に切ってある。
- 「サーバー時刻」と書いてある箇所は必ず GAS（バックエンド）側で時刻を取得する。クライアント時計は信用しない。

---

## 1. プロジェクト概要

J リーグ選手のみを使用する eFootball の私設大会を運営するためのツール。リーグ戦＋トーナメント戦を行い、大会内通貨・選手移籍・特別ルール（強奪）などの独自経済システムを持つ。チームオーナーが自チームの編集と試合結果申請を行い、主催者が承認する。

### 主要コンセプト

- **大会内通貨**：実際のお金ではなく、ツール内でのみ流通する予算。
- **移籍制度**：交渉移籍・オークション・特別ルール（強奪）・無効化特別ルール。
- **プロテクト**：特別ルールから選手を守る仕組み（無料2枠＋有料3枠）。
- **承認制**：移籍・試合結果はすべて主催者承認を経て確定する。

---

## 2. アーキテクチャ

- フロント：GitHub Pages（HTML/CSS/Vanilla JS）。画面・操作。前回 futsal 資産を流用。
- 認証：Google Identity Services。ログイン、IDトークン発行。
- バックエンド：GAS Web App。APIゲートウェイ。全書き込みの検証・承認・時刻判定。
- DB：Google Sheets。1シート=1テーブル。
- 補助入力：Google Form（スポンサー収益の入力のみ）。

### 設計判断と理由

- **書き込みは必ず GAS 経由**。クライアントから直接 Sheets に書き込むと、誰でも他チームの予算・スカッド・承認状態を改ざんできる。GAS をオーナー権限で動かし、そこで「誰が・何を・いつ」を検証する。
- **読み取りは Sheets API 直叩きでも可**（他チームのスカッド閲覧・順位表など）。速度優先。ただし承認前データを混ぜないよう、読み取り時も status でフィルタする。
- **GAS はサーバーであってフロントではない**。画面・操作感は GitHub Pages で完結。GAS は JSON を返す API として使う。
- **スポンサー収益のみ Google Form 入力**を許容。それ以外の移籍報告などはアプリ内フォーム（2段プルダウン＋検証）で行う。Form は検証ロジックを持てないため。

---

## 3. 絶対に守る設計原則（5つ）

この5つを外すと後で必ず破綻する。実装中に迷ったらここに戻る。

1. **書き込みは必ず GAS 経由。** クライアントから Sheets 直書きしない。予算・プロテクト・承認を改ざんさせないため。読み取りのみ直叩き可。
2. **時刻判定はサーバー（GAS）側。** プロテクト期限・割引時間帯はクライアント時計を信用しない。
3. **予算残高はカラムで持たない。** 常に BudgetTx の合計（SUM）で算出。残高カラムは二重管理の温床。
4. **移籍は「買い手支払」と「売り手受取」を別カラム。** 特別ルールの「買い手3億・売り手0円」を1カラムでは表せない。
5. **承認前データを集計に混ぜない。** 順位表・ランキングは status=承認 のデータのみで都度導出。シートに保存しない。

補助原則：金額・人数・率・時刻はすべて Config シート参照（直書き禁止）。同時申請対策に GAS の LockService で書き込みを直列化。

---

## 4. データモデル（Google Sheets シート定義）

原則「1シート = 1テーブル」。履歴は season_id でぶら下げる。

### 4.1 Users
| カラム | 型 | 説明 |
|---|---|---|
| user_id | string | 主キー |
| email | string | Google アカウント email |
| display_name | string | 表示名 |
| role | enum | team / organizer |
| team_id | string | role=team の場合の所属チーム |

### 4.2 Seasons
| カラム | 型 | 説明 |
|---|---|---|
| season_id | string | 主キー |
| name | string | シーズン名 |
| status | enum | 準備中 / エントリー受付 / 移籍市場1 / シーズン1 / 移籍市場2 / シーズン2 / トーナメント / 終了 |
| leg_enabled | bool | トーナメント2ndレグ制を使うか |
| window1_open_at | datetime | 第1次移籍市場 開幕日時（3日間） |
| window2_open_at | datetime | 第2次移籍市場 開幕日時（3日間） |
| created_at | datetime | |

> 期限はすべて windowN_open_at から導出（§7.3）。

### 4.3 Teams
| カラム | 型 | 説明 |
|---|---|---|
| team_id | string | 主キー |
| name | string | チーム名 |
| owner_user_id | string | オーナー |
| kind | enum | 新規 / 継続 |
| active | bool | 大会参加中か |

### 4.4 Players
| カラム | 型 | 説明 |
|---|---|---|
| player_id | string | 主キー |
| name | string | 選手名 |
| position | enum | GK / DF / MF / FW |
| real_club | string | 現実の所属クラブ |
| eligible | bool | 大会エントリー可否（大会外クラブへ移籍したら false） |

> real_club の更新は主催者が手動。eligible=false の選手は翌シーズンのエントリーで弾く。

### 4.5 Rosters
| カラム | 型 | 説明 |
|---|---|---|
| roster_id | string | 主キー |
| season_id | string | |
| team_id | string | |
| player_id | string | |
| acquisition_type | enum | 初期 / 完全移籍 / 半期期限付き / 全期期限付き / 特別 / 無効化特別 / オークション |
| acquired_cost | number | 獲得時に支払った額（補填金計算の母数） |
| acquired_at | datetime | |
| expires_season | string | 期限切れシーズン（オークション=当該、半期=期限季、永続は空） |
| status | enum | 在籍 / 離脱 |

### 4.6 EntryLists
| カラム | 型 | 説明 |
|---|---|---|
| season_id | string | |
| team_id | string | |
| count | number | 登録人数（新規=28 / 継続=引継ぎ） |
| submitted_at | datetime | |
| status | enum | 下書き / 提出済 / 承認 |

### 4.7 Transfers
| カラム | 型 | 説明 |
|---|---|---|
| transfer_id | string | 主キー |
| season_id | string | |
| window | enum | 1 / 2 |
| player_id | string | |
| from_team | string | 売却側（オークション/初期は空） |
| to_team | string | 獲得側 |
| method | enum | 完全移籍 / 半期期限付き / 全期期限付き / 特別 / 無効化特別 / オークション |
| gross_fee | number | 交渉額・落札額・固定コスト |
| cost_to_buyer | number | 獲得側の実支払（§5.4 で算出） |
| payout_to_seller | number | 売却側の受取（§5.4 で算出） |
| registered_at | datetime | サーバー時刻（割引時間帯判定に使用） |
| status | enum | 申請中 / 承認 / 差戻 |

### 4.8 Protections
| カラム | 型 | 説明 |
|---|---|---|
| protection_id | string | 主キー |
| season_id | string | |
| window | enum | 1 / 2 |
| team_id | string | |
| player_id | string | |
| tier | enum | 無料1 / 無料2 / 有料1 / 有料2 / 有料3 |
| fee | number | 有料時の料金（§5.5） |
| set_at | datetime | サーバー時刻（期限ゲート判定に使用） |

### 4.9 BudgetTx
> 現保有額 = 該当チームの合計 SUM で常に算出（残高カラムは持たない）。

| カラム | 型 | 説明 |
|---|---|---|
| tx_id | string | 主キー |
| season_id | string | |
| team_id | string | |
| amount | number | ±（収入は+、支出/減額は−） |
| reason | enum | シーズン賞金 / スポンサー収益 / 順位賞金 / 得点王賞金 / 補填金_大会外移籍 / 補填金_辞退 / 移籍金収入 / 移籍金支出 / プロテクト料 / 罰金 / シーズン終了手数料 |
| ref | string | 関連 transfer_id / protection_id 等 |
| created_at | datetime | |

### 4.10 Matches
| カラム | 型 | 説明 |
|---|---|---|
| match_id | string | 主キー |
| season_id | string | |
| stage | enum | league / tournament |
| round | string | 節 / ラウンド名 |
| tie_id | string | 2レグを束ねる ID（リーグ・単発は空） |
| leg | enum | 1 / 2 / - |
| home_team | string | |
| away_team | string | |
| home_score | number | |
| away_score | number | |
| home_pk | number | PK戦（任意） |
| away_pk | number | PK戦（任意） |
| status | enum | 申請中 / 承認 / 差戻 |
| reported_by | string | 申請ユーザー |

### 4.11 MatchGoals
| カラム | 型 | 説明 |
|---|---|---|
| match_id | string | |
| team_id | string | 得点したチーム |
| scorer_id | string | 得点者 player_id |
| assist_id | string | アシスト者 player_id（無ければ空） |

### 4.12 MatchTeamStats
| カラム | 型 | 説明 |
|---|---|---|
| match_id | string | |
| team_id | string | |
| shots | number | シュート数 |
| shots_on_target | number | 枠内シュート数 |

### 4.13 MatchGKStats
| カラム | 型 | 説明 |
|---|---|---|
| match_id | string | |
| team_id | string | |
| gk_player_id | string | 起用GK（特例の手打ち追加も可） |
| saves | number | セーブ数 |

### 4.14 Config
可変値の一元管理。key / value の2カラム。初期値は §12 参照。

---

## 5. 経済ルール（確定版）

### 5.1 収入
| 種別 | 金額 | タイミング | 入力 |
|---|---|---|---|
| シーズン賞金 | Config | シーズン開始時 | 自動 |
| スポンサー収益 | フォーム入力値 | 第1次移籍市場開始前 | Google Form → 反映 |
| 順位賞金 | Config（順位別） | シーズン終了時 | 自動 |
| 得点王保持チーム賞金 | Config | シーズン終了時 | 自動 |
| 補填金（大会外移籍） | acquired_cost × 80% | 該当時 | 主催者 |
| 補填金（辞退） | acquired_cost × 90% | 該当時 | 主催者 |
| 移籍金収入 | §5.4 | 移籍承認時 | 自動 |

> オークション選手はシーズン終了で自動離脱するため、補填金・移籍金収入の対象外。

### 5.2 支出・減額
| 種別 | 金額 | 入力 |
|---|---|---|
| 移籍金支出 | cost_to_buyer | 自動 |
| プロテクト料 | §5.5 | 自動 |
| 罰金 | 都度 | 主催者 |
| シーズン終了手数料 | 残予算 × 10% | 自動（シーズン終了時） |

### 5.3 特別ルール / 無効化のコスト（固定額）
| 種別 | 第1次市場 | 第2次市場 | 最終日割引（22:00–23:30） |
|---|---|---|---|
| 特別ルール | 2.5億 | 3億 | 第1次=2億 / 第2次=2.25億 |
| 無効化特別ルール | 3.5億 | 4億 | 割引なし |

### 5.4 移籍形態ごとの buyer支払 / seller受取
| method | cost_to_buyer | payout_to_seller |
|---|---|---|
| 完全移籍 | gross_fee（交渉額） | gross_fee × 90% |
| 半期期限付き | gross_fee | gross_fee × 90% |
| 全期期限付き | gross_fee | gross_fee × 90% |
| 特別 | 固定額（§5.3、時間帯で割引判定） | 0（放出側は受け取れない） |
| 無効化特別 | 固定額（§5.3） | 固定額 × 70% |
| オークション | 落札額 | （売却側なし。プールへ） |

### 5.5 プロテクト料
| 枠 | 料金 |
|---|---|
| 無料1・無料2 | 0 |
| 有料1 | 3000万 |
| 有料2 | 4000万 |
| 有料3 | 5000万 |

---

## 6. 移籍・プロテクトのルール

### 6.1 移籍市場
- 各シーズン内に2回（第1次・第2次）、各3日間。
- オークションで獲得した選手は1シーズンのみ在籍し、シーズン終了で自動離脱。

### 6.2 プロテクト
- 無料プロテクト：移籍市場開幕前に2名選出可能。期限 = 開幕の前々日まで。
- 有料プロテクト：追加で3名。開幕前日23時以降に設定可能。料金は §5.5。
- 無効化特別ルールは、プロテクトされている選手も強奪可能。

### 6.3 特別ルール
- 相手との交渉なしで選手を強奪できる。
- 強奪された選手の放出側は移籍金を受け取れない（特別ルール時）。
- 無効化特別ルールでは、放出側は固定額の70%を受け取れる。

### 6.4 スカッド制約
- 最小22名、最大35名。
- 新規チーム：エントリーリストで28名選出。
- 継続チーム：前シーズンのスカッドを引き継ぐ。

### 6.5 現実移籍の扱い
- 現実の移籍はスカッドに反映しない。
- ただし大会参加外チームへ移籍した選手は Players.eligible=false とし、翌シーズンからエントリー不可。

---

## 7. バックエンド検証ルール（GAS で強制）

すべての書き込みリクエストで、保存前に以下を検証する。違反は理由付きで拒否。

### 7.1 共通
- IDトークン → email → Users 解決。role と team_id を確定。
- 対象 team_id が自チームか（organizer は全許可）。

### 7.2 移籍申請
- 現シーズン status が 移籍市場1 または 移籍市場2。
- 獲得側の現予算 ≥ cost_to_buyer（BudgetTx の SUM で算出）。
- 特別ルール：対象選手がプロテクトされていないこと。
- 無効化特別ルール：プロテクト中でも可。
- 移籍後の双方スカッドが 22–35 名の範囲に収まること（離脱で22未満になる放出は拒否）。
- eligible=false の選手は新規エントリー不可。

### 7.3 プロテクト設定（サーバー時刻で期限ゲート）
open = windowN_open_at を基準に判定（すべて GAS の new Date() で）。
- 無料プロテクト：now ≤ open − 2日（前々日まで）。枠は2まで。
- 有料プロテクト：now ≥ open − 1日 の 23:00（前日23時以降）。枠は3まで。料金を BudgetTx に計上。

### 7.4 特別ルールの割引時間帯判定
- 市場最終日（= open + 2日）の 22:00–23:30 に registered_at が入る場合、割引額を適用。
- 無効化特別ルールには割引を適用しない。

### 7.5 試合結果申請
- 申請者が home/away いずれかのオーナー、または organizer。
- 得点者・アシスト者は当該試合の出場チーム所属（プルダウンで担保、手打ち追加時のみ要チェック）。
- GK 集計の起用 GK は原則 position=GK（特例は手打ち追加を許容）。

---

## 8. GAS API 関数一覧

すべて doPost 経由の JSON-RPC 風。{ action, token, payload } を受け取り { ok, data | error } を返す。

### 認証・共通
- whoami — トークンからユーザー情報と権限を返す。

### チームオーナー向け
- submitEntryList — エントリーリスト提出。
- getMyTeam — 自チームのスカッド・予算・プロテクト状況。
- requestTransfer — 移籍申請（method 別にコスト算出 → 検証 → status=申請中で保存）。
- setProtection — プロテクト設定（期限ゲート §7.3）。
- submitMatchResult — 試合結果申請（Matches + Goals + TeamStats + GKStats を一括保存、status=申請中）。

### 主催者向け
- approveTransfer / rejectTransfer — 移籍承認時に BudgetTx（買い手支出・売り手収入）を自動計上。
- approveMatch / rejectMatch / correctMatch — 試合の承認・差戻・訂正。
- addPenalty — 罰金計上。
- addCompensation — 補填金計上（acquired_cost × 80% or 90%）。
- applySponsorIncome — フォーム入力のスポンサー額を反映。
- advanceSeason — シーズン進行（status 遷移、§11）。
- closeSeason — シーズン終了処理（順位賞金・得点王賞金・手数料10%控除・オークション選手離脱・継続スカッド引継ぎ生成）。
- setConfig — Config 値更新。

### 読み取り（Sheets API 直叩き or GAS どちらでも）
- getStandings — 順位表（承認済のみ）。
- getTournament — トーナメント表（1stレグ結果・合計スコア両方）。
- getRankings — 得点/アシスト/セーブ数/シュートセーブ率ランキング。
- getTeamSquad — 任意チームのスカッド閲覧。
- getProtections — プロテクト選手掲示。
- getHistory — 過去シーズン記録。

---

## 9. 画面一覧

| 画面 | ロール | 内容 |
|---|---|---|
| ログイン | 全 | Google ログイン |
| ダッシュボード | team | 自チーム概要（予算・スカッド人数・申請中件数） |
| エントリー提出 | team | 28名選出 / 引継ぎ確認 → 提出 |
| 移籍申請 | team | 2段プルダウン（ポジション→選手）、method 選択、コストと予算残のリアルタイム表示 |
| プロテクト設定 | team | 無料2/有料3 の選択、期限・料金表示 |
| 試合結果申請 | team | スコア・シュート/枠内（数値）、得点者/アシスト（2段プルダウン）、起用GK/セーブ |
| 他チーム閲覧 | 全 | 任意チームのスカッド・移籍形態・予算増減・現保有予算 |
| プロテクト掲示 | 全 | プロテクト中選手の一覧 |
| 順位表 | 全 | リーグ順位（タイブレーク §10.2） |
| トーナメント | 全 | ブラケット、1stレグ結果＋2試合合計スコア、PK |
| ランキング | 全 | 得点/アシスト/セーブ数/シュートセーブ率 |
| 過去大会記録 | 全 | season_id 切替で履歴閲覧 |
| 主催者モード | organizer | 承認待ち一覧、承認/差戻/訂正、罰金/補填、シーズン進行、Config 編集 |

### UI 実装メモ
- 得点者・アシスト者の選択は必ず「ポジション → 選手」の2段にする。
- GK 集計のプルダウンは position=GK のみを初期表示。特例のため手打ち追加ボタンも置く。
- 移籍申請画面では method 選択に応じて cost_to_buyer をリアルタイム計算し、予算残が足りない場合は申請ボタンを無効化（最終判定は GAS）。

---

## 10. 集計・ランキングロジック

> すべて status=承認 のデータのみを対象に算出。順位表・ランキングはシートに保存せず都度導出。

### 10.1 シュートセーブ率
セーブ率 = saves / 被枠内シュート数
被枠内シュート数 = そのGK出場試合における相手チームの shots_on_target 合計

### 10.2 リーグ順位タイブレーク
1. 勝点（勝3・分1・敗0）
2. 得失点差
3. 総得点
4. 直接対決成績

### 10.3 トーナメント（2ndレグ制）
1. 1stレグ結果報告 → 承認 → 1stレグのみを表示に反映。
2. 2ndレグ結果報告 → 承認 → 2試合合計スコアを反映。
3. 合計スコアで勝ち上がりを反映。同点時は PK戦結果（home_pk / away_pk）で判定。
4. 表示は「1stレグ結果」と「合計スコア」を両方掲示。
- tie_id で2試合を束ねる。アウェイゴールは採用しない（合計スコアのみ）。

### 10.4 ランキング種別
- 得点者（MatchGoals.scorer_id 集計）
- アシスト者（MatchGoals.assist_id 集計）
- セーブ数（MatchGKStats.saves 集計）
- シュートセーブ率（§10.1）

---

## 11. シーズンライフサイクル

準備中 → エントリー受付 → 移籍市場1(3日) → シーズン1 → 移籍市場2(3日) → シーズン2 → トーナメント → 終了

### closeSeason の処理内容
1. 順位賞金・得点王賞金を BudgetTx に計上。
2. 残予算 × 10% を「シーズン終了手数料」として控除。
3. オークション選手（expires_season=当該）を Rosters で status=離脱。
4. 次シーズン用 Rosters を生成（継続チームの在籍選手のみコピー）。
5. スポンサー額は次シーズンの第1次市場前にフォームで再入力。

---

## 12. Config 初期値（要確定 / 仮値で開始可）

| key | value（仮） | 備考 |
|---|---|---|
| season_prize | 0 | シーズン賞金（未定） |
| rank_prize_1 | 0 | 順位別賞金1位（未定） |
| rank_prize_2 | 0 | 順位別賞金2位（未定） |
| top_scorer_prize | 0 | 得点王保持チーム賞金（未定） |
| special_w1 | 250000000 | 特別 第1次 |
| special_w2 | 300000000 | 特別 第2次 |
| special_w1_discount | 200000000 | 特別 第1次 割引 |
| special_w2_discount | 225000000 | 特別 第2次 割引 |
| override_w1 | 350000000 | 無効化 第1次 |
| override_w2 | 400000000 | 無効化 第2次 |
| seller_rate_normal | 0.90 | 通常移籍の売却受取率 |
| seller_rate_override | 0.70 | 無効化の売却受取率 |
| protect_fee_1 | 30000000 | 有料プロテクト1枠目 |
| protect_fee_2 | 40000000 | 有料プロテクト2枠目 |
| protect_fee_3 | 50000000 | 有料プロテクト3枠目 |
| compensation_rate_transfer | 0.80 | 大会外移籍 補填率 |
| compensation_rate_withdrawal | 0.90 | 辞退 補填率 |
| season_end_fee_rate | 0.10 | シーズン終了手数料率 |
| squad_min | 22 | |
| squad_max | 35 | |
| new_team_entry_count | 28 | |
| discount_start | 22:00 | 最終日割引開始 |
| discount_end | 23:30 | 最終日割引終了 |
| free_protect_count | 2 | |
| paid_protect_count | 3 | |

> 賞金・スポンサー額が未定でもツールは動作する。仮値で実装し、確定後に Config を更新するだけ。

---

## 13. 実装フェーズ（Claude Code 進行順）

- Phase 0：基盤（Pages雛形 + Googleログイン + GASスケルトン + Sheetsセットアップ）
- Phase 1：マスタ & 閲覧（Players/Teams/Users 登録、他チーム閲覧、予算表示）
- Phase 2：エントリー（提出、22–35検証）
- Phase 3：移籍（申請・特別/無効化/オークション・承認→BudgetTx計上）
- Phase 4：プロテクト（無料2/有料3、サーバー時刻ゲート、掲示）
- Phase 5：試合集計（申請、承認/差戻/訂正）
- Phase 6：集計表示（順位表、トーナメント、各ランキング）
- Phase 7：経済周辺 & シーズン進行（罰金/補填/スポンサー、advanceSeason/closeSeason）
- Phase 8：仕上げ（過去大会記録、UI調整、エッジケース）

---

## 14. Claude Code への注意事項

- 時刻判定は必ず GAS 側（プロテクト期限・割引時間帯）。クライアント時計を信用しない。
- 予算残高はカラムで持たず、BudgetTx の SUM で常に算出する。
- 移籍は buyer支払と seller受取を別カラムで持つ。
- 承認前データを集計に混ぜない（順位・ランキングは status=承認 のみ）。
- 金額・人数・率・時刻はすべて Config 参照。直書き禁止。
- 得点者/アシスト/GK の選択は2段プルダウン（ポジション→選手）。GK 集計は position=GK 初期表示＋手打ち追加可。
- Sheets の書き込みは LockService で直列化する。
