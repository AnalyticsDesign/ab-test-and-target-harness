import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * backlog D13 / 決定 56 (1)・plan12 K3 / K8: admin は control へのすべての要求で版を名乗り(x-wtt-client-version)、
 * BFF が受けた要求の接続元 IP を渡す(x-wtt-client-ip)。古い admin が名乗る処理は後から足せないので、漏れをソースの静的な検査で止める。
 * - サーバー側: control を呼ぶ fetch は `lib/control.ts` の `controlRequest` の中だけ(版と IP を付けるのはこの関数だけ)。
 *   ほかの場所に `fetch(` を書くと落ちる(controlFetch・/api/session/* の 5 本・招待ページ・汎用の転送はすべて controlRequest を通る)
 * - ブラウザ側: BFF に送る要求は `lib/client.ts` の `api()` と認証まわりの 4 画面の生の fetch だけで、すべて `browserVersionHeaders()` を付ける
 * - ブラウザからの書き込みの入口の一覧: サーバーアクション(`"use server"`)と関数値の `action={…}` / `formAction={…}` は 0 件。
 *   サーバーアクションはサーバー側で control を呼ぶので BFF の版を名乗り、古いタブを素通しにする(決定 63 (1) の前提が崩れる)。
 *   足すなら、ブラウザの版を引数で受けて渡す規則を決めてからこの一覧を直す
 * コメントは数えない(定義やコメントを名乗りとして数えると付け忘れを見逃す。レビュー r1 CX-Medium-4)
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROOT = path.join(import.meta.dirname, "..");
const files = (dir: string) =>
  readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts")) // 型の宣言(lib/cloudflare-workers.d.ts の Fetcher)は呼び出しではない
    .map((f) => path.join(dir, f).split(path.sep).join("/"));
const SOURCES = [...files("app"), ...files("components"), ...files("lib")];
const read = (f: string) => stripComments(readFileSync(path.join(ROOT, f), "utf8"));

/** ブラウザの JS が BFF を生の fetch で呼ぶ所(ファイル → 宛先)。一覧に無い入口を足すと落ちる */
const BROWSER_FETCHES = [
  "app/(auth)/invite/[id]/AcceptInviteForm.tsx → /api/session/accept-invite",
  "app/(auth)/login/PasswordLoginForm.tsx → /api/session/login",
  "app/(auth)/reset/page.tsx → /api/control/auth/reset-password",
  "app/(auth)/setup/page.tsx → /api/session/setup",
  "lib/client.ts → /api/control${path}",
];
/** 文字列の form action(ヘッダーを付けられないので 0 を名乗る。宛先の /auth/sign-out は control の判定の対象外) */
const STRING_ACTIONS = ["/api/session/logout"];

/** `export async function controlRequest(` から、行頭の `}` までの本文 */
function controlRequestBody(src: string): string {
  const start = src.indexOf("export async function controlRequest(");
  expect(start, "lib/control.ts に controlRequest がある").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", start);
  // 見つからないと slice(start, -1) がファイルの残りを丸ごと本文に入れ、後ろの fetch を見逃す。書き方が変わったら落とす
  expect(end, "controlRequest の本文の終わり(行頭の })が見つかる").toBeGreaterThanOrEqual(0);
  return src.slice(start, end);
}

describe("control への要求は controlRequest だけが組み立てる(D13 / decision 56 (1)・plan12 K3 / K8)", () => {
  it("サーバー側の fetch は lib/control.ts の controlRequest の中だけで、control の URL を宛先にする", () => {
    const offenders: string[] = [];
    const control = read("lib/control.ts");
    const body = controlRequestBody(control);
    for (const f of SOURCES) {
      let src = read(f);
      if (f === "lib/control.ts") src = src.replace(body, "");
      // ブラウザの生の fetch(同一オリジンの /api/*)は下の入口の一覧で数える
      const outside = [...src.matchAll(/\bfetch\(\s*(?![`"']\/api\/)/g)].length;
      if (outside > 0) offenders.push(`${f}(controlRequest の外の fetch ${outside})`);
    }
    expect(offenders).toEqual([]);
    // controlRequest は binding の fetch と公開 URL の fetch の 2 つを持ち、どちらも controlUrl() の URL を宛先にする
    expect(body.match(/\bfetch\(/g)?.length ?? 0).toBe(2);
    expect(body).toMatch(/controlUrl\(\)/);
    expect(body).toMatch(/CLIENT_VERSION_HEADER/);
    expect(body).toMatch(/CLIENT_IP_HEADER/);
  });

  it("ブラウザが BFF に送る要求(api() と 4 画面の生の fetch)はすべて browserVersionHeaders() で版を名乗る", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const f of SOURCES) {
      const src = read(f);
      const fetches = src.match(/\bfetch\(\s*[`"']\/api\//g)?.length ?? 0;
      if (fetches === 0) continue;
      calls += fetches;
      const named = src.match(/(?<!function )browserVersionHeaders\(\)/g)?.length ?? 0;
      if (named < fetches) offenders.push(`${f}(fetch ${fetches} / 名乗り ${named})`);
    }
    expect(calls).toBe(BROWSER_FETCHES.length);
    expect(offenders).toEqual([]);
  });
});

describe("ブラウザからの書き込みの入口の一覧(plan12 K3)", () => {
  it("サーバーアクションと関数値の action / formAction が無い", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const src = read(f);
      if (/["']use server["']/.test(src)) offenders.push(`${f}: "use server"`);
      if (/\b(?:action|formAction)=\{/.test(src)) offenders.push(`${f}: action={…} / formAction={…}`);
      for (const m of src.matchAll(/\b(?:action|formAction)=["']([^"']*)["']/g)) {
        if (!STRING_ACTIONS.includes(m[1]!)) offenders.push(`${f}: action="${m[1]}"`);
      }
      // fetch 以外でブラウザから BFF に送る手段(ヘッダーを付けられない・付け忘れやすい)
      if (/\b(?:XMLHttpRequest|sendBeacon|EventSource)\b/.test(src)) offenders.push(`${f}: XMLHttpRequest / sendBeacon / EventSource`);
    }
    expect(offenders).toEqual([]);
  });

  it("ブラウザの生の fetch は一覧のファイルと宛先だけ", () => {
    const found: string[] = [];
    for (const f of SOURCES) {
      for (const m of read(f).matchAll(/\bfetch\(\s*[`"'](\/api\/[^`"']*)[`"']/g)) found.push(`${f} → ${m[1]}`);
    }
    expect(found.sort()).toEqual([...BROWSER_FETCHES].sort());
  });
});
