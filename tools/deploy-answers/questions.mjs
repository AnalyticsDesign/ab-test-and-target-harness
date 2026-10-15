// 質問の表(docs/install-questions.md と同じ ID・キー・値)と、答え・構成の検査。
// 問題には聞き直す問いの ID を付ける(手で書いた構成の問題は、構成のキー名を ID にする)

export const QUESTIONS = [
  { id: "N1", key: "features", kind: "list", values: ["ab", "history", "itp"] },
  { id: "N2", key: "daily_pv", kind: "enum", values: ["under_10k", "10k_30k", "30k_70k", "over_70k", "unknown"] },
  { id: "N3", key: "image_upload", kind: "bool" },
  { id: "E1", key: "cloudflare_account", kind: "enum", values: ["none", "existing", "separate"] },
  { id: "E1b", key: "existing_plan", kind: "enum", values: ["free", "paid"], when: (v) => v.cloudflare_account === "existing" },
  { id: "E2", key: "site_on_cloudflare", kind: "enum", values: ["yes", "no", "no_site"] },
  { id: "E2a", key: "install_host", kind: "host", when: (v) => v.site_on_cloudflare === "yes" },
  {
    id: "E2b",
    key: "other_workers",
    kind: "enum",
    values: ["yes", "no", "unknown"],
    when: (v) => v.cloudflare_account === "existing" && v.existing_plan === "free" && (v.site_on_cloudflare === "no" || v.site_on_cloudflare === "no_site"),
  },
  { id: "E3", key: "owner_email", kind: "email" },
];

/** 下段(構成)のキー。1 つでも書かれていれば、推奨を作らずに書かれた構成を検査する */
export const CONFIG_KEYS = ["edge_address", "zone_name", "asset_public_base", "dlite_hosts", "plan"];
export const ACCEPT_VALUES = ["recommended", "lightest", "manual"];

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 未記入: 無い・空・`<` で始まるプレースホルダ・空の配列 */
export const isBlank = (v) =>
  v === null || v === undefined || v === "" || (typeof v === "string" && v.startsWith("<")) || (Array.isArray(v) && v.length === 0);

/** ホストの形でなければ理由を返す。URL を貼られたときは取り出したホストを候補に示す */
export function hostProblem(v) {
  if (typeof v !== "string") return "ホストを文字列で書く(例 www.example.com)";
  if (HOST_RE.test(v)) return null;
  const cand = v.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (HOST_RE.test(cand)) return `ホストだけを書く(候補: ${cand})`;
  // 国際化ドメイン名(www.例え.jp など)は punycode の形(xn--…)にすると通る
  try {
    const puny = new URL(`https://${cand}`).hostname;
    if (HOST_RE.test(puny)) return `ホストを ASCII の形(punycode)で書く(候補: ${puny})`;
  } catch {
    // URL として解釈できないものは下の一般の案内にする
  }
  return "ホストの形になっていない(例 www.example.com)";
}

export const hostInZone = (host, zone) => host === zone || host.endsWith(`.${zone}`);

/** やりたいこと。A/B テスト(ab)は必ず入る */
export function featuresOf(values) {
  const raw = values.features;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && !isBlank(raw) ? [raw] : [];
  return new Set(["ab", ...list]);
}

function valueProblem(q, v) {
  switch (q.kind) {
    case "list": {
      const bad = (Array.isArray(v) ? v : [v]).filter((x) => !q.values.includes(x));
      // ブラケット無しのカンマ区切り(ab, history)は文字列 1 個になる。複数の書き方を添える
      const hint = typeof v === "string" && v.includes(",") ? `。複数は [${v.split(",").map((x) => x.trim()).filter(Boolean).join(", ")}] の形で書く` : "";
      return bad.length ? `選択肢に無い値: ${bad.join(", ")}(選べるのは ${q.values.join(" / ")})${hint}` : null;
    }
    case "enum":
      return q.values.includes(v) ? null : `選択肢に無い値: ${v}(選べるのは ${q.values.join(" / ")})`;
    case "bool":
      return typeof v === "boolean" ? null : "true か false で書く";
    case "host":
      return hostProblem(v);
    case "email":
      return typeof v === "string" && EMAIL_RE.test(v) ? null : "メールアドレスの形になっていない";
  }
  return null;
}

