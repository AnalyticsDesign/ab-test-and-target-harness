import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../run.mjs";
import { parseAnswers } from "../parse.mjs";
import { writeKeys, resolveZone } from "../yaml-edit.mjs";

const LOWER = [
  "# --- 下段 ---",
  "# edge_address: route              # route | workers-dev",
  "# zone_name: example.com           # route のとき",
  "# asset_public_base: none          # none / dev-assets / auto / https://…",
  "# dlite_hosts: []                  # D-lite",
  "# plan: free                       # free | paid",
  "# accepted: recommended            # --accept が書く",
  "",
].join("\n");
const answers = (over = {}) => {
  const v = { features: "[ab]", daily_pv: "under_10k", image_upload: "false", cloudflare_account: "none", site_on_cloudflare: "no_site", owner_email: "a@example.com", ...over };
  return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join("\n") + "\n" + LOWER;
};

test("答えがそろっていれば提示(終了コード 0)。推奨 = 最軽量なら最軽量は「推奨構成と同じ」", () => {
  const r = run(answers());
  assert.equal(r.code, 0);
  assert.equal(r.text, undefined);
  for (const h of ["## 推奨構成", "### この構成でできないこと", "## 最軽量構成", "## 人に頼む作業", "## 課金と止まり方", "## 注意"]) assert.ok(r.output.includes(h), h);
  assert.match(r.output, /推奨構成と同じ。/);
});

