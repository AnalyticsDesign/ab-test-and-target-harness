import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { kvKeys } from "@wtt/core";
import { call, createExperiment, createSite, json, setupOwner } from "./helpers";

/**
 * B77(K12): dataLayer に出す値(外部計測の名前の指定と追加の値)の共通の検査。
 * 保存の API はどれも、変わった値と新しい値だけを analyticsValueIssue に通し、422 invalid_analytics_value(path・code 付き)を返す。
 * D1 に既にある古い値(制御文字を含む写した名前)は、公開と他の欄の保存を止めない
 */

const CASES = [
  { label: "empty", value: "", code: "empty", message: "値を入力してください" },
  { label: "100 chars", value: "あ".repeat(100), code: null, message: null },
  { label: "101 chars", value: "あ".repeat(101), code: "too_long", message: "100 字以内で入力してください" },
  { label: "control char", value: "改\n行", code: "invalid_char", message: "改行・タブなどの制御文字は使えません" },
] as const;

async function site() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  return { token: owner.token, sid };
}

/** 422 invalid_analytics_value の封筒(path は欄を指す) */
async function expectValueError(res: Response, path: Array<string | number>, code: string, message: string) {
  expect(res.status).toBe(422);
  const body = await json(res);
  expect(body).toMatchObject({ error: "invalid_analytics_value", code, message, path });
}

