import type { ExperimentKind } from "@wtt/core";
import type { PageMatchValue } from "./page-match";
/**
 * control が返す JSON の形(apps/control/src/serialize.ts と各ルートの zod スキーマに一致させる)。
 * 時刻は epoch ミリ秒(Global Constraints)。`previousCookieNames[].until` だけ epoch 秒。
 */

/** `GET /me`。`roleCap` は API キー経由のときだけ値を持つ(管理画面はセッション経由なので常に null。契約を写すために持つ) */
/** `GET /me`。instanceAdmin = システム管理者として扱われるか(B36。上限付きの API キーでは false。古い control の応答では欠ける = false) */
export type SessionUser = { id: string; email: string; name: string; roleCap?: RoleCap; instanceAdmin?: boolean };
export type Role = "owner" | "admin" | "editor" | "viewer";
export type Workspace = { id: string; name: string; role: Role };
/** `GET /workspaces/summary` のサイト(B35)。runningCount = 配信中のエクスペリエンスの数 */
export type SiteSummary = { id: string; name: string; domain: string; runningCount: number };
/** `GET /workspaces/summary`(B35)。memberCount は管理者以上のときだけ数、それ以外は null(K22) */
export type WorkspaceSummary = Workspace & { memberCount: number | null; sites: SiteSummary[] };
/** instanceAdmin = システム管理者(B36)。ワークスペース側からはロールを変えられない・外せない */
export type Member = { memberId: string; userId: string; email: string; name: string; role: Role; instanceAdmin: boolean };
/**
 * `GET /instance-admins`(B36)。createdAt = システム管理者になった時刻(epoch ミリ秒)。
 * priorRoles = 外したときに戻るワークスペースとロール(空 = すべてのワークスペースから外れる。B46)
 */
export type InstanceAdmin = {
  userId: string;
  email: string;
  name: string;
  createdAt: number;
  /** 古い control の応答では欠ける(記録なしとして扱う) */
  priorRoles?: Array<{ workspaceId: string; workspaceName: string; role: string }>;
};
/** B41 (2): システム管理者にできる人(どこかのワークスペースのメンバーで、まだシステム管理者でない人) */
export type InstanceAdminCandidate = { userId: string; email: string; name: string; workspaces: Array<{ id: string; name: string; role: string }> };
/** `GET /invitations/:id`(認証不要)と `GET /workspaces/:wid/invitations` の両方。role は Better Auth 側で null になり得る */
export type Invitation = { id: string; email: string; role: Role | null; status: string; expiresAt: number; url: string };
/** `POST /workspaces/:wid/invitations` の結果。`extended: true` = 同じ Role の招待が既にあり、そのリンクの期限を延ばした(id / url は前と同じ) */
export type InvitationResult = { id: string; url: string; expiresAt: number; extended: boolean };
export type PublicInvitation = { id: string; email: string; role: Role | null; workspaceName: string; status: string; expiresAt: number };
export type AnalyticsSettings = { dataLayerName: string; extraKey: string; exposure: { event: string; keys: Record<string, string> }; conversion: { event: string; keys: Record<string, string> } };
export type Site = {
  id: string; workspaceId: string; name: string; domain: string; mode: "A" | "B"; idSource: string; allowedOrigins: string[]; hosts: string[];
  retentionDays: number; consentMode: "implicit" | "required"; forgetOnRevoke: boolean; timezone: string; decisionTimeoutMs: number; visitorCookieName: string; uuidCookieEnabled: boolean; uuidCookieName: string;
  previousCookieNames: Array<{ name: string; until: number }>; analytics: AnalyticsSettings; ga4PropertyId: string | null; bigqueryDataset: string | null;
  activeVersion: number | null; activeKvStale: boolean; staticStale: boolean; staticRemoving: boolean; lastActivatedAt: number | null; contentUpdatedAt: number; createdAt: number; updatedAt: number;
  /** `GET /sites/:sid` だけが返す(spec §13.9 の badge / banner 用) */
  hasUnpublishedChanges?: boolean;
};
export type Status = "draft" | "running" | "paused" | "archived";
export type ChangeType = "TEXT" | "IMAGE" | "HIDE" | "ATTRIBUTE" | "HTML" | "CSS" | "CUSTOM_JS";
/**
 * `updatedBy` / `updatedAt` は GET が返す実測値。エディタは保存前の Change をこの型のまま組み立てる
 * (type 切り替え・追加時は control が保存時に付け直すので値を持たない)ため任意にする
 */
