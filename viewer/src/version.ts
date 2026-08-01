/**
 * ビューアのリリースバージョン（information に表示する。A-02）。
 *
 * 値はビルド時に vite の define で焼き込まれる（viewer/vite.config.ts が
 * リポジトリ直下の VERSION を読む）。静的モード（file://）ではサーバーに
 * 問い合わせられないため、ビューア自身が版を持っている必要がある。
 */
declare const __APP_VERSION__: string;

// define は素のテキスト置換なので、未定義のまま実行される経路（define 無しの環境）だけが "dev" になる
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
