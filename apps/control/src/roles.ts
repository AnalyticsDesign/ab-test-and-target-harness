import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app";
import type { Db, SiteRow } from "./db";
import type { Role } from "./auth";
import { ApiError, ROLE_JA, forbidden, notFound } from "./errors";
import { isMemberAnywhere } from "./access";
import { isInstanceAdmin } from "./instance-admins";
import type { UsageVisibility } from "./instance-settings";

/**
 * spec §13.2 決定 13 の Role 境界。**認可判定はこのファイルの外に書かない**
 * (API キーの鍵スコープを後から足す場所を 1 箇所に保つため。Task 14 の DoD が `ROLE_RANK` の他所での出現を 0 件に固定する)
 */
export const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };
export const isRole = (v: unknown): v is Role => typeof v === "string" && v in ROLE_RANK;
export const atLeast = (role: Role, min: Role): boolean => ROLE_RANK[role] >= ROLE_RANK[min];

/** spec §13.5 / Plan 10 B1: 公開履歴の失敗理由の生テキスト(例外文字列)は ADMIN 以上にだけ返す。VIEWER / EDITOR には機械可読コードだけ */
export const canReadRawPublishError = (role: Role): boolean => atLeast(role, "admin");

/** spec §12.1 末尾 / §13.1: Role は毎回 D1 の member を照会する。トークン内の情報は使わない */
export async function roleIn(db: Db, workspaceId: string, userId: string): Promise<Role | null> {
  const m = await db
    .selectFrom("member")
    .select("role")
    .where("organizationId", "=", workspaceId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  return m && isRole(m.role) ? m.role : null;
}

/** 低い方の Role(backlog B33: 鍵の上限は付与ではなく上限なので、Member の Role より上には行かない) */
const lower = (a: Role, b: Role): Role => (ROLE_RANK[a] <= ROLE_RANK[b] ? a : b);

/** 鍵の上限に取りうる値。OWNER 相当は「上限なし」= null で表す約束なので、値としては不正 */
const ROLE_CAPS: ReadonlySet<string> = new Set(["viewer", "editor", "admin"]);

/**
 * backlog B33 / 決定 48 (4): apikey 行の metadata(JSON 文字列)から上限を取り出す。**fail-closed**:
 * - 無い(NULL / 空 / JSON の null。Better Auth は metadata 無しの鍵を "null" で保存する)→ null = 上限なし(B33 以前に発行された鍵の後方互換)
 * - オブジェクトで `roleCap` が無い → null(将来 metadata に別のキーを足しても上限なしのまま)
 * - 二重に JSON 化された文字列 → もう 1 段ほどく(Better Auth の一覧処理と同じ解釈。認証側だけ違う解釈だと「一覧では EDITOR、要求では上限なし」になる)
 * - それ以外(配列・真偽値・数値・読めない JSON・知らない値・"owner")→ "viewer"(上限なしに倒さない)
 */
export function roleCapFromMetadata(metadata: string | null | undefined): Role | null {
  if (metadata == null || metadata === "") return null;
  const parsed = parseKeyMetadata(metadata);
  if (parsed === UNREADABLE) return "viewer";
  if (parsed == null) return null; // Better Auth は metadata 無しの鍵を JSON の null("null")で保存する = 上限なし
  if (typeof parsed !== "object" || Array.isArray(parsed)) return "viewer";
  const cap = (parsed as { roleCap?: unknown }).roleCap;
  if (cap == null) return null;
  return typeof cap === "string" && ROLE_CAPS.has(cap) ? (cap as Role) : "viewer";
}

/** 読めない metadata の印(null は「JSON の null」なので別にする) */
export const UNREADABLE = Symbol("unreadable");

/**
 * metadata の JSON を読む。二重に JSON 化された文字列はもう 1 段ほどく(Better Auth の一覧処理と同じ解釈)。
 * 鍵の metadata を読む関数(上限・範囲・有効期限 = api-key-expiry.ts)はすべてこれを通す(読み方が分かれると認証側と一覧で解釈がずれる)
 */
export function parseKeyMetadata(metadata: string): unknown {
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return UNREADABLE;
  }
}

/** 範囲の読めない鍵(範囲を持たない古い鍵・壊れた metadata)を断るときの案内 */
export const KEY_REISSUE_HINT = "この API キーは使えません。管理画面で範囲(すべてのワークスペース / ワークスペース)を選んで発行し直してください";

/** backlog B42: 鍵の範囲。full = すべてのワークスペース(持ち主がいまシステム管理者のときだけ使える)/ workspace = 指定した 1 つだけ */
export type KeyScope = { kind: "full" } | { kind: "workspace"; workspaceId: string };

