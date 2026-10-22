import { describe, expect, it } from "vitest";
import { publishRowStatus, recentPublishes } from "@/lib/publish-status";
import type { PublishRow } from "@/lib/types";

/** 版と状態だけ変えた公開の行 */
const row = (version: number, status: PublishRow["status"] = "superseded"): PublishRow => ({
  version,
  status,
  createdAt: 1_700_000_000_000 + version,
  activatedAt: null,
  needsProfile: null,
  error: null,
  publishedBy: { id: "u1", name: "User" },
});

describe("publish-status", () => {
  it("publish_row_status_marks_active_version", () => {
    // いま配信中かは activeVersion と版の一致だけで決める(active の行は複数ありうる)
    expect(publishRowStatus({ version: 3, status: "active" }, 3)).toEqual({ label: "配信中", tone: "ok" });
    expect(publishRowStatus({ version: 2, status: "active" }, 3)).toEqual({ label: "公開済み", tone: "gray" });
    expect(publishRowStatus({ version: 1, status: "superseded" }, 3)).toEqual({ label: "置き換え済み", tone: "gray" });
    expect(publishRowStatus({ version: 4, status: "failed" }, 3)).toEqual({ label: "失敗", tone: "danger" });
    expect(publishRowStatus({ version: 5, status: "reserved" }, 3)).toEqual({ label: "処理中", tone: "warn" });
    // 一度も配信していない(activeVersion = null)なら active でも「配信中」にしない
    expect(publishRowStatus({ version: 1, status: "active" }, null)).toEqual({ label: "公開済み", tone: "gray" });
  });

  it("recent_publishes_takes_newest_five", () => {
    const rows = [3, 8, 1, 6, 2, 7, 5, 4].map((v) => row(v));
    const before = rows.map((r) => r.version);
    expect(recentPublishes(rows).map((r) => r.version)).toEqual([8, 7, 6, 5, 4]);
    expect(rows.map((r) => r.version)).toEqual(before); // 渡した配列は並べ替えない
    expect(recentPublishes([row(1), row(3), row(2)]).map((r) => r.version)).toEqual([3, 2, 1]);
    expect(recentPublishes([])).toEqual([]);
    expect(recentPublishes(rows, 2).map((r) => r.version)).toEqual([8, 7]);
  });
});
