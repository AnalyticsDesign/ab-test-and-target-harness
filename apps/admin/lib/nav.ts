import type { IconName } from "@/components/ui/Icon";
import { SECTIONS, type SectionId } from "@/components/settings/sections";
import { canManage } from "./roles";
import type { WorkspaceSummary } from "./types";

/**
 * サイトの中のサイドバー(決定 54 (2)。節の見出しは出さない)。segment は `/w/:wid/sites/:sid/` の後ろ。
 * サイト設定はここに置かない(B60: 設定系はメニューの下の「設定」1 つにまとめ、設定のメニューの「サイト設定」の節から開く)。
 * 公開履歴も置かない(B60: 読むだけの記録で毎日の作業ではないので、上部バーの版の札から開く)
 */
export const SITE_NAV: Array<{ segment: string; label: string; icon: IconName }> = [
  { segment: "", label: "エクスペリエンス", icon: "flask" },
  { segment: "goals", label: "目標", icon: "target" },
  { segment: "audiences", label: "オーディエンス", icon: "venn" },
  // B68: サイトの画像。R2 があればライブラリ、R2 なしでアップローダーがあればその画面(どちらも同じ URL。画面が出し分ける)
  { segment: "images", label: "画像", icon: "image" },
];

/**
 * サイドバーに出すサイトの項目(B68。spec §9.1・K7 = Q295 案 1)。「画像」は imageUpload か imageUploader のどちらかが true のときだけ出す。
 * imageUploader が無い(アップローダーが入る前の control)は false。capabilities の取得の失敗は既定の imageUpload: true で出す(最終の判定は control)。
 * caps は app/w/layout.tsx がすでに読んだものを渡す(control への往復を増やさない)。
 * パンくず(screenName)と選択中の項目(activeSegment)は定数の SITE_NAV のまま(メニューに無くても URL を直接開けば「画像」と出す)
 */
export function siteNav(caps: { imageUpload: boolean; imageUploader?: boolean }): typeof SITE_NAV {
  return SITE_NAV.filter((n) => n.segment !== "images" || caps.imageUpload || caps.imageUploader === true);
}

/** 設定のメニューの「個人」「システム」の節の項目(決定 54 (7))。system はシステム管理者だけに出す。読むのは settingsGroups だけ */
const SETTINGS_NAV: Array<{ href: string; label: string; icon: IconName; section: "personal" | "system"; prefetch?: false }> = [
  { href: "/w/me/api-keys", label: "API キー", icon: "key", section: "personal" },
  { href: "/w/me/display", label: "画面表示", icon: "eye", section: "personal" },
  { href: "/w/me/instance-admins", label: "システム管理者", icon: "shield", section: "system" },
  { href: "/w/me/workspaces", label: "ワークスペース", icon: "stack", section: "system" },
  // prefetch を止める: この画面は control の GET /usage(= Cloudflare の使用量の取得)を呼ぶ。先読みすると、測っている使用量そのものを増やしてしまう
  { href: "/w/me/usage", label: "Cloudflare 使用状況", icon: "gauge", section: "system", prefetch: false },
  // 7o K14: prefetch を止める: この画面は control の GET /static/status(= デプロイ専用の Worker への問い合わせ)を呼ぶ
  { href: "/w/me/static-delivery", label: "配信ファイル", icon: "upload", section: "system", prefetch: false },
  // B129(spec §7.2): 導入全体の操作の記録。読むのは control の D1 だけ(外部の使用量を増やさない)なので先読みは止めない
  { href: "/w/me/audit-events", label: "操作の記録", icon: "history", section: "system" },
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
  // B60 D7: サイト設定の画面の見出し(PageHeader)と同じ名前。メニューのラベル(SITE_NAV の「設定」)には頼らない
  if (seg === "settings") return "サイト設定";
  // B60: 公開履歴はメニューから外したので、画面の見出し(PageHeader)と同じ名前をここで返す
  if (seg === "history") return "公開履歴";
  return SITE_NAV.find((n) => n.segment === seg)?.label ?? null;
}

/** サイドバーで選択中にする項目の segment。該当なしは null */
export function activeSegment(pathname: string): string | null {
  const seg = siteSegment(pathname);
  if (seg === null) return null;
  if (seg === "" || seg === "experiments") return "";
  return SITE_NAV.some((n) => n.segment === seg) ? seg : null;
}

