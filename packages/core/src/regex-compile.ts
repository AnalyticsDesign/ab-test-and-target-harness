/**
 * 正規表現の許可リストの検査と、命令列(RegexProgram)への変換(決定 49、設計書 §10.2 / §10.3)。
 * control(保存時の検査・Publish の compile)・fixture・管理画面の試す欄が使う。runtime には入れない(runtime は照合器だけ)。
 * 許可する書き方: ASCII の文字・記号のエスケープ・`.`・`[...]` / `[^...]`・`\d \w \s`・`^ $`・`( )` `(?: )` `|`・`? * + {n} {n,m}`。
 * それ以外(後方参照・先読み・名前付きグループ・修飾子・その他のエスケープ・上限の無い `{n,}`・最短一致・Annex B の曖昧な書き方)は拒否する
 */
import { OP_BOL, OP_CHAR, OP_EOL, OP_JMP, OP_MATCH, OP_SPLIT, REGEX_PROGRAM_VERSION, REGEX_RUN_LIMITS, type RegexProgram } from "./regex-run";

export const REGEX_LIMITS = {
  sourceMax: 200, // 式の長さ(今の regexMax と同じ)
  repeatMax: 100, // {n,m} の m
  instructionsPerRegex: REGEX_RUN_LIMITS.instructions, // 1 つの正規表現の命令数(最後の MATCH を含む)
  instructionsPerSite: 500, // 配る設定に入るすべての正規表現の命令数の合計
} as const;

export type RegexIssueCode =
  | "regex_too_long"
  | "regex_syntax"
  | "regex_non_ascii"
  | "regex_unsupported_escape"
  | "regex_unsupported_group"
  | "regex_unbounded_repeat"
  | "regex_lazy_quantifier"
  | "regex_ambiguous"
  | "regex_repeat_too_large"
  | "regex_too_large"
  | "regex_not_allowed_on_url";

/**
 * 理由のコード・日本語の説明(何がだめで、どう書き換えるか)・位置(式の中の 0 始まりの文字位置と長さ)・書き換えの例。
 * 画面(入力欄の下)・API の 422・エージェントで同じものを出す(設計書 §10.4)
 */
export type RegexIssue = { code: RegexIssueCode; message: string; index: number; length: number; example?: string };

type Bits = [number, number, number, number];
type Node =
  | { t: "set"; bits: Bits }
  | { t: "bol" }
  | { t: "eol" }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "rep"; node: Node; min: number; max: number }; // max = -1 は上限なし(`*` と `+` だけが作る)

/** エスケープして書ける記号(設計書 §10.2 の表) */
const SYMBOL_ESCAPES = "./-?*+()[]{}|^$\\";

const emptyBits = (): Bits => [0, 0, 0, 0];
function addCode(b: Bits, c: number): void {
  b[c >> 5] = (b[c >> 5]! | (1 << (c & 31))) >>> 0;
}
function addRange(b: Bits, lo: number, hi: number): void {
  for (let c = lo; c <= hi; c++) addCode(b, c);
}
function orBits(a: Bits, b: Bits): void {
  for (let i = 0; i < 4; i++) a[i] = (a[i]! | b[i]!) >>> 0;
}
const notBits = (a: Bits): Bits => a.map((w) => ~w >>> 0) as Bits;
function classBits(k: "d" | "w" | "s"): Bits {
  const b = emptyBits();
  if (k === "d") addRange(b, 48, 57);
  if (k === "w") {
    addRange(b, 48, 57);
    addRange(b, 65, 90);
    addRange(b, 97, 122);
    addCode(b, 95);
  }
  if (k === "s") {
    addRange(b, 9, 13);
    addCode(b, 32);
  }
  return b;
}
/** `.` は行終端(ASCII では \n と \r)以外のすべて */
function dotBits(): Bits {
  const b = notBits(emptyBits());
  b[0] = (b[0]! & ~((1 << 10) | (1 << 13))) >>> 0;
  return b;
}

/**
 * 日本語の入力環境の円記号・全角を置き換える(1 文字を 1 文字に。設計書 §10.4 の 4)。
 * ¥(U+00A5)・￥(U+FFE5)→ `\`、全角の英数字・記号(U+FF01〜U+FF5E)→ 半角、全角スペース → 半角。保存前・検査前に必ず通す
 */
export function normalizeRegexInput(src: string): string {
  let out = "";
  for (const ch of src) {
    const c = ch.codePointAt(0)!;
    if (c === 0xa5 || c === 0xffe5) out += "\\";
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else if (c === 0x3000) out += " ";
    else out += ch;
  }
  return out;
}

class Fail {
  constructor(public issue: RegexIssue) {}
}

