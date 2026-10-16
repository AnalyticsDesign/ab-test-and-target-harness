// docs-check.mjs — README.md + CONTEXT.md + docs/*.md + docs/dev の生きている文書(あれば)+ apps/{edge,control}/README.md の
// 相対リンク / アンカー / リポジトリ相対パス / pnpm スクリプト名を検査する
// 使い方: リポジトリのルートで `pnpm docs:check`(引数にファイルを渡すとそれだけを検査)
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const root = process.cwd();
const defaultFiles = [
  "README.md", "CONTEXT.md",
  ...["CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", ".github/pull_request_template.md"].filter((f) => existsSync(join(root, f))),
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).sort().map((f) => `docs/${f}`),
  ...["docs/dev/README.md", "docs/dev/backlog.md", "docs/dev/release.md"].filter((f) => existsSync(join(root, f))),
  "apps/edge/README.md", "apps/control/README.md",
];
const rootScripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}));
const pkgScriptsCache = new Map();
const scriptsOf = (dir) => {
  if (!pkgScriptsCache.has(dir)) {
    const p = join(root, dir, "package.json");
    pkgScriptsCache.set(dir, existsSync(p) ? new Set(Object.keys(JSON.parse(readFileSync(p, "utf8")).scripts ?? {})) : null);
  }
  return pkgScriptsCache.get(dir);
};
// 読者が後から作るファイル・生成物は存在検査の対象外
const PATH_EXCLUDE = /(^|\/)(\.env[^/]*|\.dev\.vars[^/]*|\.kv\/|\.static(\/|$)|node_modules\/)/;
// 必須文書(ルート README から辿る公開文書 6 本 + CONTEXT.md)。既定モードでは 1 本でも欠けると missing-file で不合格。明示引数の不在も不合格
const REQUIRED = ["README.md", "CONTEXT.md", "docs/README.md", "docs/deploy.md", "docs/site-install.md", "docs/operations.md", "docs/analytics.md", "docs/agent-guide.md"];
// 用語表(B35)の検査の対象 = 公開文書。operations.md 1 節の対応表が正
const GLOSSARY_FILES = new Set(["README.md", "CHANGELOG.md", "docs/README.md", "docs/install-patterns.md", "docs/install-questions.md", "docs/deploy.md", "docs/site-install.md", "docs/operations.md", "docs/analytics.md", "docs/agent-guide.md"]);
const GLOSSARY_BANNED = [
  { re: /未公開の変更あり/, use: "未公開の編集あり" },
  { re: /権限の上限/, use: "権限(API の roleCap)" },
  { re: /フル[(\uFF08の]|「フル」/, use: "すべてのワークスペース(API の値は full)" },
  { re: /1 つだけ表示/, use: "パーソナライズ" },
  { re: /バリエーション/, use: "パターン" },
  { re: /(?<!旧称 |「)D-lite/, use: "Mode B(サーバー発行 Cookie)。旧い名前に触れるときは「旧称 D-lite」か「D-lite」(かぎ括弧)と書く。識別子の dlite_hosts はそのまま" },
  { re: /導入パターン/, use: "導入構成(「パターン」は variant だけに使う)" },
  { re: /パターン ?[ABC]\b/, use: "構成 A / B / C(edge の置き方の意味のとき。variant は「A パターン」と書く)" },
  { re: /ユーザーメニュー(?:の| ?→ ?)「(?:API キー|システム管理者|新しいワークスペース|ドラッグ)/, use: "ユーザーメニュー →「設定」→ …" },
  { re: /Start[(\uFF08]公開して配信開始[)\uFF09]|Stop[(\uFF08]終了。復帰不可[)\uFF09]/, use: "開始(公開して配信を始める)/ 終了(元に戻せません)" }, // 半角・全角の括弧の両方(全角は \uFF08 / \uFF09 で明示)
];
const explicit = process.argv.length > 2 ? process.argv.slice(2) : null;
const problems = [];
// 入力ファイルの雛形(deploy.md 0 節)。実ファイル deploy-answers.yaml は git 管理外なので検査しない
const ANSWERS_EXAMPLE = "deploy-answers.example.yaml";
if (!existsSync(join(root, ANSWERS_EXAMPLE))) problems.push(`${ANSWERS_EXAMPLE}:0 missing-file: 入力ファイルの雛形が存在しない`);
else {
  const y = readFileSync(join(root, ANSWERS_EXAMPLE), "utf8");
  if (!y.includes("設定値ではない")) problems.push(`${ANSWERS_EXAMPLE}:1 answers-header: 先頭コメントに「設定値ではない」の明示が無い`);
  for (const k of ["features", "daily_pv", "image_upload", "cloudflare_account", "existing_plan", "site_on_cloudflare", "install_host", "other_workers", "owner_email", "edge_address", "zone_name", "asset_public_base", "dlite_hosts", "plan", "accepted", "release_tag", "control_address", "control_host", "control_protection", "edge_waf_rate_limit", "edge_waf_requests_per_10s", "asset_max_mb", "admin_address", "admin_host"]) {
    if (!new RegExp(`^#? ?${k}:`, "m").test(y)) problems.push(`${ANSWERS_EXAMPLE}:0 answers-key: 項目 ${k} が無い`);
  }
}
for (const f of explicit ?? REQUIRED) if (!existsSync(join(root, f))) problems.push(`${f}:0 missing-file: ${explicit ? "指定されたファイル" : "必須文書"}が存在しない`);
const files = (explicit ?? defaultFiles).filter((f) => existsSync(join(root, f)));

// GitHub(github-slugger)方式の見出しスラッグ: 小文字化 → 英数・かな漢字・空白・-・_ 以外を削除 → **空白 1 個を - 1 個に**。重複は -1, -2 …
function slugsOf(md) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*~]/g, "");
    let slug = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, "").replace(/ /g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    out.add(slug);
  }
  return out;
}
const slugCache = new Map();
const slugsFor = (abs) => {
  if (!slugCache.has(abs)) slugCache.set(abs, slugsOf(readFileSync(abs, "utf8")));
  return slugCache.get(abs);
};

