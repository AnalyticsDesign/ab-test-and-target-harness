import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConditionRow, type RowCtx } from "@/components/targeting/ConditionRow";
import {
  audienceDiscardTarget, audienceDraftOf, audienceInputDraft, audiencePatchBody, audienceServerKey, isAudienceDirty, reconcileAudienceUpdate, type AudienceDraft,
} from "@/lib/audience-draft";
import { audienceTreeFromDsl, type Cond, type Group } from "@/lib/targeting-tree";
import type { Audience } from "@/lib/types";

/**
 * オーディエンスの下書き(B173 第 2 段 Task 4)。変えた欄だけの PATCH・サーバーの値の取り込み(エクスペリエンスの reconcileServerUpdate と同じ決まり)・
 * 画面で表せる条件(tree)と表せない定義(raw)の区別
 */
const DEF_A = { ctx: "device", op: "in", value: ["mobile"] };
const DEF_B = { ctx: "device", op: "in", value: ["desktop"] };
// 画面で表せない定義(core の検査を通らない古い書式の代わり)
const RAW_A = { legacy: "a", rule: 1 };
const RAW_B = { legacy: "b", rule: 2 };

const aud = (over: Partial<Audience> = {}): Audience => ({
  id: "aud_x", name: "Pricing", description: "memo", definition: DEF_A, usedBy: [], createdAt: 1, updatedAt: 2, ...over,
});
/** 画面の木(サーバーの値から作る。ノードの id は変換ごとに振り直す) */
const tree = (def: unknown): Group => audienceTreeFromDsl(def)!;
/** 画面の入力から今の下書きを作る(tree の下書き) */
const typed = (over: { name?: string; description?: string; def?: unknown } = {}): AudienceDraft =>
  audienceInputDraft({ name: over.name ?? "Pricing", description: over.description ?? "memo", manualId: null, tree: tree(over.def ?? DEF_A), raw: null });

