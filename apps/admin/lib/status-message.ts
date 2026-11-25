import type { CompileErrorCode } from "@wtt/core";
import { assetGuardRejection } from "./asset-problems";
import { ApiClientError } from "./client";
import { STATUS_JA } from "./experiment-filter";
import type { PublishResult, Status, StatusResult } from "./types";

export const DELIVERY_DELAYED = "公開は確定しました。配信への反映は遅れています(自動で反映します)";
export const PUBLISH_OUTCOME_UNKNOWN = "公開の結果を確かめられませんでした。画面を読み込み直して、公開履歴と状態を確かめてください";

export function deliveryDelayed(publish: PublishResult): boolean {
  return publish.ok && publish.warnings?.some((w) => w.path === "delivery") === true;
}
export function publishOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 503 && error.code === "publish_outcome_unknown";
}

// 開始・再開の準備で失敗した 409。compile が返すコードの追加は型検査で拾う。
const PREPARATION_FAILURES = {
  invalid_regex: true,
  regex_too_large: true,
  regex_budget_exceeded: true,
  audience_expansion_too_large: true,
  legacy_targeting: true,
  invalid_experiment_targeting: true,
  invalid_audience_definition: true,
  unknown_audience: true,
  unknown_goal: true,
  within_days_exceeds_retention: true,
  page_condition_moved: true,
  config_too_large: true,
  invalid_input: true,
  invalid_analytics: true,
  compile_failed: true,
  kv_put_failed: true,
  kv_verify_failed: true,
  version_reservation_failed: true,
  publish_failed: true,
} satisfies Record<CompileErrorCode, true> & Record<string, true>;
export type StatusTarget = Exclude<Status, "draft">;
export function statusOutcomeMessage(
  to: StatusTarget, from: Status,
  outcome: { kind: "saved"; value: StatusResult } | { kind: "failed"; error: unknown },
  describe: (e: unknown) => string,
): { text: string; error: boolean } | null {
  if (outcome.kind === "failed") {
    const e = outcome.error;
    if (assetGuardRejection(e, to) || (e instanceof ApiClientError && e.code === "stale_preview")) return null;
    const detail = describe(e);
    if (to === "running" && e instanceof ApiClientError && e.status === 409 && Object.hasOwn(PREPARATION_FAILURES, e.code)) {
      const verb = from === "paused" ? "再開" : "開始";
      return { text: `${verb}できませんでした(状態は変わっていません)。${detail}`, error: true };
    }
    return { text: detail, error: true };
  }
  const { publish } = outcome.value;
  if (publish.ok) {
    const text = deliveryDelayed(publish) ? DELIVERY_DELAYED : `公開 v${publish.version} を反映しました(訪問者のブラウザには 1 分ほどで届きます)`;
    return { text, error: false };
  }
  if (publish.error === "stale_preview") return null;
  return { text: `状態は ${STATUS_JA[to]} に変わりましたが、公開に失敗しました(${publish.error}: ${publish.message})。上部の「公開」から再試行してください`, error: true };
}
