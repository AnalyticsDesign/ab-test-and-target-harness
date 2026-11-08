import { describe, expect, it } from "vitest";
import { call, createExperiment, createSite, json, setupOwner } from "./helpers";

/**
 * B136: 設置タグ(runtime)は配る設定を素のオブジェクトとして ID で引くので、Object.prototype の名前の ID は継承したものと取り違える
 * (結果を記録するサイトで、記録の対象でない ID constructor の実験が、ページごとに不正な送信を出していた)。
 * SLUG_RE を通る名前は constructor だけ。エクスペリエンス・パターン・目標の ID を作る入口で 422 validation_failed にする
 */
const MESSAGE = "constructor は JavaScript で特別な意味を持つ名前なので ID に使えません";

/** 管理画面のセッションと API キー(エージェント)の両方で同じに断る */
async function tokens(): Promise<Array<[string, string, string]>> {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const key = (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "k", workspaceId: owner.workspaceId } }))).key;
  return [
    ["session", owner.token, sid],
    ["api key", key, sid],
  ];
}

async function expectReserved(res: Response, path: Array<string | number>): Promise<void> {
  expect(res.status).toBe(422);
  expect(await json(res)).toMatchObject({ error: "validation_failed", path, message: MESSAGE });
}

describe("ID constructor is reserved for experiments, variants and goals (B136)", () => {
  it("エクスペリエンスの作成と複製の ID に constructor を使うと 422(path は id)", async () => {
    for (const [label, token, sid] of await tokens()) {
      await expectReserved(await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "constructor", name: "x", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } }), ["id"]);
      const { id: src } = await createExperiment(token, sid);
      await expectReserved(await call("POST", `/sites/${sid}/experiments/${src}/duplicate`, { token, body: { mode: "same", id: "constructor" } }), ["id"]);
      // 形の違う名前(__proto__)は形の誤りの 1 件だけ(予約の検査は重ねない)
      const shape = await json<{ issues: unknown[] }>(await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "__proto__", name: "x", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } }));
      expect(shape.issues).toHaveLength(1);
      // constructor を含むだけの ID は使える
      expect((await call("POST", `/sites/${sid}/experiments/${src}/duplicate`, { token, body: { mode: "same", id: `constructor-copy-${label.replace(" ", "-")}` } })).status).toBe(201);
    }
  });

  it("パターンの保存(PUT …/variants)の ID に constructor を使うと 422(path は [位置, id])", async () => {
    for (const [, token, sid] of await tokens()) {
      const { id: eid } = await createExperiment(token, sid);
      const body = [{ id: "a", name: "A", weight: 50 }, { id: "constructor", name: "B", weight: 50 }];
      await expectReserved(await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body }), [1, "id"]);
      expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [body[0], { ...body[1], id: "b_constructor" }] })).status).toBe(200);
    }
  });

  it("目標の作成の ID に constructor を使うと 422(path は id)", async () => {
    for (const [label, token, sid] of await tokens()) {
      await expectReserved(await call("POST", `/sites/${sid}/goals`, { token, body: { id: "constructor", name: "x", type: "CUSTOM", config: {} } }), ["id"]);
      expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id: `g_constructor_${label.replace(" ", "_")}`, name: "x", type: "CUSTOM", config: {} } })).status).toBe(201);
    }
  });
});