let linkCount = 0;
for (const rel of files) {
  const abs = join(root, rel);
  const lines = readFileSync(abs, "utf8").split("\n");
  let fence = false;
  let inUnreleased = false; // CHANGELOG.md の「## 未リリース」の節の中か
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (!fence && /^## /.test(line)) inUnreleased = /^## 未リリース/.test(line);
    // (7) 用語表(B35)。画面の語として使わない旧表記。CHANGELOG はリリース済みの節に当時の表記が残るので、「## 未リリース」の節だけを見る
    if (!fence && GLOSSARY_FILES.has(rel) && (rel !== "CHANGELOG.md" || inUnreleased)) {
      for (const g of GLOSSARY_BANNED) if (g.re.test(line)) problems.push(`${rel}:${ln} glossary: 「${line.match(g.re)[0]}」→ ${g.use}`);
    }
    // (1) Markdown リンク [text](target) — コードフェンス内は対象外
    if (!fence) {
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:)/.test(target)) continue;
        linkCount++;
        const [path, anchor] = target.split("#");
        const dest = path ? resolve(dirname(abs), path) : abs;
        if (path && !existsSync(dest)) { problems.push(`${rel}:${ln} link: ${path} が存在しない`); continue; }
        if (anchor !== undefined && dest.endsWith(".md")) {
          const want = decodeURIComponent(anchor).toLowerCase();
          if (!slugsFor(dest).has(want)) problems.push(`${rel}:${ln} anchor: #${anchor} が ${path || rel} に無い`);
        }
      }
    }
    // (2) バッククォート内のリポジトリ相対パス(apps/ packages/ docs/ tools/ fixtures/ で始まる。`path:12` / `path:12-15` の行番号は除いて検査)
    for (const m of line.matchAll(/`((?:apps|packages|docs|tools|fixtures)\/[A-Za-z0-9_./\-\[\]]+?)(?::\d+(?:-\d+)?)?`/g)) {
      const p = m[1];
      if (/[*<>{}]/.test(p) || PATH_EXCLUDE.test(p)) continue; // glob・<placeholder>・後から作るファイルは対象外
      if (!existsSync(join(root, p))) problems.push(`${rel}:${ln} path: ${p} が存在しない`);
    }
    // (3) `pnpm <script>` / `pnpm -C <dir> <script>` がそれぞれの package.json の scripts にあるか(exec / install / add / dlx / run / -r は対象外)
    for (const m of line.matchAll(/pnpm\s+(?:-C\s+(\S+)\s+)?([a-z][a-z0-9:-]*)/g)) {
      const [, dir, s] = m;
      if (["exec", "install", "i", "run", "dlx", "add", "-r"].includes(s)) continue;
      const scripts = dir ? scriptsOf(dir) : rootScripts;
      if (scripts === null) { problems.push(`${rel}:${ln} script: ${dir}/package.json が無い`); continue; }
      if (!scripts.has(s)) problems.push(`${rel}:${ln} script: pnpm ${dir ? `-C ${dir} ` : ""}${s} が package.json に無い`);
    }
  });
}

