/**
 * 配信条件の DSL(保存する形)と、管理画面の条件の木(オーディエンスの作成画面・エクスペリエンスの配信条件のフォーム)の相互変換と木の操作
 * (決定 49、設計書 §4.1.1・§12)。React に依存しない(単体テストで往復を確かめる)。値の検査は control が行い、ここは形の変換と表示の準備だけ。
 * ただし保存値は unknown として受け、変換の前に core の形と意味の検査を通す(通らない値・変換できない値は読み取り専用。plan ② P16)
 */
import { audienceDefinitionIssue, experimentTargetingIssue, hasNegatedForm, TargetingInputSchema, type TargetingLeaf } from "@wtt/core";
import type { PageMatchValue } from "./page-match";

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export type Dsl = Record<string, unknown>;
export type CondType = "url" | "path" | "host" | "query" | "device" | "browser" | "os" | "viewport" | "referrer" | "time" | "visited" | "goal" | "elapsed" | "audience";
type Base = { id: string; kind: "cond" };
/**
 * 画面の条件の行。否定は op の先頭の not(URL / パス / ホスト・クエリ・リファラー)か neg(端末など・閲覧・目標・オーディエンス)で持つ。
 * 閲覧・目標の within は null = 期間の指定なし(明示的に選んだときだけ)、数値 = 日数の欄の値のまま(空欄は NaN。保存の前の確認で止める)
 */
export type Cond = Base &
  (
    | { type: "url" | "path" | "host"; op: string; value: string }
    | { type: "query"; name: string; op: "equals" | "contains" | "notEquals" | "exists" | "notExists"; value: string }
    | { type: "device" | "browser" | "os"; neg: boolean; values: string[] }
    | { type: "viewport"; op: "gte" | "lt" | "between"; min: number; max: number }
    | { type: "referrer"; op: "contains" | "equals" | "notContains" | "isEmpty" | "notEmpty"; value: string }
    | { type: "time"; days: Weekday[]; allDay: boolean; from: number; to: number }
    | { type: "visited"; neg: boolean; page: PageMatchValue; min: number; within: number | null }
    | { type: "goal"; neg: boolean; goal: string; within: number | null }
    | { type: "elapsed"; op: "gte" | "lt"; n: number; unit: "hours" | "days" }
    | { type: "audience"; neg: boolean; audience: string }
  );
export type Group = { id: string; kind: "group"; logic: "and" | "or"; exclude: boolean; collapsed: boolean; copiedFrom?: string; children: TreeNode[] };
export type TreeNode = Cond | Group;

/** 肯定の形で使える一致の仕方(設計書 §4.1.1 の表) */
const POSITIVE: Record<"url" | "path" | "host", readonly string[]> = { url: ["contains", "equals", "startsWith"], path: ["contains", "equals", "startsWith", "regex"], host: ["equals", "endsWith", "contains", "regex"] };
/**
 * 否定の形を持つ一致の仕方か。表を写さず core の hasNegatedForm に聞く(設計書 §4.1.1 の対応表の正は core 1 か所。
 * url: contains / equals、path: contains / equals / regex、host: equals / regex)
 */
const hasNegated = (ctx: "url" | "path" | "host", op: string): boolean => hasNegatedForm({ ctx, op, value: "" } as unknown as TargetingLeaf);

const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** 時刻(0〜24)の表記。曜日と時間帯の条件の保存形(`HH:00`)と画面の表示で共通 */
export const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const hourOf = (s: unknown): number | null => (typeof s === "string" && /^\d{2}:00$/.test(s) ? Number(s.slice(0, 2)) : null);
const wrapNot = (neg: boolean, n: Dsl): Dsl => (neg ? { not: n } : n);

/** 画面で足した条件・グループの id(画面の中だけで使う。保存しない) */
let seq = 0;
export const newId = (): string => `n${Date.now().toString(36)}${(++seq).toString(36)}`;