// ---------------------------------------------------------------------------
// 設定のメニュー(B60)。サイト設定・ワークスペース・個人・システムを 1 つのメニューに並べる。
//
// 記憶と「縮んだ形」: メンバー・個人の画面の URL(`/w/:wid/members`・`/w/me/*`)にはサイトが入っていない。
// URL だけでメニューを作ると、サイトから設定を開いてメンバーの画面へ移った瞬間に「サイト設定」の節が消えてメニューが跳ねる。
// そこで設定に入るときに「どこから来たか」(origin)と戻り先(backHref)を覚え、設定の中の移動では覚えた値を使う。
// 覚えた値がない(直接 URL を開いた・再読み込み)ときや今の画面と合わないときは、URL から決まる縮んだ形(originFromPage)に戻す。
// ---------------------------------------------------------------------------

/** 設定の画面(メニューが設定の形になる画面)。それ以外の画面は null */
export type SettingsPage =
  | { kind: "site"; wid: string; sid: string }
  | { kind: "members"; wid: string }
  | { kind: "member-api-keys"; wid: string }
  /** B129: ワークスペースの操作の記録(管理者以上) */
  | { kind: "audit-events"; wid: string }
  | { kind: "me"; path: string };

/** pathname(search・hash は無視)を区切り。末尾のスラッシュは無視する */
function partsOf(path: string): string[] {
  return path.split(/[?#]/, 1)[0]!.split("/").filter(Boolean);
}

export function settingsPageOf(pathname: string): SettingsPage | null {
  const parts = partsOf(pathname); // ["w", wid, ...]
  if (parts[0] !== "w" || parts.length < 3) return null;
  const wid = parts[1]!;
  if (wid === "me") return { kind: "me", path: pathname }; // ワークスペースの ID はランダムな 32 字なので "me" と重ならない
  if (parts.length === 3 && parts[2] === "members") return { kind: "members", wid };
  if (parts.length === 3 && parts[2] === "api-keys") return { kind: "member-api-keys", wid };
  if (parts.length === 3 && parts[2] === "audit-events") return { kind: "audit-events", wid };
  if (parts.length === 5 && parts[2] === "sites" && parts[4] === "settings") return { kind: "site", wid, sid: parts[3]! };
  return null;
}

/** 設定を開いた場所(メニューの階層の起点)。site > workspace > home の順に上の階層が続く */
export type SettingsOrigin = { kind: "home" } | { kind: "workspace"; wid: string } | { kind: "site"; wid: string; sid: string };
/** 覚えた場所と、「戻る」で行く先(開く直前の画面の pathname + search) */
export type RememberedOrigin = { origin: SettingsOrigin; backHref: string };

/** 画面の pathname から決まる縮んだ形の origin(上の記憶が使えないときの代わり) */
export function originFromPage(page: SettingsPage): SettingsOrigin {
  if (page.kind === "site") return { kind: "site", wid: page.wid, sid: page.sid };
  if (page.kind === "me") return { kind: "home" };
  return { kind: "workspace", wid: page.wid };
}

export function backHrefOf(origin: SettingsOrigin): string {
  if (origin.kind === "home") return "/w";
  if (origin.kind === "workspace") return `/w/${origin.wid}`;
  return `/w/${origin.wid}/sites/${origin.sid}`;
}

/**
 * 設定の外の画面の pathname(search は無視)から、そこが属する階層を返す。
 * `/w` 系 = home、`/w/:wid`(サイトの外)= workspace、`/w/:wid/sites/:sid/...` = site。
 * `/w/me/*` は設定の画面そのものなので null(呼び出し側は縮んだ形に戻す)
 */
export function originOfPath(path: string): SettingsOrigin | null {
  const parts = partsOf(path);
  if (parts[0] !== "w" || parts.length === 1) return { kind: "home" };
  if (parts[1] === "me") return null;
  if (parts[2] === "sites" && parts[3]) return { kind: "site", wid: parts[1]!, sid: parts[3] };
  return { kind: "workspace", wid: parts[1]! };
}

/**
 * サイドバーの文脈(K5)。サイドバーは layout に居て遷移をまたいで残るので、いまの画面は pathname から決める。
 * 設定の画面(settingsPageOf が null でない = サイト設定・メンバー・メンバーの API キー・操作の記録・`/w/me/*`)は設定のメニュー、
 * それ以外は originOfPath と同じ区切り(home / workspace / site)。区切りの読み方を 1 か所にするため originOfPath をそのまま使う
 */
export type SidebarContext = SettingsOrigin | { kind: "settings"; page: SettingsPage };

export function sidebarContext(pathname: string): SidebarContext {
  const page = settingsPageOf(pathname);
  if (page) return { kind: "settings", page };
  // originOfPath が null になるのは `/w/me` そのもの(画面は無い)だけ。ホームの形で描く
  return originOfPath(pathname) ?? { kind: "home" };
}

const shrunk = (page: SettingsPage): RememberedOrigin => {
  const origin = originFromPage(page);
  return { origin, backHref: backHrefOf(origin) };
};

/**
 * 覚えた origin が、この設定の画面で使えるか。
 * - site の画面: 同じサイトのときだけ(別のサイトの設定を開いたら、そのサイトが起点)
 * - members / member-api-keys / audit-events: 同じワークスペースの workspace、または同じワークスペースの site
 * - me: どの origin でも(個人・システムの画面はどこからでも開ける)
 */
function fitsPage(page: SettingsPage, o: SettingsOrigin): boolean {
  switch (page.kind) {
    case "site":
      return o.kind === "site" && o.wid === page.wid && o.sid === page.sid;
    case "members":
    case "member-api-keys":
    case "audit-events":
      return (o.kind === "site" || o.kind === "workspace") && o.wid === page.wid;
    case "me":
      return true;
  }
}

/** いまの設定の画面で使う origin。覚えた値が今の画面と合えば使い(`fitsPage`)、合わなければ縮んだ形 */
export function resolveOrigin(page: SettingsPage, remembered: RememberedOrigin | null): RememberedOrigin {
  return remembered && fitsPage(page, remembered.origin) ? remembered : shrunk(page);
}

/**
 * 画面が移るたびに provider が呼ぶ。fromPath = 直前の画面(最初の描画では null)、どちらも pathname + search。
 * 記憶は「描画に使われる origin」と常に一致させる: 覚えた値が今の画面と合わないまま残ると、あとで別の設定の画面へ移ったときに
 * 古い値が復活してメニューが跳ねる(例: ホームからメンバーへ入って個人へ移ると、ワークスペースの節が消える)。
 * (a) 設定の外へ出たら消す。
 * (b) 設定の外から設定へ入ったら、直前の画面から決めた origin を覚える。行き先の画面と合わないときは行き先から決まる縮んだ形にする。
 *     backHref はどちらでも直前の画面(「戻る」は設定を開く前の画面へ戻る)
 * (c) 設定の中の移動は `resolveOrigin` で整える(合っていれば prev をそのまま保ち、合わなければ縮んだ形。
 *     別のサイトの設定へ移るときは、ワークスペースから開いていたときも含めてそのサイトに切り替わる)
 */
export function nextRemembered(prev: RememberedOrigin | null, fromPath: string | null, toPath: string): RememberedOrigin | null {
  const to = settingsPageOf(toPath);
  if (!to) return null; // (a)
  const fromInSettings = fromPath !== null && settingsPageOf(fromPath) !== null;
  if (!fromInSettings) {
    // (b) fromPath が null(最初の描画)なら、toPath から決まる縮んだ形
    const origin = fromPath === null ? null : originOfPath(fromPath);
    if (!origin) return shrunk(to);
    return { origin: fitsPage(to, origin) ? origin : originFromPage(to), backHref: fromPath! };
  }
  // (c) 覚えた値がなければ縮んだ形を覚える(resolveOrigin が prev = null のときに返す形)。描画が使う形と記憶を常に一致させる
  return resolveOrigin(to, prev);
}

/**
 * 設定のメニューの切り替えの枠でサイトを選んだときの行き先(ユーザーの決定 5)。
 * - サイト設定の画面: 移り先のサイトのサイト設定の同じ節(一般は `?section` を付けない。settingsGroups の項目と同じ形)
 * - ほかの設定の画面(メンバー・メンバーの API キー・個人・システム): 移り先のサイトのサイト設定の一般。
 *   今の画面のまま移せる先が無いため(メンバー・API キーはサイトに属さない)、選んだサイトの設定の入口へ
 * 開いた場所の記憶は書かない: URL にサイトが入るので、provider が nextRemembered の (c) でそのサイトに切り替える
 */
export function switchSettingsHref(page: SettingsPage, section: SectionId, target: { wid: string; sid: string }): string {
  const base = `/w/${target.wid}/sites/${target.sid}/settings`;
  return page.kind === "site" && section !== "general" ? `${base}?section=${section}` : base;
}

/** 「戻る」の行の右に出す名前。名前は戻り先(backHref)が指す場所に合わせる(origin と戻り先が違うことがあるため) */
export function backLabel(remembered: RememberedOrigin, workspaces: WorkspaceSummary[]): string {
  return originLabel(originOfPath(remembered.backHref) ?? remembered.origin, workspaces);
}

export type SettingsItem = { key: string; href: string; label: string; icon: IconName; prefetch?: false; section?: SectionId };
export type SettingsGroup = {
  scope: "site" | "workspace" | "personal" | "system";
  heading: "サイト設定" | "ワークスペース" | "個人" | "システム";
  /** 見出しの下に出す名前(サイト名・ワークスペース名)。個人・システムは null */
  name: string | null;
  items: SettingsItem[];
};

type GroupCtx = { workspaces: WorkspaceSummary[]; instanceAdmin: boolean };

/**
 * 設定のメニューの節。開いた階層の節が先頭で、上の階層が続く(site → workspace → personal → system)。
 * - workspace: 管理者以上だけ(メンバー・メンバーの API キー・操作の記録は管理者以上の機能)。満たさなければ節ごと出さない
 * - site の「危険な操作」: そのワークスペースのオーナーだけ
 * - system: システム管理者だけ
 * - summary に無いサイト・ワークスペース(権限が無い・消えた)の節は出さない
 */
export function settingsGroups(origin: SettingsOrigin, ctx: GroupCtx): SettingsGroup[] {
  const groups: SettingsGroup[] = [];
  const ws = origin.kind === "home" ? undefined : ctx.workspaces.find((w) => w.id === origin.wid);

  if (origin.kind === "site" && ws) {
    const site = ws.sites.find((s) => s.id === origin.sid);
    if (site) {
      const base = `/w/${ws.id}/sites/${site.id}/settings`;
      groups.push({
        scope: "site",
        heading: "サイト設定",
        name: site.name,
        items: SECTIONS.filter((s) => s.id !== "danger" || ws.role === "owner").map((s) => ({
          key: `site-${s.id}`,
          href: s.id === "general" ? base : `${base}?section=${s.id}`,
          label: s.label,
          icon: s.id === "danger" ? ("dot" as const) : ("gear" as const),
          section: s.id,
        })),
      });
    }
  }

  if (origin.kind !== "home" && ws && canManage(ws.role)) {
    groups.push({
      scope: "workspace",
      heading: "ワークスペース",
      name: ws.name,
      items: [
        { key: "members", href: `/w/${ws.id}/members`, label: "メンバー", icon: "users" },
        { key: "member-api-keys", href: `/w/${ws.id}/api-keys`, label: "メンバーの API キー", icon: "key" },
        // B129(spec §7.2): このワークスペースの操作の記録(管理者以上。節ごと管理者以上なのでここに置くだけでよい)
        { key: "audit-events", href: `/w/${ws.id}/audit-events`, label: "操作の記録", icon: "history" },
      ],
    });
  }

  const fromNav = (section: "personal" | "system"): SettingsItem[] =>
    SETTINGS_NAV.filter((n) => n.section === section).map((n) => ({
      key: n.href,
      href: n.href,
      label: n.label,
      icon: n.icon,
      ...(n.prefetch === false ? { prefetch: false as const } : {}),
    }));
  groups.push({ scope: "personal", heading: "個人", name: null, items: fromNav("personal") });
  if (ctx.instanceAdmin) groups.push({ scope: "system", heading: "システム", name: null, items: fromNav("system") });

  return groups;
}

/** 左メニューの「設定」から入るときの行き先 = 最初の空でない節の最初の項目(個人は必ずあるので常に決まる) */
export function settingsEntryHref(origin: SettingsOrigin, ctx: GroupCtx): string {
  // `?? "/w/me/api-keys"`(個人の節の先頭)は型のための保険(個人の節が必ずあるので通らない)
  return settingsGroups(origin, ctx).find((g) => g.items.length > 0)?.items[0]?.href ?? "/w/me/api-keys";
}

/** 「戻る」の行の右に出す名前。サイト名 / ワークスペース名 /「ホーム」(summary に無いときは汎用の語) */
export function originLabel(origin: SettingsOrigin, workspaces: WorkspaceSummary[]): string {
  if (origin.kind === "home") return "ホーム";
  const ws = workspaces.find((w) => w.id === origin.wid);
  if (origin.kind === "workspace") return ws?.name ?? "ワークスペース";
  return ws?.sites.find((s) => s.id === origin.sid)?.name ?? "サイト";
}
