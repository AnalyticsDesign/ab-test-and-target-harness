import type { AnalyticsSettings, ExperimentKind } from "@wtt/core";
import type { UrlMatchValue } from "./url-match";
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
/**
 * `GET /invitations/:id`(認証不要)と `GET /workspaces/:wid/invitations` の両方。role は Better Auth 側で null になり得る。
 * control の契約では一覧の id / url は nullable(API キーで読んだときは null。backlog B156)だが、この画面は BFF のセッションで読むので
 * 常に文字列が返る。そのため型は string のまま置く
 */
export type Invitation = { id: string; email: string; role: Role | null; status: string; expiresAt: number; url: string };
/** `POST /workspaces/:wid/invitations` の結果。`extended: true` = 同じ Role の招待が既にあり、そのリンクの期限を延ばした(id / url は前と同じ) */
export type InvitationResult = { id: string; url: string; expiresAt: number; extended: boolean };
export type PublicInvitation = { id: string; email: string; role: Role | null; workspaceName: string; status: string; expiresAt: number };
/** サイトの外部計測の名札。control は既定値で埋めた全項目を返すので core の型をそのまま使う(B77: 出力プレビューがキー名を引くため) */
export type { AnalyticsSettings };
/** B148: タグを置くドメインの一覧の 1 行。edge = Cloudflare 経由 / outside = Cloudflare 外 / unknown = まだ確かめていない / dev = 開発用。時刻は epoch 秒 */
export type DomainRow = { value: string; verdict: "edge" | "outside" | "unknown" | "dev"; checkedAt: number | null; triedAt: number | null };
/**
 * B148: 保存(PATCH)・作成の応答の判定の結果。判定しなかった保存は null。
 * changes = 判定が変わった行 / deferred = 時間か上限で確かめなかった行(次の保存で確かめる)/ unknown = 確かめられなかった行(前回の判定を保つ)
 */
export type DomainChecks = { changes: Array<{ domain: string; from: DomainRow["verdict"]; to: DomainRow["verdict"] }>; deferred: string[]; unknown: string[] } | null;
/** `PATCH /sites/:sid` の応答 */
export type SiteSaved = Site & { domainChecks: DomainChecks };
export type Site = {
  id: string; workspaceId: string; name: string; mode: "A" | "B"; idSource: string;
  /**
   * B148: タグを置くドメインの一覧(control の書き込みは domains だけ)。domain(代表)・allowedOrigins は一覧から導いた読むだけの値。
   * edgeDomains・outsideDomains・uncheckedDomains は判定の結果のまとまり(Mode A は 3 つとも空)
   */
  domains: DomainRow[]; domain: string; allowedOrigins: string[]; edgeDomains: string[]; outsideDomains: string[]; uncheckedDomains: string[];
  retentionDays: number; consentMode: "implicit" | "required"; forgetOnRevoke: boolean; resultsEnabled: boolean; resultsRetentionDays: number; newProfileBudgetPerDay: number | null; timezone: string; decisionTimeoutMs: number; visitorCookieName: string; uuidCookieEnabled: boolean; uuidCookieName: string;
  previousCookieNames: Array<{ name: string; until: number }>;
  /** B139: 訪問者 ID の Cookie の共有と、control がタグを置くドメインの一覧から導いたまとまり(読むだけ。共有がオフなら空) */
  shareSubdomains: boolean; cookieGroups: Array<{ domain: string; hosts: string[] }>;
  analytics: AnalyticsSettings; ga4PropertyId: string | null; bigqueryDataset: string | null;
  activeVersion: number | null; activeKvStale: boolean; activeKvStaleReason?: "pending" | "config_missing" | null; staticStale: boolean; staticRemoving: boolean; lastActivatedAt: number | null; contentUpdatedAt: number; createdAt: number; updatedAt: number;
  /** `GET /sites/:sid` だけが返す(spec §13.9 の badge / banner 用) */
  hasUnpublishedChanges?: boolean;
  /** `GET /sites/:sid` だけが返す: 設置タグの配信ファイルの記録が食い違っている(7o K6。立つのは staticStale のときだけ) */
  staticMismatch?: boolean;
  /** `GET /sites/:sid` だけが返す: 計測用のデータベースの使用量(D9 ③。測る前・計測用のデータベースが無い導入では無い) */
  resultsCapacity?: ResultsCapacity | null;
};
/**
 * `POST /workspaces/:wid/sites` の応答。B139: 同じ登録ドメインの別のサイトと訪問者 ID の Cookie がぶつかるため、
 * 共有をオフにするか(shareSubdomains = false)、Cookie 名を変えて(共有はオンのまま)作ったときだけ sharingAdjusted が付く
 */
