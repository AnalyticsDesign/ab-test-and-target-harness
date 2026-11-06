"use client";
import type { MouseEvent } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { usePathname } from "next/navigation";
import type { Capabilities, SessionUser } from "@/lib/types";
import { activeSegment, siteNav, originOfPath, resolveOrigin, settingsEntryHref, sidebarContext, type SettingsOrigin } from "@/lib/nav";
import { isPlainLeftClick } from "@/lib/leave-guard";
import { roleLabel } from "@/lib/roles";
import { setSettingsSection } from "@/lib/settings-section";
import { ContextSwitcher } from "./ContextSwitcher";
import { NavItem } from "./NavItem";
import { SettingsSidebar } from "./SettingsSidebar";
import { useSettingsOrigin } from "./SettingsOrigin";
import { UserMenu } from "./UserMenu";
import styles from "./Sidebar.module.css";

/**
 * 決定 54 (2)(8)(9)・B60。中身は URL の文脈(lib/nav.ts の sidebarContext)で切り替える:
 * ホーム = ロゴ + 「ホーム」/ ワークスペース = ロゴ + 切替 + サイト一覧 / サイト = ロゴ + 切替 + サイトの画面(節の見出しは出さない)/
 * 設定の画面(サイト設定・メンバー・メンバーの API キー・`/w/me/*`)= 設定のメニュー(SettingsSidebar)。
 * どの文脈でも最下部に「設定」(設定系の入口はここ 1 つ)と名前のメニューを置く。
 * 切替の一覧(summary)と設定を開いた場所の記憶は、外枠の SettingsOriginProvider から読む(外枠は app/w/layout.tsx の 1 か所)。
 * caps は外枠が読んだ capabilities のうち「画像」の出し分けに使う 2 つ(B68。lib/nav.ts の siteNav)。外枠はクライアント遷移で描き直されないので
 * 最初の読みの値のまま(R2 とアップローダーの有無は deploy の時にしか変わらず、再読み込みで直る)
 */
export function Sidebar({ user, caps }: { user: SessionUser; caps: Pick<Capabilities, "imageUpload" | "imageUploader"> }) {
  const pathname = usePathname();
  const { remembered, workspaces } = useSettingsOrigin();
  const ctx = sidebarContext(pathname);
  const instanceAdmin = user.instanceAdmin === true;
  const ws = ctx.kind === "workspace" || ctx.kind === "site" ? (workspaces.find((w) => w.id === ctx.wid) ?? null) : null;
  const active = activeSegment(pathname);
  // 最下部の「設定」の行き先 = 今の場所から開いたときの設定のメニューの最初の項目。
  // 設定の外では今の画面の階層(originOfPath。設定の外で null になる画面は無いので、?? は型のための保険)。
  // 設定の中では今のメニューの起点(記憶)にそろえ、押すとそのメニューの先頭へ移る(メニューの形は変わらない)。
  // 開いた場所は provider が pathname の変化から覚えるので、押したときには何も書かない
  // (離脱の確認は capture でクリックを止めるので、onClick に頼ると確認の後の移動で覚えそこねる)
  const entryOrigin: SettingsOrigin = ctx.kind === "settings" ? resolveOrigin(ctx.page, remembered).origin : (originOfPath(pathname) ?? { kind: "home" });
  const entryHref = settingsEntryHref(entryOrigin, { workspaces, instanceAdmin });
  // サイト設定の画面では、行き先は今と同じ画面の一般の節(起点がこのサイトなので、メニューの先頭 = 一般)。
  // 節のリンクと同じく、ルーターを通さず store と URL だけを変える(同じ pathname への push では store が今の節のまま残り、
  // URL は一般なのに表示は別の節、と食い違うため)。行き先が今の画面でないとき(summary にサイトが無く先頭が別の項目)はふつうに移る。
  // 未保存の入力があるときは、フォームの離脱の確認(document の capture)が先に受けて節を切り替えるので、ここまで届かない
  const entryIsSameSettings = ctx.kind === "settings" && ctx.page.kind === "site" && entryHref === pathname;
  const onEntryClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!entryIsSameSettings || !isPlainLeftClick(e)) return;
    e.preventDefault();
    setSettingsSection("general");
  };
  return (
    <nav className={styles.side} aria-label="メインメニュー">
      {ctx.kind === "settings" ? (
        <SettingsSidebar page={ctx.page} instanceAdmin={instanceAdmin} />
      ) : (
        <>
          <AppLink href="/w" className={styles.logo}>
            AB Test and Target Harness
          </AppLink>
          {ws ? <ContextSwitcher workspaces={workspaces} wid={ws.id} sid={ctx.kind === "site" ? ctx.sid : null} /> : null}
          {ctx.kind === "home" ? <NavItem href="/w" icon="home" label="ホーム" current /> : null}
          {ws && ctx.kind === "workspace" ? <NavItem href={`/w/${ws.id}`} icon="grid" label="サイト一覧" current={pathname === `/w/${ws.id}`} /> : null}
          {ws && ctx.kind === "site"
            ? siteNav(caps).map((n) => <NavItem key={n.segment} href={`/w/${ws.id}/sites/${ctx.sid}${n.segment ? `/${n.segment}` : ""}`} icon={n.icon} label={n.label} current={active === n.segment} />)
            : null}
        </>
      )}
      <div className={styles.spacer} />
      <NavItem href={entryHref} icon="gear" label="設定" current={ctx.kind === "settings"} onClick={onEntryClick} />
      {/* caption = ワークスペース・サイトではそこでのロール、ホームと設定ではメール(K19) */}
      <UserMenu user={user} caption={ws ? roleLabel(ws.role) : user.email} />
    </nav>
  );
}