describe("audience draft", () => {
  it("fixtures: RAW_* cannot be shown on screen, DEF_* can", () => {
    expect(audienceTreeFromDsl(RAW_A)).toBeNull();
    expect(audienceTreeFromDsl(RAW_B)).toBeNull();
    expect(audienceTreeFromDsl(DEF_A)).not.toBeNull();
  });

  it("name-only change sends only { name }", () => {
    const base = audienceDraftOf(aud());
    const draft = typed({ name: "Pricing 2" });
    expect(isAudienceDirty(base, draft)).toBe(true);
    expect(audiencePatchBody({ base, draft, root: tree(DEF_A), canSendDefinition: draft.editable })).toEqual({ name: "Pricing 2" });
  });

  it("condition change sends the definition only", () => {
    const base = audienceDraftOf(aud());
    const draft = typed({ def: DEF_B });
    const body = audiencePatchBody({ base, draft, root: tree(DEF_B), canSendDefinition: draft.editable });
    expect(body).toEqual({ definition: DEF_B });
    expect("name" in body).toBe(false);
    expect("description" in body).toBe(false);
  });

  it("raw definition is never sent", () => {
    const base = audienceDraftOf(aud({ definition: RAW_A }));
    expect(base.editable).toBe(false);
    expect(base.condition).toEqual({ kind: "raw" });
    const draft: AudienceDraft = { ...base, name: "Renamed" };
    const body = audiencePatchBody({ base, draft, root: null, canSendDefinition: draft.editable });
    expect(body).toEqual({ name: "Renamed" });
    // 鍵が違っても(あり得ないが)raw の下書きは definition を送らない
    expect(audiencePatchBody({ base: audienceDraftOf(aud({ definition: RAW_B })), draft, root: null, canSendDefinition: false })).toEqual({ name: "Renamed" });
  });

  it("an empty tree and a raw definition are different", () => {
    const empty = audienceDraftOf({ name: "", description: "", definition: null });
    expect(empty.condition).toEqual({ kind: "tree", dsl: null });
    expect(empty.editable).toBe(true);
    const raw = audienceDraftOf({ name: "", description: "", definition: RAW_A });
    expect(raw.editable).toBe(false);
    expect(empty.definitionKey).not.toBe(raw.definitionKey);
    expect(isAudienceDirty(empty, raw)).toBe(true);
  });

  it("raw to tree: clean takes the server value, dirty keeps the draft with the notice", () => {
    const base = audienceDraftOf(aud({ definition: RAW_A }));
    const server = audienceDraftOf(aud({ definition: DEF_B }));
    // clean: server の値になり、編集できる
    const clean = reconcileAudienceUpdate({ base, draft: base, server });
    expect(clean).toEqual({ base: server, draft: server, notice: false });
    expect(clean.draft.editable).toBe(true);
    expect(clean.draft.condition).toEqual({ kind: "tree", dsl: DEF_B });
    // dirty(名前を変えた): 下書きは raw のまま・注記
    const draft: AudienceDraft = { ...base, name: "Renamed" };
    const dirty = reconcileAudienceUpdate({ base, draft, server });
    expect(dirty.base).toBe(base);
    expect(dirty.draft).toBe(draft);
    expect(dirty.draft.editable).toBe(false);
    expect(dirty.notice).toBe(true);
    expect(audiencePatchBody({ base: dirty.base, draft: dirty.draft, root: null, canSendDefinition: dirty.draft.editable })).toEqual({ name: "Renamed" });
    // 破棄(自分の保存がまだ無い)は、届いたサーバーの値へ戻す = 表せる木
    const latest = aud({ definition: DEF_B });
    const back = audienceDraftOf(audienceDiscardTarget({ server: latest, serverKey: audienceServerKey(latest), saved: null }));
    expect(back.editable).toBe(true);
    expect(back.condition).toEqual({ kind: "tree", dsl: DEF_B });
    expect(isAudienceDirty(back, draft)).toBe(true);
  });

  it("tree to raw: clean takes the server value, dirty keeps the draft with the notice", () => {
    const base = audienceDraftOf(aud());
    const server = audienceDraftOf(aud({ definition: RAW_A }));
    const clean = reconcileAudienceUpdate({ base, draft: typed(), server });
    expect(clean.draft).toBe(server);
    expect(clean.draft.editable).toBe(false);
    expect(clean.notice).toBe(false);
    // dirty(条件を変えた): 下書きは tree のまま・注記。PATCH は definition を含む(下書きは編集できる)
    const draft = typed({ def: DEF_B });
    const dirty = reconcileAudienceUpdate({ base, draft, server });
    expect(dirty.draft).toBe(draft);
    expect(dirty.draft.editable).toBe(true);
    expect(dirty.notice).toBe(true);
    expect(audiencePatchBody({ base: dirty.base, draft: dirty.draft, root: tree(DEF_B), canSendDefinition: dirty.draft.editable })).toEqual({ definition: DEF_B });
    // 破棄は届いたサーバーの値(raw)へ
    const latest = aud({ definition: RAW_A });
    const back = audienceDraftOf(audienceDiscardTarget({ server: latest, serverKey: audienceServerKey(latest), saved: null }));
    expect(back.condition).toEqual({ kind: "raw" });
    expect(back.definitionKey).toBe(server.definitionKey);
  });

  it("raw A to raw B is noticed by the definition key", () => {
    const base = audienceDraftOf(aud({ definition: RAW_A }));
    const server = audienceDraftOf(aud({ definition: RAW_B }));
    expect(base.definitionKey).not.toBe(server.definitionKey);
    expect(reconcileAudienceUpdate({ base, draft: base, server })).toEqual({ base: server, draft: server, notice: false });
    const draft: AudienceDraft = { ...base, description: "changed" };
    const dirty = reconcileAudienceUpdate({ base, draft, server });
    expect(dirty.notice).toBe(true);
    const body = audiencePatchBody({ base: dirty.base, draft: dirty.draft, root: null, canSendDefinition: dirty.draft.editable });
    expect(body).toEqual({ description: "changed" });
    expect("definition" in body).toBe(false);
    // 破棄は届いたサーバーの値(raw B)へ
    const latest = aud({ definition: RAW_B });
    const back = audienceDraftOf(audienceDiscardTarget({ server: latest, serverKey: audienceServerKey(latest), saved: null }));
    expect(back.definitionKey).toBe(server.definitionKey);
    expect(back.definitionKey).not.toBe(base.definitionKey);
  });

  it("server update while clean replaces base and draft", () => {
    const base = audienceDraftOf(aud());
    const server = audienceDraftOf(aud({ name: "Other", definition: DEF_B }));
    expect(reconcileAudienceUpdate({ base, draft: typed(), server })).toEqual({ base: server, draft: server, notice: false });
  });

  it("server update while dirty keeps the draft and shows the notice", () => {
    const base = audienceDraftOf(aud());
    const draft = typed({ description: "my memo" });
    const server = audienceDraftOf(aud({ definition: DEF_B }));
    const r = reconcileAudienceUpdate({ base, draft, server });
    expect(r.base).toBe(base);
    expect(r.draft).toBe(draft);
    expect(r.notice).toBe(true);
  });

  it("own save: the refreshed value equal to the sent value gives no notice", () => {
    const sent = audienceDraftOf(aud({ name: "Sent", definition: DEF_B }));
    const server = audienceDraftOf(aud({ name: "Sent", definition: DEF_B, updatedAt: 9 }));
    expect(reconcileAudienceUpdate({ base: sent, draft: sent, server }).notice).toBe(false);
    // 画面の木から作った下書きとサーバーの値から作った下書きは、ノードの id が違っても同じ
    expect(isAudienceDirty(sent, typed({ name: "Sent", def: DEF_B }))).toBe(false);
  });

  // 最終レビュー I3: A を表示 → B を保存(成功)→ 読み直しが時間切れ(props は A のまま)→ C に編集 → 破棄 = B に戻り、次の PATCH も B が基準
  it("discard after an own save whose refresh timed out goes back to the saved value, until a newer server value arrives", () => {
    const shownA = aud({ name: "A", definition: DEF_A });
    const keyA = audienceServerKey(shownA);
    // 保存の応答(control が正規化した値)。保存した時点の props の鍵と一緒に覚える
    const savedB = aud({ name: "B", definition: DEF_B, updatedAt: 5 });
    const saved = { serverKey: keyA, value: savedB };
    // props は A のまま: 破棄先は B
    const target = audienceDiscardTarget({ server: shownA, serverKey: keyA, saved });
    expect(target).toBe(savedB);
    const base = audienceDraftOf(target);
    const editedC = typed({ name: "C", def: DEF_B });
    expect(isAudienceDirty(base, editedC)).toBe(true);
    // 破棄の後は B と同じ(未保存の変更なし)
    expect(isAudienceDirty(base, typed({ name: "B", def: DEF_B }))).toBe(false);
    // 次の PATCH は B を基準に(名前だけ D に変えたら name だけ。条件は B と同じなので送らない)
    expect(audiencePatchBody({ base, draft: typed({ name: "D", def: DEF_B }), root: tree(DEF_B), canSendDefinition: true })).toEqual({ name: "D" });
    // 新しいサーバーの値が届いた(鍵が変わった)ら、そちらが勝つ
    const newer = aud({ name: "E", definition: DEF_A, updatedAt: 7 });
    expect(audienceDiscardTarget({ server: newer, serverKey: audienceServerKey(newer), saved })).toBe(newer);
    // 自分の保存の読み直しが届いた(props が B)ときも、届いた値
    const refreshedB = aud({ name: "B", definition: DEF_B, updatedAt: 5 });
    expect(audienceDiscardTarget({ server: refreshedB, serverKey: audienceServerKey(refreshedB), saved })).toBe(refreshedB);
  });

  it("the same definition key with a different editable is the same", () => {
    const a = audienceDraftOf(aud());
    expect(isAudienceDirty(a, { ...a, editable: false })).toBe(false);
  });

  it("new screen: a hand-edited ID alone is unsaved", () => {
    const base = audienceDraftOf({ name: "", description: "", definition: null });
    const draft = audienceInputDraft({ name: "", description: "", manualId: "aud_manual", tree: audienceTreeFromDsl(null)!, raw: null });
    expect(isAudienceDirty(base, draft)).toBe(true);
  });

  it("audienceServerKey changes when only the definition changes", () => {
    expect(audienceServerKey(aud())).not.toBe(audienceServerKey(aud({ definition: DEF_B })));
    expect(audienceServerKey(aud())).toBe(audienceServerKey(aud()));
    expect(audienceServerKey(aud())).not.toBe(audienceServerKey(aud({ description: "other" })));
    expect(audienceServerKey(aud())).not.toBe(audienceServerKey(aud({ updatedAt: 3 })));
  });
});

