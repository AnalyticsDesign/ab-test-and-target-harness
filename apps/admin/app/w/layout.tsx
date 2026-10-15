import type { ReactNode } from "react";
import { requireUser } from "@/lib/control";
import { loadCapabilities } from "@/lib/loaders";
import { shouldShowBreakGlassBanner } from "@/lib/capabilities";
import { BreakGlassBanner } from "@/components/BreakGlassBanner";
import { WriteFreezeBanner } from "@/components/WriteFreezeBanner";

/**
 * `/w/*` は認証済み領域。`requireUser()` は未ログインなら `/login` へ redirect する。
 * 枠(サイドバー)はこの下の layout が描く: Workspace の文脈があるのは `[wid]/layout.tsx`、無いのは `me/layout.tsx` と `page.tsx`
 */
export default async function AuthedLayout({ children }: { children: ReactNode }) {
  await requireUser();
  const caps = await loadCapabilities();
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* 凍結は全員の操作に関わるので一番上。凍結していないときも常にマウントする(開いていた画面にも取り直しで帯が出るように) */}
      <WriteFreezeBanner initial={caps.writeFreeze} />
      {shouldShowBreakGlassBanner(caps) ? <BreakGlassBanner /> : null}
      {children}
    </div>
  );
}
