import type { ReactNode } from "react";
import { requireUser } from "@/lib/control";
import { allInOrder, loadCapabilities, loadSummary } from "@/lib/loaders";
import { shouldShowBreakGlassBanner } from "@/lib/capabilities";
import { BreakGlassBanner } from "@/components/BreakGlassBanner";
import { CapabilitiesBanners } from "@/components/CapabilitiesBanners";
import { StaticHealthBanner } from "@/components/StaticHealthBanner";
import { AppShell } from "@/components/ui/AppShell";
import { Sidebar } from "@/components/ui/Sidebar";
import { SettingsOriginProvider } from "@/components/ui/SettingsOrigin";
import { PageLeaveGuard } from "@/components/ui/PageLeaveGuard";

/**
 * `/w/*` は認証済み領域。`requireUser()` は未ログインなら `/login` へ redirect する。
 * 外枠(AppShell + Sidebar)はここ 1 か所で描く(B60)。上部バーと本文(TopBar / Content)は各ページ・下の layout が描く。
 * 外枠を 1 か所にするのは、ホーム・ワークスペース・設定の間を移ってもサイドバーと「設定を開いた場所」の記憶(SettingsOriginProvider)が残るようにするため。
 *
 * summary(全ワークスペースのサイト一覧)はここで最初に 1 回読む。`/w/me/*`(設定)でも読むのは、設定の中に切り替えの枠を出すため。
 * この layout はクライアント遷移で描き直されないので、`[wid]` が変わる遷移では `[wid]/layout.tsx` の SummarySync が新しいものに差し替える。
 * summary が取れないときも例外にしない(vinext ではこの layout の例外を app/error.tsx が受けず、素の 500 になる)。空の一覧で外枠を描く。
 * エラーを出すのは summary を使う画面だけ: `[wid]/layout.tsx`(ワークスペースの画面。枠の中にエラーの文)、ホームと設定の API キー
 * (requireSummary の例外 → app/error.tsx)、設定のワークスペース(画面の中にエラーの文)。
 * それ以外の設定の画面(画面表示・システム管理者・使用状況)は summary を使わないので、切り替えの一覧が空になるだけ
 */
export default async function AuthedLayout({ children }: { children: ReactNode }) {
  // 3 つは互いに依らないので並べて読む。失敗は並べた順に判定する(未ログインは requireUser の redirect が先)
  const [user, caps, summary] = await allInOrder([requireUser(), loadCapabilities(), loadSummary()]);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* 凍結(全員の操作に関わるので一番上)と版の帯。取り直しは CapabilitiesBanners の 1 回を共有する。どちらも無いときも常にマウントする(開いていた画面にも取り直しで帯が出るように) */}
      <CapabilitiesBanners initial={caps} />
      {/* 7o K14: 設置タグの配信ファイルの帯はシステム管理者だけ。状態はクライアントだけが取る(この layout の描画にデプロイ専用の Worker への往復を足さない) */}
      {user.instanceAdmin ? <StaticHealthBanner /> : null}
      {shouldShowBreakGlassBanner(caps) ? <BreakGlassBanner /> : null}
      {/* 離れる前の確認(未保存の変更・保存の途中)。リンク・ログアウト・再読み込み・戻る・進むを止める。外枠と同じくクライアント遷移で作り直されない所に 1 つだけ置く */}
      <PageLeaveGuard />
      <SettingsOriginProvider summary={summary.status === 200 ? summary.data : []}>
        <AppShell sidebar={<Sidebar user={user} caps={{ imageUpload: caps.imageUpload, imageUploader: caps.imageUploader }} />}>{children}</AppShell>
      </SettingsOriginProvider>
    </div>
  );
}