export type SiteCreated = Site & { domainChecks?: DomainChecks; sharingAdjusted?: { reason: "conflict"; shareSubdomains: boolean; visitorCookieName: string } };
export type Status = "draft" | "running" | "paused" | "archived";
export type ChangeType = "TEXT" | "IMAGE" | "HIDE" | "ATTRIBUTE" | "HTML" | "CSS" | "CUSTOM_JS";
/**
 * `updatedBy` / `updatedAt` は GET が返す実測値。エディタは保存前の Change をこの型のまま組み立てる
 * (type 切り替え・追加時は control が保存時に付け直すので値を持たない)ため任意にする
 */
export type Change = { id: string; type: ChangeType; selector?: string; payload: Record<string, unknown>; updatedBy?: string; updatedAt?: number };
/** B77: original = 元のページのまま表示するパターン(変更を持てない)、description = メモ(社内用。config には出ない) */
export type Variant = { id: string; name: string; weight: number; original: boolean; description: string; analytics: { overrides?: { variantName?: string }; extra?: Record<string, string> } | null; changes: Change[] };
export type Experiment = {
  id: string; siteId: string; name: string; kind: ExperimentKind; status: Status; publishedStatus: Status | null; urlMatch: UrlMatchValue; targeting: unknown | null;
  trafficPercentage: number; persistAssignment: boolean; analytics: { overrides?: { experimentName?: string }; extra?: Record<string, string> } | null;
  createdBy: string; updatedBy: string; createdAt: number; updatedAt: number; unpublished: boolean;
  /** メモ(社内用。config には出ない。B77) */
  description: string;
  /** 結果の記録の ID(結果を記録する Site でテストを開始したときに 1 回だけ振る。無ければ null) */
  runId: string | null;
  /** `GET /sites/:sid/experiments/:eid` だけが返す */
  variants?: Variant[];
  /** `GET /sites/:sid/experiments`(一覧)だけが返す: 採用の要約(D9 ③。記録していなければ null) */
  adoption?: ListAdoption | null;
};
/**
 * 一覧の採用の要約(D9 ③)。summary は正の判定の記録(評価時点の記録、評価時点の前に終了したときは終了の記録)から取った値。
 * 基準を採用したときは summary の値がすべて null(重み 0 のパターンでも null になるので、基準かは baseline で見る)。採用なし・記録が無いときは summary = null
 */