/**
 * backlog B42(brief K4・K5・K12): apikey 行の metadata から範囲を取り出す。**fail-closed**: `scope` が "full"、または "workspace" で
 * `workspaceId` が空でない文字列のときだけ範囲を返し、それ以外(NULL・B42 より前の鍵・知らない値・読めない JSON)は null = 使えない鍵
 */
export function keyScopeFromMetadata(metadata: string | null | undefined): KeyScope | null {
  if (metadata == null || metadata === "") return null;
  const parsed = parseKeyMetadata(metadata);
  if (parsed === UNREADABLE || parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { scope, workspaceId } = parsed as { scope?: unknown; workspaceId?: unknown };
  if (scope === "full") return { kind: "full" };
  if (scope === "workspace" && typeof workspaceId === "string" && workspaceId !== "") return { kind: "workspace", workspaceId };
  return null;
}

/**
 * backlog B42(brief K6・K14): 鍵の範囲が「いま使える」か。使えなければ 401 の hint を返す(使えるなら null)。
 * `ownerIsInstanceAdmin` は呼び出し側が鍵の行と同じ照会で引いた値(照会を増やさないため)。
 * フルの鍵 = 持ち主がいまシステム管理者 / ワークスペースの鍵 = 持ち主がいまそのワークスペースのメンバー(削除・外された後は使えない)。
 * 発行時ではなく要求のたびに確かめるので、降格・メンバーから外す・ワークスペースの削除がそのまま鍵に効く
 */
export async function keyScopeRefusal(db: Db, userId: string, scope: KeyScope | null, ownerIsInstanceAdmin: boolean): Promise<string | null> {
  if (!scope) return KEY_REISSUE_HINT;
  if (scope.kind === "full") {
    return ownerIsInstanceAdmin ? null : "「すべてのワークスペース」の API キーはシステム管理者だけが使えます。ワークスペースを指定して発行し直してください";
  }
  return (await roleIn(db, scope.workspaceId, userId)) ? null : "この API キーの範囲のワークスペースに参加していません(削除されたか、メンバーから外されました)。必要なら発行し直してください";
}

/**
 * backlog B42(brief K2・K8)/ 決定 48 (2): 鍵を発行してよいか。呼ぶのはセッション(`sessionOnly` の後)。
 * - フル(workspaceId = null)はシステム管理者だけ(403)。上限はその人が持つ最高位の Role 以下
 * - ワークスペースの鍵はそのワークスペースのメンバーだけ(非メンバーは 404)。上限はそのワークスペースでの Role 以下
 * 上限は付与ではないので超える値を通しても権限は増えないが、「この鍵は ADMIN まで」と誤解させないために 400 で断る
 */
export async function assertCanIssueKey(c: Context<AppEnv>, workspaceId: string | null, roleCap: Role | null): Promise<void> {
  const db = c.get("db");
  const userId = c.get("user").id;
  let ceiling: Role | null;
  if (workspaceId === null) {
    if (!(await actsAsInstanceAdmin(c))) throw instanceAdminRequired();
    ceiling = await highestRoleOf(db, userId);
  } else {
    ceiling = await roleIn(db, workspaceId, userId);
    if (!ceiling) throw notFound();
  }
  if (roleCap && (!ceiling || !atLeast(ceiling, roleCap))) {
    const label = ceiling ? ROLE_JA[ceiling] : "なし";
    throw new ApiError(400, "role_cap_too_high", {
      highest: ceiling,
      hint:
        workspaceId === null
          ? `権限に選べるのは、あなたが持つ最高位のロール(${label})と同等かそれ以下です`
          : `権限に選べるのは、このワークスペースでのあなたのロール(${label})と同等かそれ以下です`,
    });
  }
}

/**
 * backlog B42(brief K10): 鍵がこのワークスペースの「メンバーの鍵」に入るか(管理者向けの一覧と失効の対象)。
 * このワークスペースの鍵 + 持ち主がいまシステム管理者であるフルの鍵(全ワークスペースに効くので各管理者に見せる)。
 * 他のワークスペース向けの鍵・範囲の読めない鍵(使えない)は入らない
 */
export function keyBelongsToWorkspace(scope: KeyScope | null, workspaceId: string, ownerIsInstanceAdmin: boolean): boolean {
  if (!scope) return false;
  return scope.kind === "full" ? ownerIsInstanceAdmin : scope.workspaceId === workspaceId;
}

/** backlog B42(brief K7): 要求の範囲がこのワークスペースを含むか(セッションとフルの鍵は常に含む)。`GET /workspaces` の絞り込みにも使う */
export function scopeIncludes(c: Context<AppEnv>, workspaceId: string): boolean {
  const scope = c.get("keyScope");
  return !scope || scope.kind === "full" || scope.workspaceId === workspaceId;
}

/**
 * backlog B33 / 決定 48: 要求が API キー経由で上限(`roleCap`)を持つなら、実効 Role = min(Member の Role, 上限)。
 * Member の Role を毎回 D1 で引く方針(§12.1)はそのままで、上限はその後に被せるだけ。
 * 判定は下の `requireWorkspaceRole` / `loadSite` で行い、`GET /workspaces` のような「自分の Role の表示」も同じ関数で被せる
 * (表示だけ生の Role を返すと、エージェントが自分の権限を読み違える)
 */
export function capRole(c: Context<AppEnv>, role: Role): Role {
  const cap = c.get("roleCap");
  return cap ? lower(role, cap) : role;
}

/** user が持つ Member Role のうち最高位(どの Workspace にも属していなければ null)。鍵の上限は「これと同等かそれ以下」だけ選べる */
export async function highestRoleOf(db: Db, userId: string): Promise<Role | null> {
  const rows = await db.selectFrom("member").select("role").where("userId", "=", userId).execute();
  let best: Role | null = null;
  for (const r of rows) {
    if (isRole(r.role) && (!best || ROLE_RANK[r.role] > ROLE_RANK[best])) best = r.role;
  }
  return best;
}

/**
 * 非メンバー(および存在しない Workspace)は 404、Role 不足は 403 `{ error: "forbidden", required }`。
 * 404 と 403 を分けるのはテナント越しに存在を漏らさないため(Global Constraints)
 */
export async function requireWorkspaceRole(c: Context<AppEnv>, workspaceId: string, min: Role): Promise<Role> {
  if (!scopeIncludes(c, workspaceId)) throw notFound(); // B42: 範囲外は非メンバーと同じ 404
  const member = await roleIn(c.get("db"), workspaceId, c.get("user").id);
  if (!member) throw notFound();
  const role = capRole(c, member);
  if (!atLeast(role, min)) throw forbidden(min);
  return role;
}

/** システム管理者の操作を断るときの封筒(既定の「Role がありません」ではなく、システム管理者の操作だと分かる文にする) */
export const instanceAdminRequired = () =>
  new ApiError(403, "forbidden", {
    required: "instance_admin",
    message: "この操作はシステム管理者だけが行えます",
    hint: "システム管理者に依頼してください(上限付き・ワークスペース指定の API キーでは、システム管理者の操作は行えません)",
  });

/**
 * backlog B36 / 決定 53: システム管理者として扱うか。**上限付きの API キーは扱わない**(K1)— 上限は「Role より上には行かない」約束で、
 * システム管理者の操作(ワークスペースの作成・システム管理者の昇格と降格)は OWNER より強いため、どの上限の下にも入らない
 */
export async function actsAsInstanceAdmin(c: Context<AppEnv>): Promise<boolean> {
  if (c.get("roleCap")) return false;
  // B42: ワークスペースの鍵も扱わない(範囲が 1 つのワークスペースなので、全体に効く操作の下に入らない)
  if (c.get("keyScope")?.kind === "workspace") return false;
  return isInstanceAdmin(c.get("db"), c.get("user").id);
}

/**
 * ワークスペースの作成と、システム管理者の一覧・昇格・降格の入口。`requireSession` と同じくミドルウェアにして、body の検証より**前**に断る。
 * Member から外された人の API キーも、ここで止まる(その人はシステム管理者でもない)
 */
export const requireInstanceAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await actsAsInstanceAdmin(c))) throw instanceAdminRequired();
  await next();
});

