import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * 管理画面を他のページの枠(iframe)に埋め込ませない。自分のドメインのサブドメインに置く構成では、同じ登録ドメインの
   * 兄弟ホスト(設置サイト)のページが管理画面を透明な枠に重ね、「公開する」などを押させることができるため(same-site の Cookie は枠にも付く)。
   * CSP は frame-ancestors だけにする(ほかのディレクティブを足すと画面のスクリプト・スタイルの読み込みに影響する)。
   * X-Frame-Options は frame-ancestors を解さない古いブラウザ向け。vinext は App Router の HTML と Route Handler の応答の両方に付ける(E2E で確かめている)
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