/** B69 Task 7(spec §4・§7.5): オーディエンスの木に残った、外したページの条件の行 */
describe("使えなくなった条件の行(オーディエンス)", () => {
  const ctx = (allowAudience: boolean, disabled = false): RowCtx => ({ goals: [], goalsHref: "/goals", audiences: [], retentionDays: 30, timezone: "Asia/Tokyo", allowAudience, disabled });
  const PATH = { ctx: "path", op: "startsWith", value: "/lp/" };
  it("legacy_row_renders: オーディエンスの木の行は、エクスペリエンスの対象 URL へ案内する", () => {
    const tree = audienceTreeFromDsl({ or: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: PATH }] });
    const cond = tree?.children[1] as Cond;
    expect(cond.type).toBe("legacy");
    const html = renderToStaticMarkup(createElement(ConditionRow, { cond, onChange: () => {}, onRemove: () => {}, ctx: ctx(false) }));
    expect(html).toContain("この条件はオーディエンスでは使えなくなりました");
    expect(html).toContain("ページのパス が「/lp/」で始まる ではない");
    expect(html).toContain("ページの URL・ホスト・パス・パラメータの条件は、エクスペリエンスの対象 URL で指定してください。このオーディエンスを使うエクスペリエンスごとに書きます。この条件を消してください。このままでは保存できません");
    expect(html).toContain(">この条件を消す</button>");
    expect(html).not.toContain("この条件は配信条件では");
    expect(html).not.toMatch(/legacy/i);
    // 閲覧者には消すボタンを出さない
    const ro = renderToStaticMarkup(createElement(ConditionRow, { cond, onChange: () => {}, onRemove: () => {}, ctx: ctx(false, true) }));
    expect(ro).toContain("この条件はオーディエンスでは使えなくなりました");
    expect(ro).not.toContain("この条件を消す");
  });
});
