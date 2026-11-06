/**
 * B129(spec §1・§3.1・§4.1): 管理の操作の記録(control の表 audit_events)の action・区分・経路・対象の種類の一覧。
 * control(記録を書く・読む API の enum)と管理画面(文言の表)が同じ一覧を使う。runtime は import しない
 * (定数だけで副作用が無いので、core の index から export しても runtime の bundle には入らない。`pnpm -C packages/runtime build` の大きさで確かめる)。
 * zod-free。
 *
 * 新しい書き込みの経路を足すときは、記録するかを決め、記録するなら action をここに足して区分を AUDIT_ACTION_CATEGORY に書く
 * (型が対応表の漏れを落とす)
 */

/** 区分。access = 人とアクセス権・導入の設定 / content = サイト・エクスペリエンス・目標・オーディエンス・公開 */
export const AUDIT_CATEGORIES = ["access", "content"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** 記録する操作(spec §3.1 の表の順) */
export const AUDIT_ACTIONS = [
  // access
  "invitation.create",
  "invitation.cancel",
  "invitation.accept",
  "member.role_change",
  "member.remove",
  "member.reset_link",
  "instance_admin.grant",
  "instance_admin.revoke",
  "api_key.create",
  "api_key.revoke",
  "api_key.revoke_member",
  "workspace.create",
  "workspace.delete",
  "setup.complete",
  "usage.settings_change",
  "static.rebuild",
  "break_glass.reset_link",
  "auth.password_login",
  "break_glass.sweep",
  // content
  "site.create",
  "site.update",
  "site.delete",
  "experiment.create",
  "experiment.update",
  "experiment.memo",
  "experiment.variants",
  "experiment.variant_memo",
  "experiment.changes",
  "experiment.status",
  "experiment.adoption",
  "experiment.duplicate",
  "experiment.delete",
  "experiment.evaluation_plan",
  "goal.create",
  "goal.update",
  "goal.delete",
  "audience.create",
  "audience.update",
  "audience.delete",
  "asset.upload",
  "asset.rename",
  "asset.delete",
  "publish.publish",
  "publish.static_redeploy",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** action → 区分。記録の行の category はここから決める(呼び出し元は渡さない) */
export const AUDIT_ACTION_CATEGORY: Readonly<Record<AuditAction, AuditCategory>> = {
  "invitation.create": "access",
  "invitation.cancel": "access",
  "invitation.accept": "access",
  "member.role_change": "access",
  "member.remove": "access",
  "member.reset_link": "access",
  "instance_admin.grant": "access",
  "instance_admin.revoke": "access",
  "api_key.create": "access",
  "api_key.revoke": "access",
  "api_key.revoke_member": "access",
  "workspace.create": "access",
  "workspace.delete": "access",
  "setup.complete": "access",
  "usage.settings_change": "access",
  "static.rebuild": "access",
  "break_glass.reset_link": "access",
  "auth.password_login": "access",
  "break_glass.sweep": "access",
  "site.create": "content",
  "site.update": "content",
  "site.delete": "content",
  "experiment.create": "content",
  "experiment.update": "content",
  "experiment.memo": "content",
  "experiment.variants": "content",
  "experiment.variant_memo": "content",
  "experiment.changes": "content",
  "experiment.status": "content",
  "experiment.adoption": "content",
  "experiment.duplicate": "content",
  "experiment.delete": "content",
  "experiment.evaluation_plan": "content",
  "goal.create": "content",
  "goal.update": "content",
  "goal.delete": "content",
  "audience.create": "content",
  "audience.update": "content",
  "audience.delete": "content",
  "asset.upload": "content",
  "asset.rename": "content",
  "asset.delete": "content",
  "publish.publish": "content",
  "publish.static_redeploy": "content",
};

/**
 * 経路(操作した要求の認証の形)。google / password = そのログインで作ったセッション、unknown = セッションに印が無い、
 * api_key = API キー、break_glass = 非常用トークン(操作した人なし)、setup = 初期設定のトークン、system = Cron
 */
export const AUDIT_VIAS = ["google", "password", "unknown", "api_key", "break_glass", "setup", "system"] as const;
export type AuditVia = (typeof AUDIT_VIAS)[number];

/** 対象の種類(記録の行の target_type) */
export const AUDIT_TARGET_TYPES = ["user", "invitation", "api_key", "workspace", "site", "experiment", "variant", "goal", "audience", "asset", "instance"] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];
