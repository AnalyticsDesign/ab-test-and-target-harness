import type { Audience } from "./types";
import { audienceTreeFromDsl, definitionBody, toDsl, type Group } from "./targeting-tree";

/**
 * オーディエンスの編集画面の下書き(B173 第 2 段 S2-1)。エクスペリエンスの lib/experiment-draft.ts と同じ決まりで、
 * 保存は自分が変えた欄だけを送り(開いた後にほかの人が変えた欄を上書きしない)、新しいサーバーの値が届いたときは
 * 未保存の変更が無ければその値に入れ替え、あれば下書きを残して注記を出す。
 * 条件は、画面で表せるもの(tree。dsl は toDsl の形で、条件の木のノードの id は入らない。null = 表せるが空)と、
 * 画面で表せない定義(raw。古い書式など。読み取り専用で、保存では送らない。plan ② P16)を型で分ける
 */
export type AudienceCondition = { kind: "tree"; dsl: unknown | null } | { kind: "raw" };

export type AudienceDraft = {
  name: string;
  description: string;
  condition: AudienceCondition;
  /** 画面で条件を編集できるか(condition.kind === "tree")。その下書きを作ったときの定義で決まる */
  editable: boolean;
  /** サーバーの定義が同じかを見る鍵(tree と raw は前置きで分け、raw どうしも定義の JSON で見分ける) */
  definitionKey: string;
  /** 新規の画面で手で直した ID。既存の画面では null(ID だけ直しても未保存にする。レビューの M8) */
  manualId: string | null;
};

/** キーの順をそろえた JSON(raw の定義の鍵。同じ定義なら同じ文字列) */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const treeKey = (dsl: unknown | null) => `tree:${stableJson(dsl)}`;
const rawKey = (definition: unknown) => `raw:${stableJson(definition)}`;

/** サーバーの値(または新規の空の値)から下書きを作る。表せるかは definition から決める(audienceTreeFromDsl が null なら raw) */
export function audienceDraftOf(a: Pick<Audience, "name" | "description" | "definition">): AudienceDraft {
  const t = audienceTreeFromDsl(a.definition);
  const condition: AudienceCondition = t ? { kind: "tree", dsl: toDsl(t) } : { kind: "raw" };
  return {
    name: a.name,
    description: a.description ?? "",
    condition,
    editable: t !== null,
    definitionKey: t ? treeKey(toDsl(t)) : rawKey(a.definition),
    manualId: null,
  };
}

/**
 * 画面の入力から今の下書きを作る。raw の下書き(画面で条件を変えられない)は、その下書きを作ったときの鍵を raw で受ける。
 * tree の下書きは木を toDsl で保存される形にする(開閉・ノードの id は鍵に出ない)
 */
export function audienceInputDraft(input: { name: string; description: string; manualId: string | null; tree: Group; raw: { definitionKey: string } | null }): AudienceDraft {
  const { name, description, manualId, tree, raw } = input;
  if (raw) return { name, description, condition: { kind: "raw" }, editable: false, definitionKey: raw.definitionKey, manualId };
  const dsl = toDsl(tree);
  return { name, description, condition: { kind: "tree", dsl }, editable: true, definitionKey: treeKey(dsl), manualId };
}

/** 2 つの下書きが同じか(名前・メモ・定義の鍵・手で直した ID)。editable は比べない(同じ鍵なら同じ定義) */
const sameDraft = (a: AudienceDraft, b: AudienceDraft) =>
  a.name === b.name && a.description === b.description && a.definitionKey === b.definitionKey && a.manualId === b.manualId;

/** 未保存の変更があるか(基準と今の下書きを比べる) */
export function isAudienceDirty(base: AudienceDraft, draft: AudienceDraft): boolean {
  return !sameDraft(base, draft);
}

/**
 * PATCH の body。自分が変えた欄だけを載せる。定義は鍵が違い、かつ下書きが編集できる(canSendDefinition)ときだけ、
 * 今の木から definitionBody で組み立てる(raw の下書きは definition を送らない)
 */
export function audiencePatchBody(input: { base: AudienceDraft; draft: AudienceDraft; root: Group | null; canSendDefinition: boolean }): Record<string, unknown> {
  const { base, draft, root, canSendDefinition } = input;
  const body: Record<string, unknown> = {};
  if (base.name !== draft.name) body.name = draft.name;
  if (base.description !== draft.description) body.description = draft.description;
  if (base.definitionKey !== draft.definitionKey && canSendDefinition) Object.assign(body, definitionBody(root));
  return body;
}

/**
 * 新しいサーバーの値が届いたときの基準(base)と下書き(draft)の決め方(エクスペリエンスの reconcileServerUpdate と同じ)。
 * 未保存の変更が無ければ server に入れ替える(自分の保存の後もこれ)。あれば base と draft を残し、届いた値が基準と違えば注記を出す
 */
export function reconcileAudienceUpdate(input: { base: AudienceDraft; draft: AudienceDraft; server: AudienceDraft }): { base: AudienceDraft; draft: AudienceDraft; notice: boolean } {
  const { base, draft, server } = input;
  if (sameDraft(base, draft)) return { base: server, draft: server, notice: false };
  return { base, draft, notice: !sameDraft(base, server) };
}

/** サーバーの値の鍵(updatedAt と名前・メモ・定義。updatedAt が無い・進まない更新でも気づくため) */
export function audienceServerKey(a: Audience): string {
  return `${a.updatedAt}:${JSON.stringify([a.name, a.description, a.definition])}`;
}

/** 画面が下書きを作る元の値(サーバーの値・保存の応答・新規の空の値) */
export type AudienceValue = Pick<Audience, "name" | "description" | "definition">;

/** 自分の保存で最後に確かめた保存済みの値(PATCH の応答)と、そのときの props の鍵。まだ保存していなければ null */
export type SavedAudience = { serverKey: string; value: AudienceValue } | null;

/**
 * 破棄で戻す値(最終レビュー I3)。自分の保存の後に props がまだ変わっていない(読み直しが時間切れ・届いていない)なら、
 * 保存の応答(サーバーに保存されている値)へ戻す。props が新しい値に変わったら(鍵が違えば)、そちらが勝つ
 */
export function audienceDiscardTarget(input: { server: AudienceValue; serverKey: string; saved: SavedAudience }): AudienceValue {
  const { server, serverKey, saved } = input;
  return saved !== null && saved.serverKey === serverKey ? saved.value : server;
}