/** 質問への答えの検査 */
export function checkAnswers(values) {
  const issues = [];
  for (const q of QUESTIONS) {
    if (q.when && !q.when(values)) continue;
    const v = values[q.key];
    if (isBlank(v)) {
      issues.push({ id: q.id, key: q.key, message: "未回答" });
      continue;
    }
    const p = valueProblem(q, v);
    if (p) issues.push({ id: q.id, key: q.key, message: p });
  }
  if (values.site_on_cloudflare === "yes" && (values.cloudflare_account === "none" || values.cloudflare_account === "separate")) {
    const message =
      "ドメインを管理しているのは別のアカウントなので、新しいアカウントにはそのドメインを使った仕組みを置けない。既存のアカウントに入れる(E1 = existing)か、ドメインを使わずに始める(E2 = no)かを選び直す";
    issues.push({ id: "E1", key: "cloudflare_account", message }, { id: "E2", key: "site_on_cloudflare", message });
  }
  return issues;
}

/** 下段の構成(推奨を書き込む 5 キー)か accepted に値があれば、推奨を作らずに書かれた構成を検査する。値が空の行は数えない */
export const isConfigured = (values) => CONFIG_KEYS.some((k) => !isBlank(values[k])) || !isBlank(values.accepted);

/** 下段に書かれた構成の検査(--accept の後と、上級者が手で書いたとき) */
export function checkConfigured(values) {
  const issues = [];
  const add = (key, message) => issues.push({ id: key, key, message });
  const edge = values.edge_address ?? "route";
  if (edge !== "route" && edge !== "workers-dev") add("edge_address", `route か workers-dev で書く(今: ${edge})`);
  if (edge === "route") {
    const hp = isBlank(values.install_host) ? "edge_address: route のときは必須" : hostProblem(values.install_host);
    if (hp) add("install_host", hp);
    if (isBlank(values.zone_name)) add("zone_name", "edge_address: route のときは必須(auto でもよい)");
    else if (values.zone_name !== "auto" && !hp && !hostInZone(values.install_host, values.zone_name))
      add("zone_name", `install_host(${values.install_host})がゾーン ${values.zone_name} に属していない`);
  }
  const asset = values.asset_public_base;
  if (isBlank(asset)) add("asset_public_base", "必須(none / dev-assets / auto / https://<ホスト>)");
  else if (asset === "auto" && edge !== "route") add("asset_public_base", "auto は edge_address: route のときだけ使える");
  else if (!(asset === "none" || asset === "dev-assets" || asset === "auto" || /^https:\/\/[^/\s]+\/?$/.test(asset)))
    add("asset_public_base", "none / dev-assets / auto / https://<ホスト> のどれかで書く");
  const dl = values.dlite_hosts ?? [];
  if (!Array.isArray(dl)) add("dlite_hosts", "[ホスト, …] の配列で書く");
  else if (dl.length && edge !== "route") add("dlite_hosts", "D-lite は edge_address: route のときだけ使える");
  else {
    const bad = dl.map((h) => [h, hostProblem(h)]).find(([, p]) => p);
    if (bad) add("dlite_hosts", `${bad[0]}: ${bad[1]}`);
  }
  const plan = values.plan ?? "free";
  if (plan !== "free" && plan !== "paid") add("plan", "free か paid で書く");
  else if (plan === "free" && values.cloudflare_account === "existing" && values.existing_plan === "paid")
    add("plan", "上段の答えでは、入れる既存のアカウントが Workers Paid(プランはアカウント単位)。そのアカウントに入れるなら plan: paid にし、Free で使うなら別のアカウントに入れる(cloudflare_account: separate)");
  if (!isBlank(values.accepted) && !ACCEPT_VALUES.includes(values.accepted))
    add("accepted", `${ACCEPT_VALUES.join(" / ")} のどれかで書く`);
  if (isBlank(values.owner_email)) add("owner_email", "必須");
  else if (!EMAIL_RE.test(values.owner_email)) add("owner_email", "メールアドレスの形になっていない");
  return issues;
}