export type ListAdoption = {
  variantId: string | null;
  /** 採用したパターンの今の名前(無くなっていれば記録に写した名前)。採用なし・分からなければ null */
  variantName: string | null;
  /** 基準のパターンを採用したか(正の判定の記録の基準と同じ。記録が無ければ false) */
  baseline: boolean;
  decidedAt: number;
  summary: { diffPoints: number | null; relative: number | null; probBeat: number | null; verdict: "blocked_quality" | "adopt" | "worse" | "equivalent" | "insufficient" | null } | null;
};
/** 計測用のデータベースの使用量(D9 ③。`GET /sites/:sid` が返す。まだ測っていない導入では無い) */
export type ResultsCapacity = { sizeBytes: number; measuredAt: number; level: "ok" | "warning" | "stopped" };
export type AnalyticsWarning = { path: string; message: string };
/** 成功の warnings は計測の警告と、配信への反映待ち(path = delivery)を含む。 */
export type PublishResult = { ok: true; version: number; needsProfile: boolean; superseded: boolean; staticDeploy: "deployed" | "pending" | "skipped"; warnings?: AnalyticsWarning[] } | { ok: false; version: number | null; error: string; message: string; hint?: string; /** B68: asset_missing / asset_other_site のときの画像と、それを含む変更 */ assetProblems?: AssetProblem[] };
/** `POST …/experiments/:eid/status` の応答。warnings = 遷移は成功したが知らせたいこと(結果を記録しない開始・容量の見込み。D9 ②③) */
export type StatusResult = {
  experiment: Experiment;
  publish: PublishResult;
  warnings?: AnalyticsWarning[];
  /** テストを終了したときだけ: 結果の記録と採用の記録ができたか(false = 結果は自動で記録し直し、採用は記録し直しが要る。D9 ③) */
  results?: { recorded: boolean };
};
export type PublishRow = { version: number; status: "reserved" | "failed" | "active" | "superseded"; createdAt: number; activatedAt: number | null; needsProfile: boolean | null; error: string | null; publishedBy: { id: string; name: string } };
export type PublishPreview = {
  digest?: string | null;
  transitionDigest?: string | null;
  lastActivatedAt: number | null;
  siteLevelChanged: boolean;
  experiments: Array<{ id: string; name: string; status: Status; publishedStatus: Status | null; updatedAt: number; updatedBy: { id: string; name: string }; hasCodeChange: boolean; hasExternalUrl?: boolean; detectedBy?: "time" | "config"; changedChanges: Array<{ variantId: string; id: string; type: ChangeType; reviewMark?: "code" | "external_url" | null; updatedAt: number; updatedBy: { id: string; name: string } }> }>;
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
  /** B68: いまの下書きを公開すると画像の確かめで止まる参照(古い control の応答では欠ける = 無し) */
  assetProblems?: AssetProblem[];
};
/** B68: 公開できない画像(missing = このサイトの画像の一覧に無い・消すと決まった画像 / other_site = 別のサイトの画像)と、それを含む変更 */
export type AssetProblem = { url: string; reason: "missing" | "other_site"; experimentId: string; variantId: string; changeId: string };
/** analytics = 目標の外部計測(B77。goalName を指定しなければ ab_goal_name は目標 ID。無ければ null) */
/**
 * runningTests = この目標を配信条件(使っているオーディエンスを含む)か評価計画(判定に使う目標)で参照している、実行中・一時停止中のテスト
 * (D9 ③。保存の確認に件数を添える。古い control の応答では欠ける = 0 件)
 */
export type Goal = {
  id: string; name: string; type: "PAGEVIEW" | "CLICK" | "CUSTOM"; config: Record<string, unknown>; analytics: { overrides?: { goalName?: string } } | null;
  runningTests?: Array<{ id: string; name: string }>;
  createdAt: number; updatedAt: number;
};
/** backlog D13: 書き込みの凍結の状態。reason = null は「凍結の設定が読めない」(凍結中として扱う) */
export type WriteFreezeState = { reason: string | null; until: string | null; since: number | null };
/** `GET /capabilities`。この導入で使える機能(control の env から決まる) */
export type Capabilities = { productVersion: string | null; imageUpload: boolean; edgeOrigin: string | null; tagOrigin: string | null; edgeOnWorkersDev: boolean; passwordLogin: boolean; resultsStore: boolean; writeFreeze: WriteFreezeState | null; apiVersion: number | null; minClientVersion: number | null;
  /** B68: R2 なしの画像アップローダーがあるか。アップローダーが入る前の control は返さない(undefined = false として扱う) */
  imageUploader?: boolean;
};
/** B68: `GET /sites/:sid/assets` の usage。count・bytes は削除待ちを含み、pendingCount・pendingBytes がその内数 */
export type AssetUsage = { count: number; bytes: number; pendingCount: number; pendingBytes: number; maxCount: number; maxBytes: number; maxFileBytes: number };
/** B68: サイトの画像の 1 件(一覧・アップロード・名前の変更の応答の共通の形) */
export type SiteAsset = {
  id: string;
  name: string;
  publicUrl: string;
  /** 縮小版(幅 320px の WebP)。まだ無ければ null */
  thumbnailUrl: string | null;
  thumbnail: "pending" | "ready" | "failed" | "skipped";
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  createdBy: { id: string; name: string | null };
  /** 下書きの IMAGE・ATTRIBUTE の src で使っているパターン */
  usedBy: Array<{ experimentId: string; variantId: string }>;
  /** 公開したときの内容で使っているエクスペリエンスの ID */
  deliveredIn: string[];
  inUse: boolean;
  /** 削除待ちから自動で戻された時刻(7 日の間は札を出す) */
  keptAt: number | null;
};
/** B68: 画面の中の画像の一覧(`GET /sites/:sid/assets` の応答を `expandAssetList` で各件の URL に戻したもの)。experiments は usedBy・deliveredIn に出るエクスペリエンスの名前・状態・パターン名 */
export type AssetList = { assets: SiteAsset[]; experiments: Record<string, { name: string; status: string; variants: Record<string, string> }>; usage: AssetUsage };
/**
 * B68: `GET /sites/:sid/assets` の応答そのもの。各件は URL を持たず、上の段の urlPrefix と各件の path で表す
 * (公開ベースを変える前の画像は publicUrl、縮小版の URL が決まった形でない件は thumbnailUrl が入る)。画面では `expandAssetList` で `AssetList` に戻して使う
 */
