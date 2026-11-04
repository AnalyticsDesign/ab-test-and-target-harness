import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/client";
import { REFRESH_TIMEOUT, WRITE_UNKNOWN, noticeOf } from "@/lib/busy-notice";

/** カード・一覧のカードの書き込みの結果の 1 行(B173 第 2 段 Task 6) */
describe("noticeOf", () => {
  it("saved with a finished refresh (or no refresh) shows the caller's success text", () => {
    expect(noticeOf({ kind: "saved", value: null, refresh: "done" }, "削除しました")).toEqual({ status: "削除しました", error: null });
    expect(noticeOf({ kind: "saved", value: null, refresh: "skipped" }, "追加しました")).toEqual({ status: "追加しました", error: null });
  });

  it("saved whose refresh timed out keeps it a success but says the view may be old, in the success position", () => {
    expect(noticeOf({ kind: "saved", value: null, refresh: "timeout" }, "保存しました")).toEqual({ status: REFRESH_TIMEOUT, error: null });
  });

  it("saved with no success text (the result shows in its own box) shows nothing unless the refresh timed out", () => {
    expect(noticeOf({ kind: "saved", value: null, refresh: "done" }, null)).toBeNull();
    expect(noticeOf({ kind: "saved", value: null, refresh: "skipped" }, null)).toBeNull();
    expect(noticeOf({ kind: "saved", value: null, refresh: "timeout" }, null)).toEqual({ status: REFRESH_TIMEOUT, error: null });
  });

  it("failed shows the error text; unknown shows the 30 s text", () => {
    const err = new ApiClientError(409, "conflict", { error: "conflict", message: "参照されています" });
    expect(noticeOf({ kind: "failed", error: err }, "x")).toEqual({ status: null, error: "参照されています" });
    expect(noticeOf({ kind: "unknown" }, "x")).toEqual({ status: null, error: WRITE_UNKNOWN });
  });

  it("discarded, cancelled, ignored and navigated show nothing", () => {
    for (const kind of ["discarded", "cancelled", "ignored"] as const) expect(noticeOf({ kind }, "x")).toBeNull();
    expect(noticeOf({ kind: "navigated", value: null, nav: "timedOut" }, "x")).toBeNull();
  });
});
