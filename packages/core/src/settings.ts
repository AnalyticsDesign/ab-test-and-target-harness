import { z } from "zod";
import { AnalyticsSettingsSchema } from "./analytics";
import type { AnalyticsSettings } from "./analytics-defaults";

/** RFC 6265 の cookie-name(token)規則。spec §13.5 の保存時検証と同じ規則をスキーマで持つ */
const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CookieName = z.string().min(1).max(64).regex(COOKIE_NAME_RE); // 1〜64 字(決定 29)

/** Site ID の受理集合(1〜64 字)。CompileInput / SiteSettings / edge の全ルートで単一定義を共有する(r2 CX-Medium-8。KV key は 512B 上限) */
export const SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SiteId = z.string().regex(SITE_ID_RE);

/** 決定 29: `new URL(v).origin === v` と同値の完全な origin(http/https のみ。パス・末尾スラッシュ不可) */
export function isExactOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === v;
  } catch {
    return false;
  }
}

/**
 * spec §5.4 / §9.6: site-settings record(KV)。control が Site 保存時に書き(activation = KV put)、
 * bootstrap /s/<siteId>.js の serve 時焼込みと D-lite edge が読む。compiled config には入れない。
 */
export const SiteSettingsSchema = z
  .strictObject({
    settingsVersion: z.literal(1), // optional 追加では上げない。破壊的変更で上げて edge を先にデプロイ(未知 version は fail-closed。決定 29)
    siteId: SiteId,
    mode: z.enum(["A", "B"]).default("A"), // D-lite は B + Proxy Mode(spec §4)
    idSource: z
      .string()
      .refine((v) => v === "ab" || (v.startsWith("cookie:") && CookieName.safeParse(v.slice("cookie:".length)).success), {
        message: "idSource must be ab or cookie:<cookie-name token 1..64>", // MVP は ab / cookie:<name>(spec §4.3、決定 29)
      })
      .default("ab"),
    allowedOrigins: z.array(z.string().refine(isExactOrigin, { message: "must be an exact http(s) origin" })).default([]), // 完全一致のみ。空 = ブラウザ直接経路は全拒否(spec §4.1。形式は決定 29)
    hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default([]), // D-lite の Workers Route ホスト名。小文字・IDN は punycode(spec §9.6、決定 29)
    visitorCookieName: CookieName.default("_ab_vid"),
    uuidCookieEnabled: z.boolean().default(false),
    uuidCookieName: CookieName.default("_ab_uuid"),
    previousCookieNames: z.array(z.strictObject({ name: CookieName, until: z.number().int() })).default([]), // until = 保持期限(epoch 秒)。edge は参照せず control が prune する(spec §5.4)。生きているエントリと同名への変更は control が 422 で拒否(決定 29)
    decisionTimeoutMs: z.number().int().min(300).max(3000).default(1000),
    consentMode: z.enum(["implicit", "required"]).default("implicit"),
    // spec §10.9(決定 32): dataLayer の名札。全フィールド optional で既定値を埋める。settingsVersion は据え置き(optional 追加)。
    // strict のため、このフィールドを含む record を書く前に edge を再デプロイする(旧 edge は parse できず bootstrap 404 = fail-closed)
    analytics: AnalyticsSettingsSchema.prefault({}),
    // spec §8.3 / 決定 37: DO の alarm 期限。1〜3650(control の実装に合わせた)。旧 record は欠落 → 90
    retentionDays: z.number().int().min(1).max(3650).default(90),
    // spec §16 / 決定 37: 撤回時に runtime が forget を送り DO を deleteAll する。off = Retention に委ねる
    forgetOnRevoke: z.boolean().default(true),
  })
  .refine((s) => s.visitorCookieName !== s.uuidCookieName, { message: "visitorCookieName and uuidCookieName must differ" })
  // spec §4(決定 1): Mode B の BYOID は Bridge フック(Phase 2)。MVP では併用不可(r2 CX-Medium-10)
  .refine((s) => s.mode === "A" || s.idSource === "ab", { message: "mode B requires idSource ab (BYOID hook is Phase 2)" })
  // BYOID の参照 Cookie 名が Identity 系の名前と衝突すると、フォールバックで自分が書いた値を
  // 次の起動で BYOID の入力として読む(ID が 22 文字 → 43 文字に変わる)。入口で止める。
  // previousCookieNames は保持期限を見ずに全件比較する(スキーマを時刻非依存に保つ。期限切れは control の prune 後に再利用可)
  .refine(
    (s) => {
      if (!s.idSource.startsWith("cookie:")) return true;
      const ref = s.idSource.slice("cookie:".length);
      return ref !== s.visitorCookieName && ref !== s.uuidCookieName && !s.previousCookieNames.some((p) => p.name === ref);
    },
    { message: "idSource cookie name must differ from visitorCookieName, uuidCookieName and previousCookieNames" },
  );
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;

export function parseSiteSettings(json: unknown): SiteSettings | null {
  const r = SiteSettingsSchema.safeParse(json);
  return r.success ? r.data : null;
}

/** spec §5.4: bootstrap に焼き込む runtime 向けサブセット。hosts / allowedOrigins / siteId は含めない */
export type RuntimeSettings = {
  mode: "A" | "B";
  idSource: string;
  visitorCookieName: string;
  uuidCookieEnabled: boolean;
  uuidCookieName: string;
  previousCookieNames: string[];
  decisionTimeoutMs: number;
  consentMode: "implicit" | "required";
  /** §10.9: 名札。toRuntimeSettings は常に設定する。optional なのは旧 record 由来の boot payload を runtime が既定名で受けるため */
  analytics?: AnalyticsSettings;
  /** §16 / 決定 37: 撤回時の forget 送信。optional なのは旧 record 由来の boot payload を runtime が既定 true で受けるため */
  forgetOnRevoke?: boolean;
};

export function toRuntimeSettings(s: SiteSettings): RuntimeSettings {
  return {
    mode: s.mode,
    idSource: s.idSource,
    visitorCookieName: s.visitorCookieName,
    uuidCookieEnabled: s.uuidCookieEnabled,
    uuidCookieName: s.uuidCookieName,
    previousCookieNames: s.previousCookieNames.map((p) => p.name),
    decisionTimeoutMs: s.decisionTimeoutMs,
    consentMode: s.consentMode,
    analytics: s.analytics,
    forgetOnRevoke: s.forgetOnRevoke,
  };
}

/** KV キーの単一定義(spec §9.4 / §5.4 / §9.6。control / edge / fixture CLI で共有) */
export const kvKeys = {
  config: (siteId: string, version: number) => `site:${siteId}:config:v${version}`,
  active: (siteId: string) => `site:${siteId}:active`,
  settings: (siteId: string) => `site:${siteId}:settings`,
  host: (host: string) => `host:${host.toLowerCase()}`,
} as const;