/**
 * backlog D10(brief K4・plan K26): 使用状況を読めるか。`members` = どこかのワークスペースのメンバーなら、セッションでも鍵でも読める
 * (セッションは招待を持つだけの人にも出る = access.ts の hasAccess)ので、セッションはどこかのメンバーであることを確かめる。鍵の範囲は requireSession が確かめ済み)。
 * `instance_admins` = 持ち主がいまシステム管理者なら、**鍵の範囲と権限を問わず**読める。actsAsInstanceAdmin が上限付き・
 * ワークスペースの鍵を断るのは「オーナーより強い操作」を上限の下に入れないためで、ワークスペースのデータを含まない読み取りには当てはまらない
 * (監視用のエージェントに「ワークスペース 1 つ・閲覧者」の鍵を渡せるようにする)。この例外は使用状況の読み取りだけ
 */
export async function assertCanReadUsage(c: Context<AppEnv>, visibility: UsageVisibility): Promise<void> {
  const db = c.get("db");
  const userId = c.get("user").id;
  if (visibility === "members") {
    // 鍵は requireSession が範囲を確かめ済み(ワークスペースの鍵 = そのメンバー、すべてのワークスペースの鍵 = システム管理者)。
    // セッションは招待を持つだけの人にも出る(access.ts の hasAccess)ので、どこかのメンバーであることを確かめる
    if (c.get("keyScope") || (await isMemberAnywhere(db, userId))) return;
    throw new ApiError(403, "forbidden", { message: "使用状況はワークスペースのメンバーだけが見られます", hint: "招待を受諾してから開いてください" });
  }
  if (await isInstanceAdmin(db, userId)) return;
  throw new ApiError(403, "forbidden", {
    required: "instance_admin",
    message: "使用状況はシステム管理者だけが見られる設定になっています",
    hint: "システム管理者に、設定 > システム > Cloudflare 使用状況の「見られる人」の変更を依頼してください",
  });
}

