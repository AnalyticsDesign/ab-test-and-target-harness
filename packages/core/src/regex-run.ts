/**
 * 正規表現の照合器(Pike VM)。zod を使わない(runtime が import する)。
 * 命令列(RegexProgram)は Publish 時に control が regex-compile.ts で作る。ここは読んで照合するだけ。
 * 契約: 許可リストの範囲の式から作った命令列について、`new RegExp(src).test(input)`(フラグ無し)と同じ真偽を返す。
 * 時間は O(入力の長さ × 命令数)。バックトラックしない(決定 49、設計書 §10.3)
 */

/** 命令列の形式の版(compiled config の `prog.v`)。形式を変えたら上げる(パターン ID のハッシュには入らない) */
export const REGEX_PROGRAM_VERSION = 1;
/** 照合する側の上限(設計書 §10.2)。変換器の上限(regex-compile.ts の REGEX_LIMITS)も同じ値を使う */
export const REGEX_RUN_LIMITS = { instructions: 200, pathMax: 256, hostMax: 253 } as const;

/** 命令は code の 3 要素 1 組 = [op, a, b] */
export const OP_CHAR = 0; // a = sets の添字。1 文字を消費する
export const OP_SPLIT = 1; // a, b = 飛び先(両方へ進む)
export const OP_JMP = 2; // a = 飛び先
export const OP_BOL = 3; // ^(位置 0 のときだけ進む)
export const OP_EOL = 4; // $(末尾のときだけ進む)
export const OP_MATCH = 5;

/** sets の各要素は ASCII 128 文字のビット列 = 32 bit 整数 4 つ(文字コード c は [c >> 5] の (c & 31) ビット目) */
export type RegexProgram = { v: number; sets: number[][]; code: number[] };

/**
 * 読み込み時の整合の検査(形式の版・命令の種類・飛び先・集合の添字の範囲・命令数)。不正なら照合しない(呼び手は対象外にする)。
 * `x >>> 0 === x` は「0 以上 2^32 未満の整数」の判定(数値でない・小数・負数を落とす)
 */
export function isValidProgram(p: RegexProgram, maxInstructions: number = REGEX_RUN_LIMITS.instructions): boolean {
  const sets = p?.sets;
  const code = p?.code;
  if (p?.v !== REGEX_PROGRAM_VERSION || !Array.isArray(sets) || !Array.isArray(code)) return false;
  const n = code.length / 3;
  if (!(n >= 1 && n <= maxInstructions && n % 1 === 0)) return false;
  for (const w of sets) if (!Array.isArray(w) || w.length !== 4 || w.some((x) => x >>> 0 !== x)) return false;
  for (let i = 0; i < code.length; i += 3) {
    const [op, a, b] = [code[i]!, code[i + 1]!, code[i + 2]!];
    // a の上限: CHAR = 集合の数、SPLIT / JMP = 命令数、BOL / EOL / MATCH = 見ない。未知の op は -1(必ず不正)
    const limit = op === OP_CHAR ? sets.length : op === OP_SPLIT || op === OP_JMP ? n : op === OP_BOL || op === OP_EOL || op === OP_MATCH ? Infinity : -1;
    if (a >>> 0 !== a || b >>> 0 !== b || !(a < limit) || (op === OP_SPLIT && !(b < n))) return false;
    // CHAR / BOL / EOL は次の命令へ進むので、次の命令(位置 + 1)が命令列の中にあること(最後の命令が CHAR / BOL / EOL なら不正)
    if ((op === OP_CHAR || op === OP_BOL || op === OP_EOL) && !(i / 3 + 1 < n)) return false;
  }
  return true;
}

/**
 * 部分一致の照合。true / false。命令列が不正、または入力に ASCII 以外の文字があれば null(判定できない = 呼び手は対象外にする)。
 * 照合の対象はパス(percent-encoding のまま)とホスト(punycode)なので、URL の解析を経た入力に ASCII 以外は現れない
 */
export function runProgram(p: RegexProgram, input: string, maxInstructions: number = REGEX_RUN_LIMITS.instructions): boolean | null {
  if (!isValidProgram(p, maxInstructions) || /[^\x00-\x7f]/.test(input)) return null;
  const code = p.code;
  const sets = p.sets;
  const len = input.length;
  const n = code.length / 3;
  const mark = new Int32Array(n); // 世代番号で状態の重複を除く(0 = 未訪問)
  let cur: number[] = [];
  let next: number[] = [];
  let gen = 1;
  let found = false;
  // 防御: 命令列の外・未知の op に着いたら照合を打ち切り、照合の後で null を返す(isValidProgram を通った命令列では起きない)
  let broken = false;
  const stack: number[] = [];
  // pc から ε 遷移でたどれる状態を list に足す(残すのは CHAR だけ)。MATCH に着いたら found
  const add = (list: number[], pc: number, pos: number): void => {
    stack.push(pc);
    while (stack.length > 0) {
      const q = stack.pop()!;
      if (!(q < n)) {
        broken = true;
        stack.length = 0;
        return;
      }
      if (mark[q] === gen) continue;
      mark[q] = gen;
      const op = code[q * 3];
      if (op === OP_CHAR) list.push(q);
      else if (op === OP_MATCH) found = true;
      else if (op === OP_JMP) stack.push(code[q * 3 + 1]!);
      else if (op === OP_SPLIT) stack.push(code[q * 3 + 2]!, code[q * 3 + 1]!);
      else if (op === OP_BOL || op === OP_EOL) {
        if (op === OP_BOL ? pos === 0 : pos === len) stack.push(q + 1);
      } else {
        broken = true;
        stack.length = 0;
        return;
      }
    }
  };
  add(cur, 0, 0);
  for (let i = 0; ; i++) {
    if (broken) return null;
    if (found) return true;
    if (i === len) return false;
    const ch = input.charCodeAt(i);
    gen++;
    next.length = 0;
    for (const q of cur) {
      const s = sets[code[q * 3 + 1]!]!;
      if ((s[ch >> 5]! >>> (ch & 31)) & 1) add(next, q + 1, i + 1);
    }
    add(next, 0, i + 1); // 部分一致: 各位置で開始状態を足す(開始位置ごとのやり直しはしない)
    [cur, next] = [next, cur];
  }
}