// (4) 非公開の開発記録への参照。パターンと公開対象の一覧は開発リポジトリの release/manifest.json にだけあり、
// 公開リポジトリには無いのでスキップされる。export 時は DOCS_CHECK_MANIFEST で開発側の manifest を渡す
const manifestPath = process.env.DOCS_CHECK_MANIFEST ?? join(root, "release/manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const included = (f) => manifest.include.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));
  const patterns = manifest.privateRefPatterns.map((s) => new RegExp(s, "u"));
  for (const rel of files.filter(included)) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
      for (const re of patterns) {
        const m = re.exec(line);
        if (m) problems.push(`${rel}:${i + 1} private-ref: ${m[0]}`);
      }
    });
  }
}

// (5) deploy.md の「手で導入する最短の手順」のコードブロックは、本文(0 節以降)のどのブロックかと 1 文字も違わないこと。
// 最短の手順は本文のコマンドの再掲なので、片方だけ直すとここで落ちる(直すときは本文を直し、最短の手順に写す)
const DEPLOY = "docs/deploy.md";
const QUICK_HEADING = /^## 手で導入する最短の手順/;
if (files.includes(DEPLOY)) {
  const sections = { quick: [], body: [] };
  let cur = "body", fence = null, buf = [], start = 0;
  readFileSync(join(root, DEPLOY), "utf8").split("\n").forEach((line, i) => {
    if (fence === null && /^## /.test(line)) cur = QUICK_HEADING.test(line) ? "quick" : "body";
    const m = /^\s*(```|~~~)/.exec(line);
    if (m && fence === null) { fence = m[1]; buf = []; start = i + 1; return; }
    if (m && m[1] === fence) { sections[cur].push({ body: buf.join("\n"), line: start }); fence = null; return; }
    if (fence !== null) buf.push(line);
  });
  if (sections.quick.length === 0) problems.push(`${DEPLOY}:0 quick-path: 「## 手で導入する最短の手順」の節が無い、またはコードブロックが無い`);
  const bodyBlocks = new Set(sections.body.map((b) => b.body));
  for (const b of sections.quick) if (!bodyBlocks.has(b.body)) problems.push(`${DEPLOY}:${b.line} quick-path: このコードブロックは本文のどのブロックとも一致しない(本文を正として写し直す)`);
}

// (6) 比喩的な動詞・内部の言い回し(deploy.md と README の地の文。見出しとコードブロックは対象外)。
// 翻訳調の比喩や擬人化を避け、主体と対象を具体語で書く。対象の文書を広げるときは、その文書を先に直してから足す
const PLAIN_FILES = new Set(["README.md", "docs/deploy.md"]);
const PLAIN_BANNED = [
  { re: /叩[くかきい]/, use: "呼び出す / 送る" },
  { re: /焼き込/, use: "書き込む" },
  { re: /効[くいか](?![果能率])/, use: "有効になる / 適用される / 動作する" },
  { re: /拾[うい]/, use: "読み取る / 控える" },
  { re: /載せ/, use: "置く / 配置する" },
  { re: /(を|が)通[すっ]/, use: "成功する / 到達する / 経由する / 許可する" },
  { re: /守り/, use: "保護" },
  { re: /資源/, use: "リソース" },
  { re: /正本/, use: "原本 / 元データ" },
  { re: /節の地図|見出し語|^分岐:/, use: "この文書の構成 / ラベル / 期待と違うとき:" },
];
for (const rel of files.filter((f) => PLAIN_FILES.has(f))) {
  let fence = false;
  readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence || /^#{1,6} /.test(line)) return;
    for (const g of PLAIN_BANNED) if (g.re.test(line)) problems.push(`${rel}:${i + 1} plain-japanese: 「${line.match(g.re)[0]}」→ ${g.use}`);
  });
}

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`OK (${files.length} files, ${linkCount} links)`);