export function condToDsl(c: Cond): Dsl {
  switch (c.type) {
    case "url":
    case "path":
    case "host": {
      const neg = c.op.startsWith("not");
      return wrapNot(neg, { ctx: c.type, op: neg ? lc(c.op.slice(3)) : c.op, value: c.value });
    }
    case "query":
      if (c.op === "exists") return { ctx: "query", name: c.name, op: "exists" };
      if (c.op === "notExists") return { not: { ctx: "query", name: c.name, op: "exists" } };
      if (c.op === "notEquals") return { not: { ctx: "query", name: c.name, op: "equals", value: c.value } };
      return { ctx: "query", name: c.name, op: c.op, value: c.value };
    case "device":
    case "browser":
    case "os":
      return wrapNot(c.neg, { ctx: c.type, op: "in", value: c.values });
    case "viewport":
      return { ctx: "viewport", ...(c.op !== "lt" ? { minWidth: c.min } : {}), ...(c.op !== "gte" ? { maxWidth: c.max } : {}) };
    case "referrer":
      if (c.op === "isEmpty") return { ctx: "referrer", op: "isEmpty" };
      if (c.op === "notEmpty") return { not: { ctx: "referrer", op: "isEmpty" } };
      if (c.op === "notContains") return { not: { ctx: "referrer", op: "contains", value: c.value } };
      return { ctx: "referrer", op: c.op, value: c.value };
    case "time":
      return { ctx: "time", days: c.days, ...(c.allDay ? {} : { from: hh(c.from), to: hh(c.to) }) };
    case "visited": {
      const page = c.page.part === undefined || c.page.part === "url" ? { op: c.page.op, value: c.page.value } : { part: c.page.part, op: c.page.op, value: c.page.value };
      // 期間は「期間の指定なし」(null)を選んだときだけ省く(日数の欄の空欄・0 などで黙って期間を落とさない)
      return wrapNot(c.neg, { hist: "visited", page, ...(!c.neg && c.min > 1 ? { min: c.min } : {}), ...(c.within !== null ? { withinDays: c.within } : {}) });
    }
    case "goal":
      return wrapNot(c.neg, { hist: "converted", goal: c.goal, ...(c.within !== null ? { withinDays: c.within } : {}) });
    case "elapsed":
      return { ctx: "sinceFirstVisit", op: c.op, [c.unit]: c.n };
    case "audience":
      return wrapNot(c.neg, { audience: c.audience });
  }
}

/** DSL の 1 つの条件(または否定の形を持つ条件の not)を行にする。行で表せなければ null(グループ・否定の形を持たない条件の not・知らない形・オブジェクトでない値) */
export function condFromDsl(raw: unknown, id: string = newId()): Cond | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const d = raw as Dsl;
  const neg = "not" in d;
  const x = (neg ? d.not : d) as Dsl;
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  if (typeof x.audience === "string") return { id, kind: "cond", type: "audience", neg, audience: x.audience };
  if (x.hist === "converted" && typeof x.goal === "string") return { id, kind: "cond", type: "goal", neg, goal: x.goal, within: typeof x.withinDays === "number" ? x.withinDays : null };
  if (x.hist === "visited" && typeof x.page === "object" && x.page !== null) {
    if (neg && x.min !== undefined) return null;
    return { id, kind: "cond", type: "visited", neg, page: { ...(x.page as PageMatchValue) }, min: typeof x.min === "number" ? x.min : 1, within: typeof x.withinDays === "number" ? x.withinDays : null };
  }
  switch (x.ctx) {
    case "url":
    case "path":
    case "host": {
      const op = String(x.op);
      if (!(neg ? hasNegated(x.ctx, op) : POSITIVE[x.ctx].includes(op)) || typeof x.value !== "string") return null;
      return { id, kind: "cond", type: x.ctx, op: neg ? `not${op.charAt(0).toUpperCase()}${op.slice(1)}` : op, value: x.value };
    }
    case "query": {
      if (typeof x.name !== "string") return null;
      if (x.op === "exists") return { id, kind: "cond", type: "query", name: x.name, op: neg ? "notExists" : "exists", value: "" };
      if (typeof x.value !== "string") return null;
      if (x.op === "equals") return { id, kind: "cond", type: "query", name: x.name, op: neg ? "notEquals" : "equals", value: x.value };
      return x.op === "contains" && !neg ? { id, kind: "cond", type: "query", name: x.name, op: "contains", value: x.value } : null;
    }
    case "device":
    case "browser":
    case "os":
      return Array.isArray(x.value) ? { id, kind: "cond", type: x.ctx, neg, values: x.value.map(String) } : null;
    case "referrer":
      if (x.op === "isEmpty") return { id, kind: "cond", type: "referrer", op: neg ? "notEmpty" : "isEmpty", value: "" };
      if (typeof x.value !== "string") return null;
      if (x.op === "contains") return { id, kind: "cond", type: "referrer", op: neg ? "notContains" : "contains", value: x.value };
      return x.op === "equals" && !neg ? { id, kind: "cond", type: "referrer", op: "equals", value: x.value } : null;
    case "viewport": {
      if (neg) return null;
      const min = typeof x.minWidth === "number" ? x.minWidth : undefined;
      const max = typeof x.maxWidth === "number" ? x.maxWidth : undefined;
      if (min === undefined && max === undefined) return null;
      return { id, kind: "cond", type: "viewport", op: min !== undefined && max !== undefined ? "between" : min !== undefined ? "gte" : "lt", min: min ?? 768, max: max ?? 1024 };
    }
    case "time": {
      if (neg || !Array.isArray(x.days)) return null;
      const from = hourOf(x.from);
      const to = hourOf(x.to);
      return { id, kind: "cond", type: "time", days: x.days as Weekday[], allDay: from === null || to === null, from: from ?? 9, to: to ?? 18 };
    }
    case "sinceFirstVisit": {
      if (neg || (x.op !== "gte" && x.op !== "lt")) return null;
      const unit = typeof x.hours === "number" ? "hours" : "days";
      const n = (x[unit] as number | undefined) ?? NaN;
      return Number.isFinite(n) ? { id, kind: "cond", type: "elapsed", op: x.op, n, unit } : null;
    }
  }
  return null;
}

