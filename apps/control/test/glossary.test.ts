import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_MESSAGES } from "../src/errors";

/**
 * backlog B35 / 決定 54 (4)、K15: 利用者に見える文言(API の message / hint・既定の文言・OpenAPI の説明・core の compile が出す文言)を
 * 用語表に合わせる。経路(message: の直後・定数・return・三項演算子・組み立て関数)を問わず拾うため、コメントを除いたソースの
 * **日本語を含む文字列リテラル・テンプレートリテラルをすべて**見る。英語の識別子(experiment / variant / running …)は括弧書きで添えてよい
 */
const BANNED: Array<{ re: RegExp; use: string }> = [
  { re: /実験/, use: "エクスペリエンス" },
  { re: /\b(?:OWNER|ADMIN|EDITOR|VIEWER)\b/, use: "オーナー / 管理者 / 編集者 / 閲覧者" },
  { re: /Code Change/, use: "コードの変更" },
  { re: /未公開の変更/, use: "未公開の編集" },
  { re: /権限の上限/, use: "権限" },
  { re: /フル[(（の /]|「フル」/, use: "すべてのワークスペース" }, // 半角・全角の括弧の両方
  { re: /実行中のエクスペリエンス/, use: "配信中のエクスペリエンス" },
  { re: /\b(?:Site|Variant|Change) ID/, use: "サイト ID / パターン ID / 変更の ID" },
  { re: /ユーザーメニュー(?:の| ?→ ?)「(?:API キー|システム管理者|新しいワークスペース|ドラッグ)/, use: "ユーザーメニュー →「設定」→ …" },
  // 日本語の文の中の、大文字で始まる画面の語は単語として全面禁止(「Variant 2 つ以上」「Goal /」のように直後が数字・記号でも拾う。r2 CX-Medium-6)。
  // API の識別子は小文字・キャメルケース(variantId・`experiment`)なので当たらない。正当な使い方は ALLOW に理由付きで書く
  // 外部計測・訪問者 ID などに置き換える英語の画面の語(K13)。識別子(analytics・ab_exposure・exposureByVariant)は小文字始まり・語の途中なので当たらない
  { re: /\b(?:Analytics|Identity|Exposure|Conversion|Audience)\b/, use: "外部計測 / 訪問者 ID / 露出 / コンバージョン / オーディエンス" },
  { re: /\b(?:Workspace|Site|Variant|Change|Goal|Member|Role|Experiment|Publish|Start|Pause|Resume|Stop)\b/, use: "用語表の日本語" },
];
/** 画面の語ではない使い方(理由を書く)。file はキー(control/… / core/…)、re は BANNED の re と同じもの */
const ALLOW: Array<{ file: string; re: RegExp; why: string }> = [
  { file: "control/usage/fetch.ts", re: /\b(?:Analytics|Identity|Exposure|Conversion|Audience)\b/, why: "Cloudflare の API トークンの権限名 Account Analytics: Read(固有名。言い換えると利用者が Cloudflare の画面で探せない)" },
  { file: "control/usage/index.ts", re: /\b(?:Analytics|Identity|Exposure|Conversion|Audience)\b/, why: "同上" },
];

/** コメントを除く(admin の検査と同じ規則: ブロックコメントは行頭か `{` の直後で始まるものだけ、行コメントは `//` の前が `:` でないもの) */
const stripComments = (src: string) =>
  src
    .replace(/(^[ \t]*|\{)\/\*[\s\S]*?\*\/\}?/gm, (m: string, head: string) => head + m.slice(head.length).replace(/[^\n]/g, "")) // 改行は残す(行番号をずらさない)
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

/** 日本語を含む文字列リテラル("…" / '…' / `…`)と、その行番号 */
function japaneseLiterals(src: string): Array<{ line: number; text: string }> {
  const code = stripComments(src);
  const out: Array<{ line: number; text: string }> = [];
  for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
    if (JAPANESE.test(m[0])) out.push({ line: code.slice(0, m.index).split("\n").length, text: m[0] });
  }
  return out;
}

describe("user facing strings follow the glossary (backlog B35)", () => {
  it("the banned forms catch the known old texts and spare the new texts and identifiers (r2 CX-Medium-6)", () => {
    const hit = (t: string) => BANNED.some((b) => b.re.test(t));
    for (const old of [
      "weight の合計 100・Variant 2 つ以上・参照する Goal / オーディエンスの存在・配信条件の形を確認してください",
      "数秒後にもう一度 Publish してください",
      "running の実験があります。先に Stop してから削除してください",
      "フルの API キーはシステム管理者だけが使えます",
      "最後の OWNER は外せません",
      "Analytics の設定が不正です",
      "Identity の保存期間を延ばします",
      "システム管理者から外すときは、ユーザーメニューの「システム管理者」から行ってください",
    ]) expect(hit(old), old).toBe(true);
    for (const ok of [
      "weight の合計 100・パターン 2 つ以上・参照する目標 / オーディエンスの存在・配信条件の形を確認してください",
      "鍵の範囲。null = すべてのワークスペース(`full`。システム管理者だけ)",
      "variantId と experimentId を指定してください",
      "終了(archived)してから削除してください",
      "フルリロードを跨ぐ遷移でだけ走る",
      "外部計測の設定が不正です(analytics / ab_exposure / exposureByVariant)",
    ]) expect(hit(ok), ok).toBe(false);
  });

  it("the sources are provided", () => {
    expect(Object.keys(env.TEST_SOURCES)).toContain("control/errors.ts");
    expect(Object.keys(env.TEST_SOURCES)).toContain("core/compile.ts");
  });

  it("no banned forms in Japanese string literals of control and core", () => {
    const hits: string[] = [];
    for (const [file, src] of Object.entries(env.TEST_SOURCES)) {
      for (const { line, text } of japaneseLiterals(src)) {
        for (const b of BANNED) {
          if (!b.re.test(text)) continue;
          if (ALLOW.some((a) => a.file === file && a.re.source === b.re.source)) continue;
          hits.push(`${file}:${line} ${text.slice(0, 80)} → ${b.use}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("default messages", () => {
    const hits = Object.entries(DEFAULT_MESSAGES).flatMap(([code, s]) => BANNED.filter((b) => b.re.test(s)).map((b) => `${code}: ${s} → ${b.use}`));
    expect(hits).toEqual([]);
  });
});
