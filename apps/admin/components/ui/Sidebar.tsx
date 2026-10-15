"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SessionUser, WorkspaceSummary } from "@/lib/types";
import { SETTINGS_NAV, SITE_NAV, activeSegment, sidebarContext } from "@/lib/nav";
import { canManage, roleLabel } from "@/lib/roles";
import { ContextSwitcher } from "./ContextSwitcher";
import { Icon, type IconName } from "./Icon";
import { UserMenu } from "./UserMenu";
import styles from "./Sidebar.module.css";

function Item({ href, icon, label, current, prefetch }: { href: string; icon: IconName; label: string; current: boolean; prefetch?: false }) {
  return (
    // prefetch は false のときだけ渡す(未指定 = フレームワークの既定のまま)
    <Link href={href} prefetch={prefetch} className={styles.item} aria-current={current ? "page" : undefined}>
      <Icon name={icon} />
      {label}
    </Link>
  );
}

/**
 * 決定 54 (2)(6)(8)(9)。中身は URL の文脈(lib/nav.ts の sidebarContext)で切り替える:
 * ホーム = ロゴ + 「ホーム」/ ワークスペース = 切替 + サイト一覧・メンバー・メンバーの API キー(後ろ 2 つは管理者以上)/
 * サイト = 切替 + サイトの画面(節の見出しは出さない)/ 設定 = 「ホームに戻る」+ 個人・システムの節(決定 54 (7))
 */
export function Sidebar({ user, workspaces }: { user: SessionUser; workspaces: WorkspaceSummary[] }) {
  const pathname = usePathname();
  const ctx = sidebarContext(pathname);
  const ws = ctx.kind === "workspace" || ctx.kind === "site" ? (workspaces.find((w) => w.id === ctx.wid) ?? null) : null;
  const active = activeSegment(pathname);
  if (ctx.kind === "settings") {
    // 設定(決定 54 (7)): 先頭に「ホームに戻る」、見出し「設定」、節「個人」と「システム」(システム管理者だけ)
    const items = (section: "personal" | "system") =>
      SETTINGS_NAV.filter((n) => n.section === section).map((n) => <Item key={n.href} href={n.href} icon={n.icon} label={n.label} current={pathname === n.href} prefetch={n.prefetch} />);
    return (
      <nav className={styles.side} aria-label="メインメニュー">
        <Link href="/w" className={styles.back}>
          <Icon name="left" size={14} />
          ホームに戻る
        </Link>
        <div className={styles.sideTitle}>設定</div>
        <div className={styles.section}>個人</div>
        {items("personal")}
        {user.instanceAdmin ? (
          <>
            <div className={styles.section}>システム</div>
            {items("system")}
          </>
        ) : null}
        <div className={styles.spacer} />
        <UserMenu user={user} caption={user.email} />
      </nav>
    );
  }
  return (
    <nav className={styles.side} aria-label="メインメニュー">
      <Link href="/w" className={styles.logo}>
        Web Test and Target Harness
      </Link>
      {ws ? <ContextSwitcher workspaces={workspaces} wid={ws.id} sid={ctx.kind === "site" ? ctx.sid : null} /> : null}
      {ctx.kind === "home" ? <Item href="/w" icon="home" label="ホーム" current /> : null}
      {ws && ctx.kind === "workspace" ? (
        <>
          <Item href={`/w/${ws.id}`} icon="grid" label="サイト一覧" current={pathname === `/w/${ws.id}`} />
          {canManage(ws.role) ? (
            <>
              <Item href={`/w/${ws.id}/members`} icon="users" label="メンバー" current={pathname === `/w/${ws.id}/members`} />
              <Item href={`/w/${ws.id}/api-keys`} icon="key" label="メンバーの API キー" current={pathname === `/w/${ws.id}/api-keys`} />
            </>
          ) : null}
        </>
      ) : null}
      {ws && ctx.kind === "site"
        ? SITE_NAV.map((n) => <Item key={n.segment} href={`/w/${ws.id}/sites/${ctx.sid}${n.segment ? `/${n.segment}` : ""}`} icon={n.icon} label={n.label} current={active === n.segment} />)
        : null}
      <div className={styles.spacer} />
      <UserMenu user={user} caption={ws ? roleLabel(ws.role) : user.email} />
    </nav>
  );
}