/** 木 → DSL。空のグループは消え、子が 1 つのグループは畳む(control の保存時の正規化と同じ)。条件が 1 つも無ければ null(= 全員) */
export function toDsl(node: TreeNode): Dsl | null {
  if (node.kind === "cond") return condToDsl(node);
  const kids = node.children.map(toDsl).filter((k): k is Dsl => k !== null);
  if (kids.length === 0) return null;
  const n = kids.length === 1 ? kids[0]! : { [node.logic]: kids };
  if (!node.exclude) return n;
  return "not" in n ? (n.not as Dsl) : { not: n }; // not(not(x)) = x(control と同じ)
}

const isGroupDsl = (d: Dsl): boolean => Array.isArray(d.and) || Array.isArray(d.or);

/**
 * 保存値が core の保存する形の検査(形 = TargetingInputSchema、意味 = experimentTargetingIssue / audienceDefinitionIssue)を通れば Dsl、
 * 通らなければ null(スカラー・入れ子の null・未知のフィールド・不完全なページの一致・古い書式・上限を超える入れ子など。plan ② P16)
 */
function storedDsl(raw: unknown, kind: "experiment" | "audience"): Dsl | null {
  const p = TargetingInputSchema.safeParse(raw);
  if (!p.success) return null;
  const issue = kind === "experiment" ? experimentTargetingIssue(p.data) : audienceDefinitionIssue(p.data);
  return issue ? null : (p.data as unknown as Dsl);
}

/** オーディエンスの作成画面: 保存値 → 木(一番外側は必ずグループ。null = 新規の空の木)。core の検査を通らない・表せない・変換できない値は null */
export function audienceTreeFromDsl(raw: unknown): Group | null {
  let n = 0;
  const ids = () => `t${++n}`; // サーバーの描画とブラウザで同じ id になるよう、変換ごとに 1 から振る
  const group = (logic: "and" | "or", exclude: boolean, children: TreeNode[]): Group => ({ id: ids(), kind: "group", logic, exclude, collapsed: false, children });
  const node = (x: Dsl): TreeNode | null => {
    if (isGroupDsl(x)) {
      const logic = Array.isArray(x.and) ? "and" : "or";
      const kids = (x[logic] as Dsl[]).map(node);
      return kids.every((k) => k !== null) ? group(logic, false, kids as TreeNode[]) : null;
    }
    const c = condFromDsl(x, ids());
    if (c) return c;
    if (!("not" in x)) return null;
    // 否定の形を持たない条件・グループの not は「除外したグループ」として開く(設計書 §4.1.1)
    const g = node(x.not as Dsl);
    if (g === null) return null;
    return g.kind === "group" && !g.exclude ? { ...g, exclude: true } : group("and", true, [g]);
  };
  if (raw === null) return group("and", false, []);
  const d = storedDsl(raw, "audience");
  if (d === null) return null;
  try {
    const top = node(d);
    if (top === null) return null;
    return top.kind === "group" && !top.exclude ? top : group("and", false, [top]);
  } catch {
    return null; // 変換で例外が出る値も読み取り専用にする(画面を落とさない。設計書 §6.4)
  }
}

/** エクスペリエンスの配信条件のフォーム(1 段の and / or。設計書 §4.2)。null = 配信条件なし。core の検査を通らない・表せない・変換できない値は null */
export type ExperimentForm = { logic: "and" | "or"; rows: Cond[] };
export function experimentFormFromDsl(raw: unknown): ExperimentForm | null {
  if (raw === null) return { logic: "and", rows: [] };
  const d = storedDsl(raw, "experiment");
  if (d === null) return null;
  let n = 0;
  const id = () => `r${++n}`;
  try {
    if (isGroupDsl(d)) {
      const logic = Array.isArray(d.and) ? "and" : "or";
      const rows = (d[logic] as Dsl[]).map((x) => condFromDsl(x, id()));
      return rows.every((r) => r !== null) ? { logic, rows: rows as Cond[] } : null;
    }
    const c = condFromDsl(d, id());
    return c ? { logic: "and", rows: [c] } : null;
  } catch {
    return null; // 変換で例外が出る値も読み取り専用にする(画面を落とさない。設計書 §6.4)
  }
}
export function experimentFormToDsl(f: ExperimentForm): Dsl | null {
  return toDsl({ id: "root", kind: "group", logic: f.logic, exclude: false, collapsed: false, children: f.rows });
}
/** オーディエンスの PATCH / POST の body の definition。tree が null(画面で表せない保存値 = 読み取り専用)なら送らない(名前と説明の保存を止めない。plan ② P16) */
export function definitionBody(tree: Group | null): { definition?: Dsl | null } {
  return tree === null ? {} : { definition: toDsl(tree) };
}