test("推奨と最軽量が違えば、両方の構成と、人に頼む作業・課金を構成ごとに出す", () => {
  const r = run(answers({ features: "[ab, history]", daily_pv: "30k_70k", cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com" }));
  assert.equal(r.code, 0);
  assert.match(r.output, /\*\*ドメインあり\(www\.example\.com\) × Workers Paid × 画像のアップロードなし\*\*/);
  assert.match(r.output, /\*\*ドメインなし\(\*\.workers\.dev\) × Free × 画像のアップロードなし\*\*/);
  assert.match(r.output, /### 推奨構成の場合[\s\S]*### 最軽量構成の場合/);
});

test("足りない答え・矛盾は「聞き直す問い」(終了コード 2)", () => {
  const r = run(answers({ owner_email: "", site_on_cloudflare: "yes", install_host: "www.example.com" }));
  assert.equal(r.code, 2);
  assert.match(r.output, /## 聞き直す問い/);
  assert.match(r.output, /- E1\(cloudflare_account\)/);
  assert.match(r.output, /- E2\(site_on_cloudflare\)/);
  assert.match(r.output, /- E3\(owner_email\): 未回答/);
});

test("書式の誤りは行番号付き(終了コード 1)", () => {
  const r = run("features: [ab\n", { file: "x.yaml" });
  assert.equal(r.code, 1);
  assert.match(r.output, /x\.yaml の 1 行目/);
});

test("--accept recommended は下段のコメント行を有効な行に置き換え、説明のコメントを残す", () => {
  const text = answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com", image_upload: "true" });
  const r = run(text, { accept: "recommended" });
  assert.equal(r.code, 0);
  assert.match(r.output, /## 書き込んだ行/);
  assert.match(r.text, /^edge_address: route   # route \| workers-dev$/m);
  assert.match(r.text, /^zone_name: auto   # route のとき$/m);
  assert.match(r.text, /^asset_public_base: auto   /m);
  assert.match(r.text, /^dlite_hosts: \[\]   /m);
  assert.match(r.text, /^plan: free   /m);
  assert.match(r.text, /^accepted: recommended   /m);
  assert.deepEqual(parseAnswers(r.text).errors, []);
});

test("workers-dev の構成では zone_name を書かない", () => {
  const r = run(answers(), { accept: "lightest" });
  assert.equal(r.code, 0);
  assert.match(r.text, /^# zone_name: example\.com/m);
  assert.match(r.text, /^edge_address: workers-dev /m);
});

test("--accept を 2 回実行しても変わらない。別の案で上書きしない", () => {
  const first = run(answers(), { accept: "recommended" });
  const again = run(first.text, { accept: "recommended" });
  assert.equal(again.code, 0);
  assert.equal(again.text, undefined);
  assert.match(again.output, /## 指定された構成/);
  assert.match(again.output, /推奨構成で了承済み/);
  const other = run(first.text, { accept: "lightest" });
  assert.equal(other.code, 2);
  assert.match(other.output, /既に recommended で了承済み/);
});

test("了承の後に引数なしで実行すると、書き込まれた構成の要約", () => {
  const first = run(answers(), { accept: "lightest" });
  const r = run(first.text);
  assert.equal(r.code, 0);
  assert.match(r.output, /最軽量構成で了承済み/);
});

test("上級者が下段を手で書いた場合: 推奨を作らず検査と要約。了承は --accept manual だけ", () => {
  const text = "owner_email: a@example.com\nfeatures: [ab, history]\nedge_address: workers-dev\nasset_public_base: none\n";
  const r = run(text);
  assert.equal(r.code, 0);
  assert.match(r.output, /## 指定された構成/);
  assert.match(r.output, /未了承/);
  assert.equal(run(text, { accept: "recommended" }).code, 2);
  const m = run(text, { accept: "manual" });
  assert.equal(m.code, 0);
  assert.match(m.text, /^accepted: manual$/m);
});

test("構成が無いのに --accept manual は断る。--accept の値の誤りは終了コード 1", () => {
  assert.equal(run(answers(), { accept: "manual" }).code, 2);
  assert.equal(run(answers(), { accept: "best" }).code, 1);
});

test("手で書いた構成の矛盾は「聞き直す問い」にキー名で出す", () => {
  const r = run("owner_email: a@example.com\nedge_address: workers-dev\nasset_public_base: auto\n");
  assert.equal(r.code, 2);
  assert.match(r.output, /- asset_public_base\(asset_public_base\)/);
});

test("--resolve-zone は auto を確定し、再実行では何もしない。ホストが属さないゾーンは断る", () => {
  const accepted = run(answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com", image_upload: "true" }), { accept: "recommended" }).text;
  const bad = run(accepted, { resolveZone: "other.com" });
  assert.equal(bad.code, 2);
  const r = run(accepted, { resolveZone: "Example.com" });
  assert.equal(r.code, 0);
  assert.match(r.text, /^zone_name: example\.com   # route のとき$/m);
  assert.match(r.text, /^asset_public_base: https:\/\/wtt-assets\.example\.com   /m);
  const again = run(r.text, { resolveZone: "example.com" });
  assert.equal(again.code, 0);
  assert.equal(again.text, undefined);
});

test("CRLF のファイルは CRLF のまま書き戻す", () => {
  const r = run(answers().replace(/\n/g, "\r\n"), { accept: "lightest" });
  assert.equal(r.code, 0);
  assert.ok(r.text.includes("edge_address: workers-dev   # route | workers-dev\r\n"));
  assert.ok(!/[^\r]\n/.test(r.text));
});

test("writeKeys: コメント行が無いキーは末尾(空行の手前)に足す。既に有効な行は触らない", () => {
  const r = writeKeys("a: 1\nplan: paid\n\n", [["plan", "free"], ["accepted", "manual"]]);
  assert.equal(r.text, "a: 1\nplan: paid\naccepted: manual\n\n");
  assert.deepEqual(r.written, ["accepted: manual"]);
});

test("resolveZone: auto が無ければ何も書かない", () => {
  assert.deepEqual(resolveZone("zone_name: example.com\n", "example.com").written, []);
});

test("--resolve-zone: 先頭行が BOM 付きの auto も確定し、BOM を残す", () => {
  const text = "\uFEFFzone_name: auto\nasset_public_base: auto\ninstall_host: www.example.com\nowner_email: a@example.com\nedge_address: route\n";
  const r = run(text, { resolveZone: "example.com" });
  assert.equal(r.code, 0);
  assert.ok(r.text.startsWith("\uFEFFzone_name: example.com\n"));
  assert.match(r.text, /^asset_public_base: https:\/\/wtt-assets\.example\.com$/m);
});

test("--resolve-zone: auto が無ければホストを問わず何もしない。ゾーン名の形でなければ終了コード 1", () => {
  const configured = "owner_email: a@example.com\nedge_address: workers-dev\nasset_public_base: none\naccepted: lightest\n";
  const r = run(configured, { resolveZone: "example.com" });
  assert.equal(r.code, 0);
  assert.equal(r.text, undefined);
  assert.match(r.output, /auto の行が無い/);
  assert.equal(run(configured, { resolveZone: "com" }).code, 1);
});

test("値が空の accepted の行は、了承のときに置き換えて保存する", () => {
  const text = "owner_email: a@example.com\nedge_address: workers-dev\nasset_public_base: none\naccepted:   # --accept が書く\n";
  const r = run(text, { accept: "manual" });
  assert.equal(r.code, 0);
  assert.match(r.text, /^accepted: manual   # --accept が書く$/m);
  assert.equal(parseAnswers(r.text).values.accepted, "manual");
  assert.match(run(r.text).output, /手で指定した構成で了承済み/);
});

test("アカウントが変わる確認は、それが起きる構成の節の中(要約の下)に出す(提示の先頭には出さない。変わらなければ出さない)", () => {
  const sections = (out) => ({
    rec: out.slice(out.indexOf("## 推奨構成"), out.indexOf("## 最軽量構成")),
    light: out.slice(out.indexOf("## 最軽量構成"), out.indexOf("## 人に頼む作業")),
  });
  const r = run(answers({ cloudflare_account: "existing", existing_plan: "paid", site_on_cloudflare: "no" }));
  assert.equal(r.code, 0);
  assert.ok(r.output.startsWith("## 推奨構成\n"));
  const { rec } = sections(r.output);
  assert.match(rec, /\*\*確認: アカウントが変わる\*\*: 答えでは既存のアカウントに入れる予定だったが/);
  // 要約(太字の 1 行)と置き場所の行の後、理由の一覧より前
  assert.ok(rec.indexOf("確認: アカウントが変わる") > rec.indexOf("*.workers.dev に置く"));
  assert.ok(rec.indexOf("確認: アカウントが変わる") < rec.indexOf("\n- "));
  assert.match(r.output, /Free の Cloudflare アカウントを新しく作る/);
  // 人に見せる節なので、エージェント向けの扱い(答えのファイルの書き換え・フラグ)は書かない(README の 4.・deploy.md 0.2 にある)
  assert.doesNotMatch(rec, /--confirm-account-change|書き換える|エージェント/);
  // 理由は確認の段落にだけ書き、理由の一覧には重ねない
  assert.equal(rec.split("請求に含まれる").length - 1, 1);
  assert.doesNotMatch(run(answers()).output, /アカウントが変わる/);
  const lightOnly = run(answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com" }));
  const s = sections(lightOnly.output);
  assert.doesNotMatch(s.rec, /アカウントが変わる/);
  assert.match(s.light, /確認: アカウントが変わる/);
  assert.match(s.light, /止まると困る Worker が無いとは確かめられていない/);
});

test("ドメインなしの構成の注意は「悪意のある人」で書き、「第三者」を使わない。誰でも知ることができる理由の括弧は出力の初出だけ", () => {
  const cases = [
    answers({ cloudflare_account: "existing", existing_plan: "paid", site_on_cloudflare: "no" }),
    answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "no", other_workers: "unknown" }),
    answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com" }),
    answers({ features: "[ab, history]", daily_pv: "over_70k" }),
    answers(),
  ];
  for (const text of cases) {
    const out = run(text).output;
    assert.doesNotMatch(out, /第三者/);
    assert.match(out, /万が一、悪意のある人がプログラムで大量のアクセスを送ってきた場合/);
    assert.equal(out.split("タグのアドレスはサイトの HTML に書かれるので、誰でも知ることができる").length - 1, 1, text);
  }
  const refused = run(cases[1], { accept: "lightest" }).output;
  assert.doesNotMatch(refused, /第三者/);
  assert.match(refused, /誰でも知ることができる/);
});

test("提示の推奨構成・最軽量構成の要約の下に、管理画面と control の置き場所を 1 行出す", () => {
  const r = run(answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com" }));
  assert.equal(r.code, 0);
  const rec = r.output.slice(r.output.indexOf("## 推奨構成"), r.output.indexOf("## 最軽量構成"));
  const light = r.output.slice(r.output.indexOf("## 最軽量構成"), r.output.indexOf("## 人に頼む作業"));
  assert.match(rec, /管理画面と control\(管理用の Worker\)は \*\.workers\.dev に置く\(自分のドメインに載せるのは任意。デプロイガイド 3\.6・4\.2\)/);
  assert.match(light, /管理画面と control\(管理用の Worker\)も \*\.workers\.dev に置く/);
});

test("アカウントが変わる構成の --accept は、--confirm-account-change が無ければ終了コード 2 で止まり、ファイルを変えない", () => {
  const text = answers({ cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "no", other_workers: "yes" });
  for (const accept of ["recommended", "lightest"]) {
    const r = run(text, { accept });
    assert.equal(r.code, 2, accept);
    assert.equal(r.text, undefined);
    assert.match(r.output, /## 確認: アカウントが変わる/);
    assert.match(r.output, /止まると困る Worker があると答えた/);
  }
});

test("--confirm-account-change 付きなら、上段を separate に書き換えて元の答えをコメントに残し、下段を書く", () => {
  const text = answers({ cloudflare_account: "existing", existing_plan: "paid", site_on_cloudflare: "no" });
  const r = run(text, { accept: "recommended", confirmAccountChange: true });
  assert.equal(r.code, 0);
  assert.match(r.text, /^cloudflare_account: separate   # 元の答え: existing。Workers Paid のため/m);
  assert.doesNotMatch(r.text, /^cloudflare_account: existing/m);
  assert.match(r.text, /^plan: free   /m);
  assert.match(r.text, /^accepted: recommended   /m);
  assert.match(r.output, /- cloudflare_account: separate/);
  assert.deepEqual(parseAnswers(r.text).errors, []);
  const again = run(r.text);
  assert.equal(again.code, 0);
  assert.match(again.output, /推奨構成で了承済み/);
  assert.match(again.output, /Cloudflare のアカウントを作る/);
  assert.equal(run(r.text, { accept: "recommended", confirmAccountChange: true }).text, undefined);
});

test("アカウントが変わらない構成では --confirm-account-change を付けても同じ結果", () => {
  const plain = run(answers(), { accept: "lightest" });
  const confirmed = run(answers(), { accept: "lightest", confirmAccountChange: true });
  assert.equal(confirmed.text, plain.text);
  assert.doesNotMatch(confirmed.text, /元の答え/);
});

test("未記入の値(空の引用符・プレースホルダ・空の配列)の行は書き戻しで置き換え、読み直すと選んだ値になる", () => {
  const manual = "owner_email: a@example.com\nedge_address: workers-dev\nasset_public_base: none\n";
  for (const blank of ['""', "<manual>"]) {
    const r = run(`${manual}accepted: ${blank}\n`, { accept: "manual" });
    assert.equal(r.code, 0, blank);
    assert.equal(parseAnswers(r.text).values.accepted, "manual", blank);
  }
  const placeholder = run(answers().replace("# plan: free ", "plan: <free / paid>"), { accept: "recommended" });
  assert.equal(placeholder.code, 0);
  assert.equal(parseAnswers(placeholder.text).values.plan, "free");
  assert.equal(run(placeholder.text).code, 0);
  const itp = answers({ features: "[ab, itp]", cloudflare_account: "existing", existing_plan: "free", site_on_cloudflare: "yes", install_host: "www.example.com" }).replace("# dlite_hosts: []", "dlite_hosts: []");
  const r = run(itp, { accept: "recommended" });
  assert.equal(r.code, 0);
  assert.deepEqual(parseAnswers(r.text).values.dlite_hosts, ["www.example.com"]);
});

test("--resolve-zone: 引用符付きの auto も確定する。zone_name が確定済みで asset_public_base だけ auto なら、同じゾーンのときだけ確定する", () => {
  const quoted = 'owner_email: a@example.com\ninstall_host: www.example.com\nzone_name: "auto"   # x\nasset_public_base: "auto"\naccepted: manual\n';
  const r = run(quoted, { resolveZone: "example.com" });
  assert.equal(r.code, 0);
  assert.equal(parseAnswers(r.text).values.zone_name, "example.com");
  assert.equal(parseAnswers(r.text).values.asset_public_base, "https://wtt-assets.example.com");
  assert.match(r.text, /^zone_name: example\.com   # x$/m);
  const assetOnly = "owner_email: a@example.com\ninstall_host: www.example.com\nzone_name: example.com\nasset_public_base: auto\naccepted: manual\n";
  assert.equal(run(assetOnly, { resolveZone: "www.example.com" }).code, 2);
  const ok = run(assetOnly, { resolveZone: "example.com" });
  assert.equal(ok.code, 0);
  assert.equal(parseAnswers(ok.text).values.asset_public_base, "https://wtt-assets.example.com");
});

test("手で書いた構成で、上段が既存の Paid のアカウントなのに plan: free なら了承しない(終了コード 2)", () => {
  const text = "owner_email: a@example.com\ncloudflare_account: existing\nexisting_plan: paid\nedge_address: workers-dev\nasset_public_base: none\nplan: free\n";
  const r = run(text, { accept: "manual" });
  assert.equal(r.code, 2);
  assert.equal(r.text, undefined);
  assert.match(r.output, /- plan\(plan\)/);
});
