/**
 * config.js — GM_League 設定値の一元管理
 *
 * ここに書いた値を index.html / auth.js / app.js から参照する。
 * GAS_URL はデプロイ後に判明するのでプレースホルダのまま。
 * 本番 URL が決まったら GAS_URL の値だけ書き換える。
 *
 * ⚠️ このファイルは GitHub Pages で公開されるため、
 *    秘密鍵・サービスアカウントキーなど機密情報は絶対に書かない。
 *    OAuth クライアント ID は公開情報なので問題なし。
 */

const GM_CONFIG = {
  /** Google OAuth 2.0 クライアント ID */
  OAUTH_CLIENT_ID:
    "1078761144028-uor0b4ukacklepi7g6u4i6jn90q33qc0.apps.googleusercontent.com",

  /**
   * GAS Web App の URL
   * clasp deploy 後に発行される URL を貼り付ける。
   * 例: "https://script.google.com/macros/s/AKfycb.../exec"
   */
  GAS_URL: "https://script.google.com/macros/s/AKfycbwsJa3Q5JzYJ50t8l1b0xS4cfJ1DmEEZ5U4GA8-hwDTVxNASBiKItfu1Z3ljAgZqWft/exec",

  /**
   * Google Sheets の スプレッドシート ID
   * 読み取り専用操作で Sheets API を直叩きするときに使用。
   * 書き込みはすべて GAS_URL 経由（SPEC.md §3 原則1）。
   */
  SPREADSHEET_ID: "1pi8-gYlKfc_fe_F4iY1idp3fD6lJMzMhW2HbLdQ42aM",

  /**
   * 公開 URL の控え。
   *
   * ⚠️ この値はコードから参照していない。**記録用**。
   *    実際の許可は Google Cloud Console 側の
   *    「承認済みの JavaScript 生成元」で行う。
   *    ここに書き足しただけでは origin_mismatch は直らない。
   *
   * 登録が必要なオリジン（末尾のスラッシュもパスも付けない）:
   *   https://hinata082121-gif.github.io   GitHub Pages
   *   https://gm-league-eight.vercel.app   Vercel（本番）
   *   http://localhost:8000                ローカル確認用
   */
  ORIGIN: "https://gm-league-eight.vercel.app",
};