// ----- 木の操作(画面の state は木をまるごと持ち、操作は複製に対して行う) -----

export function findNode(root: Group, id: string): TreeNode | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    if (c.id === id) return c;
    if (c.kind === "group") {
      const r = findNode(c, id);
      if (r) return r;
    }
  }
  return null;
}
export function findParent(root: Group, id: string): { parent: Group; index: number } | null {
  const i = root.children.findIndex((c) => c.id === id);
  if (i >= 0) return { parent: root, index: i };
  for (const c of root.children)
    if (c.kind === "group") {
      const r = findParent(c, id);
      if (r) return r;
    }
  return null;
}
/** グループの段数(一番外側 = 1)。一番外側の中の入れ子 = この値 - 1 */
export const nestLevels = (n: TreeNode): number => (n.kind === "cond" ? 0 : 1 + Math.max(0, ...n.children.map(nestLevels)));
/** そのノードが一番外側から何段目か(一番外側 = 0) */
export function levelOf(root: Group, id: string): number {
  let level = 0;
  let p = findParent(root, id);
  while (p) {
    level += 1;
    p = findParent(root, p.parent.id);
  }
  return level;
}
export const AUDIENCE_NEST_MAX = 4;
const overNestLimit = (root: Group): boolean => nestLevels(root) - 1 > AUDIENCE_NEST_MAX;

/** 複製に mutate を当て、入れ子の上限を超えたら null(画面は操作を取り消して知らせる) */
export function edit(root: Group, mutate: (copy: Group) => void): Group | null {
  const copy = structuredClone(root);
  mutate(copy);
  return overNestLimit(copy) ? null : copy;
}
/** id のノードを targetGroupId の index の位置へ移す(index = 移動元を削除する前の位置。省略 = 末尾)。自分の中には移せない */
export function moveNode(copy: Group, id: string, targetGroupId: string, index?: number): void {
  const node = findNode(copy, id);
  const target = findNode(copy, targetGroupId);
  if (!node || !target || target.kind !== "group" || node === target) return;
  if (node.kind === "group" && findNode(node, targetGroupId)) return;
  const from = findParent(copy, id);
  if (!from) return;
  // 位置は移動元を削除する前の長さで求め、同じ親で前から動かすときだけ 1 つ詰める(末尾への移動を二重に補正しない)
  let i = index ?? target.children.length;
  if (from.parent === target && from.index < i) i -= 1;
  from.parent.children.splice(from.index, 1);
  target.children.splice(i, 0, node);
}
export function insertNode(copy: Group, targetGroupId: string, node: TreeNode, index?: number): void {
  const target = findNode(copy, targetGroupId);
  if (!target || target.kind !== "group") return;
  target.children.splice(index ?? target.children.length, 0, node);
}
export function removeNode(copy: Group, id: string): void {
  const p = findParent(copy, id);
  if (p) p.parent.children.splice(p.index, 1);
}
/** 取り込み用の複製(id を振り直す) */
export function cloneFresh(n: TreeNode): TreeNode {
  return n.kind === "cond" ? { ...structuredClone(n), id: newId() } : { ...n, id: newId(), children: n.children.map(cloneFresh) };
}
/** アクセシビリティ設定の「移動先」の候補: 今の親・自分の中を除き、入れ子の上限を超えないグループ */
export function moveTargets(root: Group, id: string, label: (g: Group, level: number) => string): Array<{ id: string; label: string }> {
  const node = findNode(root, id);
  const from = findParent(root, id);
  if (!node || !from) return [];
  const sub = node.kind === "group" ? nestLevels(node) : 0;
  const out: Array<{ id: string; label: string }> = [];
  const walk = (g: Group, level: number) => {
    const inside = node.kind === "group" && findNode(node, g.id) !== null;
    if (!inside && g !== from.parent && level + sub <= AUDIENCE_NEST_MAX) out.push({ id: g.id, label: label(g, level) });
    for (const c of g.children) if (c.kind === "group") walk(c, level + 1);
  };
  walk(root, 0);
  return out;
}
/** 1 段のリストの並べ替え: from の要素を to の要素の前へ(to = 長さなら末尾へ) */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, moved!);
  return next;
}
