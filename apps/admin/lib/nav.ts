import type { IconName } from "@/components/ui/Icon";

/** サイトの中のサイドバー(決定 54 (2)。節の見出しは出さない)。segment は `/w/:wid/sites/:sid/` の後ろ */
export const SITE_NAV: Array<{ segment: string; label: string; icon: IconName }> = [
  { segment: "", label: "エクスペリエンス", icon: "flask" },
  { segment: "goals", label: "目標", icon: "target" },
  { segment: "audiences", label: "オーディエンス", icon: "venn" },
  { segment: "history", label: "公開履歴", icon: "history" },
  { segment: "settings", label: "設定", icon: "gear" },
];

/** 設定(`/w/me/*`)の左ナビ(決定 54 (7))。system はシステム管理者だけに出す */
export const SETTINGS_NAV: Array<{ href: string; label: string; icon: IconName; section: "personal" | "system"; prefetch?: false }> = [
  { href: "/w/me/api-keys", label: "API キー", icon: "key", section: "personal" },
  { href: "/w/me/display", label: "画面表示", icon: "eye", section: "personal" },
  { href: "/w/me/instance-admins", label: "システム管理者", icon: "shield", section: "system" },
  { href: "/w/me/workspaces", label: "ワークスペース", icon: "stack", section: "system" },
  // prefetch を止める: この画面は control の GET /usage(= Cloudflare の使用量の取得)を呼ぶ。先読みすると、測っている使用量そのものを増やしてしまう
  { href: "/w/me/usage", label: "Cloudflare 使用状況", icon: "gauge", section: "system", prefetch: false },
];

const SITE_RE = /^\/w\/[^/]+\/sites\/[^/]+(?:\/([^/]+))?/;

function siteSegment(pathname: string): string | null {
  const m = SITE_RE.exec(pathname);
  return m ? (m[1] ?? "") : null;
}

/** パンくずの末尾に出す画面名(サイトの中だけ)。サイトの外では null */
export function screenName(pathname: string): string | null {
  const seg = siteSegment(pathname);
  if (seg === null) return null;
  if (seg === "" || seg === "experiments") return "エクスペリエンス";
  if (seg === "publish") return "公開";
  return SITE_NAV.find((n) => n.segment === seg)?.label ?? null;
}

/** サイドバーで選択中にする項目の segment。該当なしは null */
export function activeSegment(pathname: string): string | null {
  const seg = siteSegment(pathname);
  if (seg === null) return null;
  if (seg === "" || seg === "experiments") return "";
  return SITE_NAV.some((n) => n.segment === seg) ? seg : null;
}

/** サイドバーの文脈(K5)。サイドバーは layout に居て遷移をまたいで残るので、いまの画面は pathname から決める */
export type SidebarContext = { kind: "home" } | { kind: "settings" } | { kind: "workspace"; wid: string } | { kind: "site"; wid: string; sid: string };

export function sidebarContext(pathname: string): SidebarContext {
  const parts = pathname.split("/").filter(Boolean); // ["w", wid, "sites", sid, ...]
  if (parts[0] !== "w" || parts.length === 1) return { kind: "home" };
  if (parts[1] === "me") return { kind: "settings" }; // ワークスペースの ID はランダムな 32 字なので "me" と重ならない
  if (parts[2] === "sites" && parts[3]) return { kind: "site", wid: parts[1]!, sid: parts[3] };
  return { kind: "workspace", wid: parts[1]! };
}