export type AssetListItemResponse = Omit<SiteAsset, "publicUrl" | "thumbnailUrl" | "createdBy"> & {
  path?: string; publicUrl?: string; thumbnailUrl?: string | null;
  /** 作った人。上の段の creators の添字(ID と名前はそこで引く) */
  creator: number;
};
export type AssetListResponse = Omit<AssetList, "assets"> & {
  urlPrefix: string | null;
  assets: AssetListItemResponse[];
  /** 一覧に出る画像を作った人(一覧に最初に出た順。各件の creator が添字) */
  creators: Array<{ id: string; name: string | null }>;
};
/** B68: `POST /sites/:sid/assets` の 201。renamedFrom は名前が重なって番号を付けたときだけ */
export type UploadedAsset = SiteAsset & { renamedFrom?: string; usage: AssetUsage };
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
/**
 * `GET /usage/settings` の応答。configured = Cloudflare の API トークンとアカウント ID が設定されているか(読み取り専用)。
 * controlCapacity(B129)= 制御用のデータベースの大きさ(GET /usage と同じ値。GET /usage が 503 でも読める)。古い control は欄を返さない(undefined)
 */
export type UsageSettingsView = UsageSettings & { configured: boolean; controlCapacity?: ControlCapacity | null };
export type UsageStatus = "ok" | "warning" | "critical" | "exhausted" | "within_reference" | "over_reference" | "not_judged";
/** `GET /usage` の資源。limit が null = 止まらない資源(Paid の日次・Paid の保存量)で、reference が目安 */
export type UsageResource = {
  id: string; kind: "daily" | "capacity"; unit: "count" | "bytes"; used: number; limit: number | null; ratio: number | null; status: UsageStatus;
  projectedExhaustAt: number | null; reference: { value: number; ratio: number } | null; breakdown: Array<{ name: string; used: number }>;
};
/**
 * B129(Q10・Q24): 制御用のデータベース(wtt-control)の大きさ。保持の Cron が 1 日 1 回測る。段階は結果のデータベースと同じ閾値(80% / 95%)。
 * 制御用のデータベースは記録を止めないので、critical は「上限に近い(達すると書き込みが失敗する)」の意味
 */
export type ControlCapacity = { sizeBytes: number; measuredAt: number; level: "ok" | "warning" | "critical" };
/** controlCapacity: まだ測っていなければ null。古い control は欄を返さない(undefined) */
export type UsageReport = { plan: "free" | "paid"; asOf: number; resetAt: number; worst: { id: string; status: UsageStatus; ratio: number } | null; settings: UsageSettings; resources: UsageResource[]; controlCapacity?: ControlCapacity | null };

/**
 * `GET /static/status`(7o K12。システム管理者だけ)。設置タグの配信ファイルの配置の状態(すべてのワークスペース)。
 * lastDeployedAt = Cloudflare への配置が最後に成功した時刻(epoch ミリ秒)。needsAttention = 全ページの帯を出すか(Q5)
 */
export type StaticHealthView = {
  pendingSites: string[];
  removingSites: string[];
  lastError: string | null;
  failures: number;
  lastDeployedAt: number | null;
  mismatchSites: string[];
  unknownSites: string[];
  undeliveredSites: string[];
  publishedSites: number;
  unpublishedWithFiles: number;
  removingInD1: number;
  needsAttention: boolean;
};
/** `POST /static/rebuild` の 1 回分の応答(7o K11)。next が null でなければ after に渡して続ける */
export type RebuildResult = {
  requested: number;
  removed: number;
  skippedRemoving: number;
  failed: Array<{ siteId: string; reason: "no_publish_record" | "rejected" | "unavailable" }>;
  next: string | null;
};
