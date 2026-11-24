import Script from "next/script";
import type { ReactNode } from "react";
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { POPSTATE_GUARD_SCRIPT } from "@/lib/popstate-guard";
import { HydrationMark } from "@/components/HydrationMark";
import { ThemeResync } from "@/components/ThemeResync";
import { ConfirmProvider } from "@/components/ConfirmProvider";

export const metadata = { title: "AB Test and Target Harness" };

/**
 * 全画面共通。枠(サイドバー・上部バー)は認証済み領域(app/w 以下)、ログイン系は app/(auth)/layout.tsx が持つ。
 * フォントは @fontsource の CSS を import してビルドの静的アセットにする(vinext の next/font/google は
 * 実行時に Google の CDN から読むため使わない)。
 * suppressHydrationWarning: 下の inline script が描画前に <html data-theme> を付けるので、サーバーの HTML と食い違う
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* vinext が head の開始タグの直後に置き、stylesheet と module より先に実行させる。 */}
        <Script id="wtt-popstate-guard" strategy="beforeInteractive">{POPSTATE_GUARD_SCRIPT}</Script>
      </head>
      <body>
        <ConfirmProvider>
          {children}
        </ConfirmProvider>
        <ThemeResync />
        <HydrationMark />
      </body>
    </html>
  );
}