export type Change = { id: string; type: ChangeType; selector?: string; payload: Record<string, unknown>; updatedBy?: string; updatedAt?: number };
export type Variant = { id: string; name: string; weight: number; analytics: { overrides?: { variantName?: string }; extra?: Record<string, string> } | null; changes: Change[] };
export type Experiment = {
  id: string; siteId: string; name: string; kind: ExperimentKind; status: Status; publishedStatus: Status | null; urlMatch: PageMatchValue; targeting: unknown | null;
  trafficPercentage: number; persistAssignment: boolean; analytics: { overrides?: { experimentName?: string }; extra?: Record<string, string> } | null;
  createdBy: string; updatedBy: string; createdAt: number; updatedAt: number; unpublished: boolean;
  /** `GET /sites/:sid/experiments/:eid` だけが返す */
  variants?: Variant[];
};
export type AnalyticsWarning = { path: string; message: string };
export type PublishResult = { ok: true; version: number; needsProfile: boolean; superseded: boolean; staticDeploy: "deployed" | "pending" | "skipped"; warnings: AnalyticsWarning[] } | { ok: false; version: number | null; error: string; message: string; hint?: string };
export type PublishRow = { version: number; status: "reserved" | "failed" | "active" | "superseded"; createdAt: number; activatedAt: number | null; needsProfile: boolean | null; error: string | null; publishedBy: { id: string; name: string } };
export type PublishPreview = {
  lastActivatedAt: number | null;
  siteLevelChanged: boolean;
  experiments: Array<{ id: string; name: string; status: Status; publishedStatus: Status | null; updatedAt: number; updatedBy: { id: string; name: string }; hasCodeChange: boolean; changedChanges: Array<{ variantId: string; id: string; type: ChangeType; updatedAt: number; updatedBy: { id: string; name: string } }> }>;
  /** 前回の公開より後に更新されたオーディエンスと、それを参照する実行中のエクスペリエンス(次の公開で配信対象が変わる) */
  audienceChanges: Array<{ id: string; name: string; updatedAt: number; experiments: Array<{ id: string; name: string }> }>;
  /** 公開中の設定にあり下書きに無いページの条件(次の公開で数えるのをやめる = これまでの閲覧回数が消える) */
  droppedPageConditions: Array<{ part: "url" | "path" | "host"; op: string; value: string }>;
  /** 画面の幅の条件を使う実行中のエクスペリエンス */
  viewportExperiments: Array<{ id: string; name: string }>;
  /** いまの下書きが Publish で止まる理由(止まらないなら null) */
  compileError: { error: string; message: string; hint?: string } | null;
  /** 同じ対象 URL で同じ要素を変える配信中のエクスペリエンスの組(experimentIds = [優先の低い方, 高い方]) */
  overlaps: Array<{ path: string; message: string; experimentIds: string[] }>;
};
export type Goal = { id: string; name: string; type: "PAGEVIEW" | "CLICK" | "CUSTOM"; config: Record<string, unknown>; createdAt: number; updatedAt: number };
/** backlog D13: 書き込みの凍結の状態。reason = null は「凍結の設定が読めない」(凍結中として扱う) */
export type WriteFreezeState = { reason: string | null; until: string | null; since: number | null };
/** `GET /capabilities`。この導入で使える機能(control の env から決まる) */
export type Capabilities = { imageUpload: boolean; edgeOrigin: string | null; tagOrigin: string | null; edgeOnWorkersDev: boolean; passwordLogin: boolean; writeFreeze: WriteFreezeState | null };
/** `GET /me/api-keys` の各要素。`revokedAt` は失効した時刻(有効な鍵は null。失効から 30 日で一覧から消える) */
/** B42: scope = 鍵の範囲(null = 範囲を持たない古い鍵で使えない)。workspace.name = null はワークスペースが削除済み */
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  roleCap: RoleCap;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  scope: "full" | "workspace" | null;
  workspace: { id: string; name: string | null } | null;
};
/** 鍵の権限の上限(B33)。null = 持ち主の Role と同じ。OWNER 相当は「上限なし」と同じなので選べない */
export type RoleCap = "viewer" | "editor" | "admin" | null;
/** `GET /workspaces/:wid/api-keys`(ADMIN 以上)の各要素 = 自分の一覧の形 + 所有者(この Workspace での Role 付き) */
export type WorkspaceApiKey = ApiKey & { owner: { userId: string; email: string; name: string; role: Role; instanceAdmin: boolean } };

/** `GET /sites/:sid/audiences`(決定 49)。definition = 保存する形の配信条件(正規化した後)。usedBy = 参照しているエクスペリエンス(状態を問わず) */
export type Audience = { id: string; name: string; description: string; definition: unknown; usedBy: Array<{ id: string; name: string; status: Status }>; createdAt: number; updatedAt: number };

/** `GET /usage/settings`(backlog D10)。見られる人・Cloudflare のプラン・Paid の 1 日の目安を画面に出すか */
export type UsageSettings = { usageVisibility: "members" | "instance_admins"; cloudflarePlan: "free" | "paid"; showPaidReference: boolean };
/** `GET /usage/settings` の応答。configured = Cloudflare の API トークンとアカウント ID が設定されているか(読み取り専用) */
export type UsageSettingsView = UsageSettings & { configured: boolean };
export type UsageStatus = "ok" | "warning" | "critical" | "exhausted" | "within_reference" | "over_reference" | "not_judged";
/** `GET /usage` の資源。limit が null = 止まらない資源(Paid の日次・Paid の保存量)で、reference が目安 */
export type UsageResource = {
  id: string; kind: "daily" | "capacity"; unit: "count" | "bytes"; used: number; limit: number | null; ratio: number | null; status: UsageStatus;
  projectedExhaustAt: number | null; reference: { value: number; ratio: number } | null; breakdown: Array<{ name: string; used: number }>;
};
export type UsageReport = { plan: "free" | "paid"; asOf: number; resetAt: number; worst: { id: string; status: UsageStatus; ratio: number } | null; settings: UsageSettings; resources: UsageResource[] };