function parse(src: string): Node {
  let i = 0;
  const fail = (code: RegexIssueCode, message: string, index: number, length: number, example?: string): never => {
    throw new Fail({ code, message, index, length, ...(example !== undefined ? { example } : {}) });
  };

  function parseAlt(): Node {
    const items = [parseCat()];
    while (src[i] === "|") {
      i++;
      items.push(parseCat());
    }
    return items.length === 1 ? items[0]! : { t: "alt", items };
  }

  function parseCat(): Node {
    const start = i;
    const items: Node[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") items.push(parseRepeat());
    // 空の選択肢(`(a|)` `a||b` `|a`)。空のグループ `()` は parseAtom が先に止める
    if (items.length === 0) fail("regex_ambiguous", "空の選択肢は使えません。`(a|)` は `a?` のように書きます", start, 1, "a?");
    return items.length === 1 ? items[0]! : { t: "cat", items };
  }

  function parseRepeat(): Node {
    const atom = parseAtom();
    const c = src[i];
    const qStart = i;
    let min: number;
    let max: number;
    if (c === "*" || c === "+" || c === "?") {
      i++;
      [min, max] = c === "*" ? [0, -1] : c === "+" ? [1, -1] : [0, 1];
    } else if (c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(src.slice(i));
      if (!m) return fail("regex_ambiguous", "`{` は繰り返しの `{n}` / `{n,m}` 以外では `\\{` と書きます", i, 1, "\\{");
      if (m[1] === "") return fail("regex_ambiguous", "`{,m}` は使えません。`{0,m}` と書きます", i, m[0].length, "{0,5}");
      if (m[2] === ",") {
        if (m[3] === "") return fail("regex_unbounded_repeat", `上限の無い \`${m[0]}\` は使えません。\`+\` か \`{${m[1]},10}\` のように書きます`, i, m[0].length, `{${m[1]},10}`);
        [min, max] = [Number(m[1]), Number(m[3])];
      } else {
        min = max = Number(m[1]);
      }
      if (min > max) return fail("regex_syntax", "`{n,m}` は n ≦ m にします", i, m[0].length);
      if (max > REGEX_LIMITS.repeatMax)
        // 例は下限を保つ形だけ(下限 0 は `*`、1 は `+`)。下限が 2 以上の `{n,m}` は `+` にすると下限が落ちて意味が変わるので例を出さない
        return fail("regex_repeat_too_large", `繰り返しの回数は ${REGEX_LIMITS.repeatMax} までです。大きな繰り返しは \`*\` か \`+\` に置き換えてください`, i, m[0].length, min === 0 ? "*" : min === 1 ? "+" : undefined);
      i += m[0].length;
    } else {
      return atom;
    }
    if (atom.t === "bol" || atom.t === "eol") return fail("regex_syntax", "`^` と `$` には繰り返しを付けられません", qStart, 1);
    if (src[i] === "?") return fail("regex_lazy_quantifier", "最短一致(`*?` `+?` `??`)は使えません。部分一致なので `?` を外しても結果は同じです", i, 1);
    if (src[i] === "*" || src[i] === "+" || src[i] === "{") return fail("regex_syntax", "繰り返しを続けて書くことはできません", i, 1);
    return { t: "rep", node: atom, min, max };
  }

  function parseAtom(): Node {
    const c = src[i]!;
    if (c === "(") {
      const start = i;
      i++;
      if (src[i] === "?") {
        if (src[i + 1] !== ":") return fail("regex_unsupported_group", "先読み・後読み・名前付きグループ・修飾子は使えません。グループは `( )` か `(?: )` で書きます", start, 3, "(?:...)");
        i += 2;
      }
      if (src[i] === ")") return fail("regex_ambiguous", "空のグループ `()` は使えません", start, i - start + 1);
      const inner = parseAlt();
      if (src[i] !== ")") return fail("regex_syntax", "`(` に対応する `)` がありません", start, 1);
      i++;
      return inner;
    }
    if (c === ")") return fail("regex_syntax", "`)` に対応する `(` がありません", i, 1);
    if (c === "[") return parseClass();
    if (c === "]" || c === "}") return fail("regex_ambiguous", `\`${c}\` は \`\\${c}\` と書きます`, i, 1, `\\${c}`);
    if (c === "{") return fail("regex_ambiguous", "`{` は `\\{` と書きます(繰り返しの `{n}` は文字の後に書きます)", i, 1, "\\{");
    if (c === "*" || c === "+" || c === "?") return fail("regex_syntax", `\`${c}\` の前に繰り返す文字がありません。記号そのものは \`\\${c}\` と書きます`, i, 1, `\\${c}`);
    i++;
    if (c === "^") return { t: "bol" };
    if (c === "$") return { t: "eol" };
    if (c === ".") return { t: "set", bits: dotBits() };
    if (c === "\\") {
      i--;
      return { t: "set", bits: parseEscape().bits };
    }
    const b = emptyBits();
    addCode(b, c.charCodeAt(0));
    return { t: "set", bits: b };
  }

  /** `\` の位置から読む。`single` は 1 文字のエスケープ(記号)のときの文字コード、\d \w \s は null */
  function parseEscape(): { bits: Bits; single: number | null } {
    const start = i;
    const e = src[i + 1];
    if (e === undefined) return fail("regex_syntax", "末尾の `\\` の後に文字がありません", start, 1);
    i += 2;
    if (e === "d" || e === "w" || e === "s") return { bits: classBits(e), single: null };
    if (SYMBOL_ESCAPES.includes(e)) {
      const b = emptyBits();
      addCode(b, e.charCodeAt(0));
      return { bits: b, single: e.charCodeAt(0) };
    }
    return fail("regex_unsupported_escape", `\`\\${e}\` は使えません。使えるエスケープは \`\\d\` \`\\w\` \`\\s\` と記号(\`\\.\` \`\\/\` など)です`, start, 2);
  }

  /** `[...]`。範囲の端は 1 文字(エスケープした記号を含む)だけ。`-` そのものは先頭か末尾だけ */
  function parseClass(): Node {
    const start = i;
    i++;
    const negate = src[i] === "^";
    if (negate) i++;
    const bits = emptyBits();
    const bodyStart = i;
    let count = 0;
    for (;;) {
      if (i >= src.length) return fail("regex_syntax", "`[` に対応する `]` がありません", start, 1);
      if (src[i] === "]") break;
      const atomAt = i;
      let lo: { bits: Bits; single: number | null };
      if (src[i] === "\\") lo = parseEscape();
      else {
        const b = emptyBits();
        addCode(b, src.charCodeAt(i));
        lo = { bits: b, single: src.charCodeAt(i) };
        i++;
      }
      count++;
      if (src[i] === "-" && i + 1 < src.length && src[i + 1] !== "]") {
        // 範囲 a-z
        const dashAt = i;
        i++;
        let hi: { bits: Bits; single: number | null };
        if (src[i] === "\\") hi = parseEscape();
        else {
          hi = { bits: emptyBits(), single: src.charCodeAt(i) };
          i++;
        }
        if (lo.single === null || hi.single === null)
          return fail("regex_ambiguous", "範囲の端に `\\d` `\\w` `\\s` は使えません。`-` そのものは `\\-` と書きます", dashAt, 1, "\\-");
        if (lo.single > hi.single) return fail("regex_syntax", "範囲は小さい文字から大きい文字の順に書きます(例: `a-z`)", atomAt, i - atomAt);
        addRange(bits, lo.single, hi.single);
        continue;
      }
      // 先頭でも末尾でもない `-`(`[a-c-e]` など)
      if (lo.single === 45 && src[atomAt] === "-" && atomAt !== bodyStart && src[i] !== "]")
        return fail("regex_ambiguous", "`[...]` の途中の `-` は `\\-` と書きます", atomAt, 1, "\\-");
      orBits(bits, lo.bits);
    }
    if (count === 0) return fail("regex_ambiguous", "空の `[]` `[^]` は使えません", start, i - start + 1);
    i++;
    return { t: "set", bits: negate ? notBits(bits) : bits };
  }

  const node = parseAlt();
  if (i < src.length) fail("regex_syntax", "`)` に対応する `(` がありません", i, 1);
  return node;
}

/** 命令数の見積もり(emit が出す数と一致する)。cap を超えたら cap + 1 で打ち切る(巨大な表を作ってから拒否しない) */
function sizeOf(n: Node, cap: number): number {
  const clamp = (v: number): number => (v > cap ? cap + 1 : v);
  switch (n.t) {
    case "set":
    case "bol":
    case "eol":
      return 1;
    case "cat":
      return n.items.reduce((a, x) => clamp(a + sizeOf(x, cap)), 0);
    case "alt":
      return clamp(n.items.reduce((a, x) => clamp(a + sizeOf(x, cap)), 0) + 2 * (n.items.length - 1));
    case "rep": {
      const s = sizeOf(n.node, cap);
      if (n.max === -1) return clamp(n.min === 0 ? s + 2 : s + 1); // `*` = SPLIT + 本体 + JMP、`+` = 本体 + SPLIT
      return clamp(n.min * s + (n.max - n.min) * (s + 1)); // {n,m} = 本体 n 回 + (SPLIT + 本体) × (m - n)
    }
  }
}

function emit(n: Node, code: number[], setIndex: (b: Bits) => number): void {
  const pc = (): number => code.length / 3;
  const put = (op: number, a = 0, b = 0): number => {
    code.push(op, a, b);
    return pc() - 1;
  };
  switch (n.t) {
    case "set":
      put(OP_CHAR, setIndex(n.bits));
      return;
    case "bol":
      put(OP_BOL);
      return;
    case "eol":
      put(OP_EOL);
      return;
    case "cat":
      for (const x of n.items) emit(x, code, setIndex);
      return;
    case "alt": {
      // SPLIT L1, L2; L1: 選択肢 1; JMP end; L2: SPLIT ... ; 最後の選択肢は JMP 不要
      const jumps: number[] = [];
      n.items.forEach((x, k) => {
        if (k === n.items.length - 1) return emit(x, code, setIndex);
        const split = put(OP_SPLIT);
        code[split * 3 + 1] = pc();
        emit(x, code, setIndex);
        jumps.push(put(OP_JMP));
        code[split * 3 + 2] = pc();
      });
      for (const j of jumps) code[j * 3 + 1] = pc();
      return;
    }
    case "rep": {
      let lastStart = pc();
      for (let k = 0; k < n.min; k++) {
        lastStart = pc();
        emit(n.node, code, setIndex);
      }
      if (n.max === -1) {
        if (n.min === 0) {
          // L: SPLIT body, end; body; JMP L
          const split = put(OP_SPLIT);
          code[split * 3 + 1] = pc();
          emit(n.node, code, setIndex);
          put(OP_JMP, split);
          code[split * 3 + 2] = pc();
        } else {
          // `+`: 直前に出した本体の先頭へ戻るか、抜ける
          put(OP_SPLIT, lastStart, pc() + 1);
        }
        return;
      }
      // 残り (max - min) 回は省略できる: SPLIT body, end を並べる(どこからでも end へ抜けられる)
      const splits: number[] = [];
      for (let k = 0; k < n.max - n.min; k++) {
        const split = put(OP_SPLIT);
        code[split * 3 + 1] = pc();
        splits.push(split);
        emit(n.node, code, setIndex);
      }
      for (const s of splits) code[s * 3 + 2] = pc();
      return;
    }
  }
}

export type RegexCompileResult = { ok: true; prog: RegexProgram; instructions: number } | { ok: false; issue: RegexIssue };

/**
 * 許可リストの検査と変換。`src` は normalizeRegexInput を通した後の値(保存値)。
 * 命令数(最後の MATCH を含む)が instructionsPerRegex を超えたら regex_too_large(変換の前に見積もって止める)。
 * 同じ文字の集合は 1 つにまとめる
 */
export function compileRegex(src: string): RegexCompileResult {
  if (src.length === 0) return { ok: false, issue: { code: "regex_syntax", message: "正規表現が空です", index: 0, length: 0 } };
  if (src.length > REGEX_LIMITS.sourceMax)
    return { ok: false, issue: { code: "regex_too_long", message: `正規表現は ${REGEX_LIMITS.sourceMax} 字以内にします`, index: REGEX_LIMITS.sourceMax, length: src.length - REGEX_LIMITS.sourceMax } };
  for (let k = 0; k < src.length; k++) {
    const c = src.charCodeAt(k);
    if (c < 0x20 || c > 0x7e)
      return { ok: false, issue: { code: "regex_non_ascii", message: "使える文字は半角の英数字と記号だけです。パスの日本語は %E3%81%82 のようにエンコードした形で書きます", index: k, length: 1 } };
  }
  let node: Node;
  try {
    node = parse(src);
  } catch (e) {
    if (e instanceof Fail) return { ok: false, issue: e.issue };
    throw e;
  }
  const cap = REGEX_LIMITS.instructionsPerRegex;
  const size = sizeOf(node, cap) + 1; // + MATCH
  if (size > cap)
    return {
      ok: false,
      issue: {
        code: "regex_too_large",
        message: `この正規表現は大きすぎます(命令の数 ${size > cap + 1 ? `${cap} 超` : size} / ${cap})。\`{0,100}\` のような大きな繰り返しを \`*\` に置き換えてください`,
        index: 0,
        length: src.length,
        example: "*",
      },
    };
  const sets: number[][] = [];
  const keys = new Map<string, number>();
  const setIndex = (b: Bits): number => {
    const k = b.join(",");
    let ix = keys.get(k);
    if (ix === undefined) {
      ix = sets.length;
      sets.push([...b]);
      keys.set(k, ix);
    }
    return ix;
  };
  const code: number[] = [];
  emit(node, code, setIndex);
  code.push(OP_MATCH, 0, 0);
  return { ok: true, prog: { v: REGEX_PROGRAM_VERSION, sets, code }, instructions: code.length / 3 };
}