/**
 * 決定 53 (9): 対象の user がシステム管理者なら、呼ぶ人もシステム管理者でなければ 403。
 * リセットリンクの発行と、ワークスペースのメンバーの鍵の失効で使う(1 つのワークスペースのオーナーが、
 * 全ワークスペースのオーナーを兼ねる人を乗っ取る・止める経路を塞ぐ)。Role の変更・削除は文の条件で 409 にする(workspaces.ts)
 */
export async function assertCanTouchInstanceAdmin(c: Context<AppEnv>, targetUserId: string): Promise<void> {
  if (!(await isInstanceAdmin(c.get("db"), targetUserId))) return;
  if (await actsAsInstanceAdmin(c)) return;
  throw new ApiError(403, "forbidden", {
    required: "instance_admin",
    message: "システム管理者を対象にした操作は、システム管理者だけが行えます",
    hint: "システム管理者に依頼してください",
  });
}

export type SiteAccess = { site: SiteRow; role: Role };

/**
 * Site 単位のアクセス(spec §13.2)。Site が無い / その Workspace の非メンバー = 404、Role 不足 = 403。
 * Site が属する Workspace の Role を毎回 D1 で引くので、Site 配下のルートはこれ以外の認可判定を持たない
 */
export async function loadSite(c: Context<AppEnv>, siteId: string, min: Role): Promise<SiteAccess> {
  const site = await c.get("db").selectFrom("sites").selectAll().where("id", "=", siteId).executeTakeFirst();
  if (!site) throw notFound();
  if (!scopeIncludes(c, site.workspace_id)) throw notFound(); // B42: 範囲外のワークスペースのサイトも 404
  const member = await roleIn(c.get("db"), site.workspace_id, c.get("user").id);
  if (!member) throw notFound();
  const role = capRole(c, member);
  if (!atLeast(role, min)) throw forbidden(min);
  return { site, role };
}

/**
 * OWNER が絡む Member 操作の追加ゲート(spec §13.2)。ADMIN は
 * - OWNER を対象にできない(Role 変更 / 除名 / パスワード再設定リンクの発行 = 乗っ取り経路)
 * - OWNER を付与できない(自分や仲間を OWNER に昇格させる経路)
 * `targetRoles` には「対象 Member の現在の Role」と、変更するなら「変更後の Role」を渡す。
 * ADMIN 以上であることは呼ぶ前に `requireWorkspaceRole` が確かめている前提
 */
export function assertCanTouchOwner(actor: Role, ...targetRoles: (string | null | undefined)[]): void {
  if (atLeast(actor, "owner")) return;
  if (targetRoles.some((r) => r === "owner")) throw forbidden("owner");
}

/**
 * パスワード再設定リンクの発行は、効果がアカウント全体(メールアドレス単位。全ワークスペースの所属に効く)なのに、
 * 発行者の権限はワークスペース単位でしかない。そのまま許すと「A の ADMIN が、A ではメンバー・B では OWNER の人の
 * パスワードを書き換えて B を乗っ取る」経路になる(Codex Security F2、2026-10-08)。
 * 許す条件 = 発行者がシステム管理者、または対象が属する**他のすべての**ワークスペースで発行者が OWNER。
 * 発行先のワークスペース(`wid`)の条件は `assertCanTouchOwner`(ADMIN は OWNER 宛てを発行できない)が見るのでここでは除く。
 * 自分宛て(自分のパスワードを自分で戻す)は乗っ取りではないので常に許す
 */
export async function assertCanResetMember(c: Context<AppEnv>, wid: string, targetUserId: string): Promise<void> {
  const me = c.get("user").id;
  if (targetUserId === me) return;
  if (await actsAsInstanceAdmin(c)) return;
  const db = c.get("db");
  const memberships = await db.selectFrom("member").select("organizationId").where("userId", "=", targetUserId).execute();
  for (const m of memberships) {
    if (m.organizationId === wid) continue;
    if ((await roleIn(db, m.organizationId, me)) === "owner") continue;
    throw new ApiError(403, "forbidden", {
      required: "owner_of_other_workspaces",
      message: "この人は他のワークスペースにも所属しています。発行できるのは、そのすべてのワークスペースのオーナーか、システム管理者だけです(自分自身への発行はできます)",
      hint: "システム管理者に依頼してください",
    });
  }
}