describe("analytics values (B77 K12)", () => {
  it("rejects_control_chars_on_every_write", async () => {
    const { token, sid } = await site();
    const { id: eid } = await createExperiment(token, sid, { id: "exp_patch" });
    await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_patch", name: "購入", type: "CUSTOM", config: {} } });
    let n = 0;
    // 書き込みごとに: 値を入れた body を送る関数・成功の status・欄の path
    const writes: Array<{ label: string; ok: number; path: Array<string | number>; send: (v: string) => Promise<Response> }> = [
      {
        label: "experiment create (override)",
        ok: 201,
        path: ["analytics", "overrides", "experimentName"],
        send: (v) => call("POST", `/sites/${sid}/experiments`, { token, body: { id: `exp_c${++n}`, name: "Hero", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] }, analytics: { overrides: { experimentName: v } } } }),
      },
      {
        label: "experiment create (extra)",
        ok: 201,
        path: ["analytics", "extra", "campaign"],
        send: (v) => call("POST", `/sites/${sid}/experiments`, { token, body: { id: `exp_c${++n}`, name: "Hero", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] }, analytics: { extra: { campaign: v } } } }),
      },
      {
        label: "experiment patch (override)",
        ok: 200,
        path: ["analytics", "overrides", "experimentName"],
        send: (v) => call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { analytics: { overrides: { experimentName: v } } } }),
      },
      {
        label: "experiment patch (extra)",
        ok: 200,
        path: ["analytics", "extra", "campaign"],
        send: (v) => call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { analytics: { extra: { campaign: v } } } }),
      },
      {
        label: "variants put (override)",
        ok: 200,
        path: ["variants", "b", "analytics", "overrides", "variantName"],
        send: (v) => call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50, analytics: { overrides: { variantName: v } } }] }),
      },
      {
        label: "variants put (extra)",
        ok: 200,
        path: ["variants", "b", "analytics", "extra", "campaign"],
        send: (v) => call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50 }, { id: "b", name: "B", weight: 50, analytics: { extra: { campaign: v } } }] }),
      },
      {
        label: "goal create",
        ok: 201,
        path: ["analytics", "overrides", "goalName"],
        send: (v) => call("POST", `/sites/${sid}/goals`, { token, body: { id: `g_c${++n}`, name: "購入", type: "CUSTOM", config: {}, analytics: { overrides: { goalName: v } } } }),
      },
      {
        label: "goal patch",
        ok: 200,
        path: ["analytics", "overrides", "goalName"],
        send: (v) => call("PATCH", `/sites/${sid}/goals/g_patch`, { token, body: { analytics: { overrides: { goalName: v } } } }),
      },
    ];
    for (const w of writes) {
      for (const c of CASES) {
        const res = await w.send(c.value);
        if (c.code === null) expect(res.status, `${w.label} / ${c.label}`).toBe(w.ok);
        else await expectValueError(res, w.path, c.code, c.message);
      }
    }
  });

  it("legacy_value_with_control_char_still_publishes", async () => {
    const { token, sid } = await site();
    const { id: eid } = await createExperiment(token, sid, { id: "exp_legacy" });
    // K7 で写した古い名前のように、制御文字を含む値が D1 に直接ある
    await env.DB.prepare("update experiments set analytics_json = ?1 where site_id = ?2 and id = ?3")
      .bind(JSON.stringify({ overrides: { experimentName: "旧\t名前" } }), sid, eid)
      .run();
    const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "running" } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publish.ok).toBe(true);
    // 公開した config にもそのまま焼かれる(読み込みでは弾かない)
    const raw = JSON.parse((await env.CONFIG_KV.get(kvKeys.config(sid, body.publish.version)))!);
    expect(raw.exposurePayloads[eid].b.experimentName).toBe("旧\t名前");
  });

  it("legacy_value_with_control_char_does_not_block_other_edits", async () => {
    const { token, sid } = await site();
    const { id: eid } = await createExperiment(token, sid, { id: "exp_legacy" });
    await env.DB.prepare("update experiments set analytics_json = ?1 where site_id = ?2 and id = ?3")
      .bind(JSON.stringify({ overrides: { experimentName: "旧\t名前" }, extra: { team: "古い\u0007値" } }), sid, eid)
      .run();
    await env.DB.prepare("update variants set analytics_json = ?1 where site_id = ?2 and experiment_id = ?3 and id = 'b'")
      .bind(JSON.stringify({ overrides: { variantName: "旧\nパターン" } }), sid, eid)
      .run();
    // 同じ値を含む保存は通る(変わっていない値は見ない)
    const same = await call("PATCH", `/sites/${sid}/experiments/${eid}`, {
      token,
      body: { trafficPercentage: 50, analytics: { overrides: { experimentName: "旧\t名前" }, extra: { team: "古い\u0007値" } } },
    });
    expect(same.status).toBe(200);
    expect((await json(same)).trafficPercentage).toBe(50);
    const put = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, {
      token,
      body: [{ id: "a", name: "A", weight: 40 }, { id: "b", name: "B", weight: 60, analytics: { overrides: { variantName: "旧\nパターン" } } }],
    });
    expect(put.status).toBe(200);
    // 値を別の制御文字入りに変えると 422
    const changed = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { analytics: { overrides: { experimentName: "新\t名前" }, extra: { team: "古い\u0007値" } } } });
    await expectValueError(changed, ["analytics", "overrides", "experimentName"], "invalid_char", "改行・タブなどの制御文字は使えません");
    // 古い値を別のパターンへ移すのは新しい値(そのパターンの保存済みの値と違う)
    const moved = await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, {
      token,
      body: [{ id: "a", name: "A", weight: 40, analytics: { overrides: { variantName: "旧\nパターン" } } }, { id: "b", name: "B", weight: 60 }],
    });
    await expectValueError(moved, ["variants", "a", "analytics", "overrides", "variantName"], "invalid_char", "改行・タブなどの制御文字は使えません");
  });

  it("accepts_quotes_and_backslash", async () => {
    const { token, sid } = await site();
    const { id: eid } = await createExperiment(token, sid, { id: "exp_quote" });
    const value = '購入 "完了" \\';
    const exp = await call("PATCH", `/sites/${sid}/experiments/${eid}`, { token, body: { analytics: { overrides: { experimentName: value }, extra: { note: value } } } });
    expect(exp.status).toBe(200);
    expect((await json(exp)).analytics).toEqual({ overrides: { experimentName: value }, extra: { note: value } });
    await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_buy", name: "購入", type: "CUSTOM", config: {} } });
    const goal = await call("PATCH", `/sites/${sid}/goals/g_buy`, { token, body: { analytics: { overrides: { goalName: value } } } });
    expect(goal.status).toBe(200);
    expect((await json(goal)).analytics).toEqual({ overrides: { goalName: value } });
  });
});
