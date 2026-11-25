import { expect, it } from "vitest";
import { ApiClientError, describeError } from "@/lib/client";
import { statusOutcomeMessage } from "@/lib/status-message";
import type { Experiment, PublishResult, Status } from "@/lib/types";

function failed(code: string, from: Status = "draft", status = 409) {
  const error = new ApiClientError(status, code, { message: "準備の結果", hint: "設定を確認してください" });
  return statusOutcomeMessage("running", from, { kind: "failed", error }, describeError);
}
const saved = (publish: PublishResult) => ({ kind: "saved" as const, value: { publish, experiment: {} as Experiment } });

it.each([
  "kv_put_failed", "kv_verify_failed", "version_reservation_failed", "publish_failed", "compile_failed",
  "invalid_regex", "regex_too_large", "regex_budget_exceeded", "audience_expansion_too_large",
  "legacy_targeting", "invalid_experiment_targeting", "invalid_audience_definition", "unknown_audience", "unknown_goal",
  "within_days_exceeds_retention", "page_condition_moved", "config_too_large", "invalid_input", "invalid_analytics",
])("start_409_publish_failure_says_status_unchanged (%s)", (code) => {
  expect(failed(code)).toEqual({ text: "開始できませんでした(状態は変わっていません)。準備の結果 設定を確認してください", error: true });
});
it.each(["publish_failed", "config_too_large", "invalid_input", "invalid_analytics"])("resume_409_publish_failure_says_status_unchanged (%s)", (code) => {
  expect(failed(code, "paused")?.text).toBe("再開できませんでした(状態は変わっていません)。準備の結果 設定を確認してください");
});
it.each(["invalid_transition", "transition_conflict", "publish_outcome_unknown", "publish_reservation_expired", "publish_record_missing", "state_changed"])("no_prefix_for_conflict_unknown_and_invalid_transition (%s)", (code) => {
  expect(failed(code, "draft", code === "publish_outcome_unknown" ? 503 : 409)?.text).toBe("準備の結果 設定を確認してください");
});
it("pause_publish_failure_keeps_current_text", () => {
  const out = saved({ ok: false, version: 2, error: "kv_put_failed", message: "準備に失敗" });
  expect(statusOutcomeMessage("paused", "running", out, describeError)?.text).toBe("状態は 一時停止 に変わりましたが、公開に失敗しました(kv_put_failed: 準備に失敗)。上部の「公開」から再試行してください");
});
it("delivery_warning_message_on_success", () => {
  const out = saved({ ok: true, version: 3, needsProfile: false, superseded: false, warnings: [{ path: "delivery", message: "遅れ" }], staticDeploy: "skipped" });
  expect(statusOutcomeMessage("running", "draft", out, describeError)).toEqual({ text: "公開は確定しました。配信への反映は遅れています(自動で反映します)", error: false });
});
it.each(["asset_missing", "asset_other_site", "stale_preview"])("asset_and_stale_preview_return_null (%s)", (code) => {
  expect(failed(code)).toBeNull();
});

it("公開の警告が欠けた応答でも成功結果を表示できる", () => {
  const publish = { ok: true, version: 7, needsProfile: false, superseded: false, staticDeploy: "skipped" } satisfies PublishResult;
  expect(statusOutcomeMessage("paused", "running", saved(publish), describeError)?.text).toContain("公開 v7 を反映しました");
});
