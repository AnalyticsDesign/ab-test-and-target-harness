// 入口の処理(cli.mjs から呼ぶ純粋関数)。終了コード 0 = 提示・要約・書き込み / 1 = 書式や引数の誤り / 2 = 聞き直す問い・断り
import { parseAnswers } from "./parse.mjs";
import { checkAnswers, checkConfigured, isConfigured, isBlank, hostInZone, hostProblem, ACCEPT_VALUES } from "./questions.mjs";
import { recommend, LIGHTEST, configOf, accountChangeOf } from "./judge.mjs";
import { renderProposals, renderConfigured, renderIssues, renderParseErrors, renderWritten, renderAccountChange } from "./render.mjs";
import { writeKeys, resolveZone, replaceAnswer } from "./yaml-edit.mjs";

const ORDER = ["edge_address", "zone_name", "asset_public_base", "dlite_hosts", "plan"];
const CHANGE_NOTE = {
  paid: "元の答え: existing。Workers Paid のため、ドメインなしの構成は新しく作る Free のアカウントに入れる",
  other_workers: "元の答え: existing。止まると困る Worker が無いと確かめられないため、新しく作るアカウントに入れる",
};

/**
 * @param {string} text deploy-answers.yaml の中身
 * @param {{ file?: string, accept?: string|null, resolveZone?: string|null, confirmAccountChange?: boolean }} [opts]
 * @returns {{ code: 0|1|2, output: string, text?: string }} text があれば呼び出し側が書き戻す
 */
export function run(text, opts = {}) {
  const file = opts.file ?? "deploy-answers.yaml";
  const { values, errors } = parseAnswers(text);
  if (errors.length) return { code: 1, output: renderParseErrors(file, errors) };
  if (opts.accept !== null && opts.accept !== undefined && !ACCEPT_VALUES.includes(opts.accept)) return { code: 1, output: `--accept には ${ACCEPT_VALUES.join(" / ")} のどれかを書く\n` };

  if (opts.resolveZone !== null && opts.resolveZone !== undefined) {
    const zone = opts.resolveZone.trim().toLowerCase();
    if (hostProblem(zone)) return { code: 1, output: `--resolve-zone にはゾーン名を書く(例 example.com。今: ${opts.resolveZone})\n` };
    if (values.zone_name !== "auto" && values.asset_public_base !== "auto")
      return { code: 0, output: "auto の行が無い(まだ --accept していないか、既に確定済み)。書き込みなし\n" };
    if (!isBlank(values.zone_name) && values.zone_name !== "auto" && values.zone_name !== zone)
      return { code: 2, output: `zone_name は既に ${values.zone_name}。--resolve-zone には同じゾーンを指定する(違うなら zone_name の行を直す)\n` };
    if (typeof values.install_host !== "string" || !hostInZone(values.install_host, zone))
      return { code: 2, output: `install_host(${values.install_host ?? "未記入"})はゾーン ${zone} に属していない。ゾーンを選び直すか、E2 を聞き直す\n` };
    const r = resolveZone(text, zone);
    return { code: 0, output: renderWritten(r.written), text: r.text };
  }

  if (isConfigured(values)) {
    const issues = checkConfigured(values);
    if (issues.length) return { code: 2, output: renderIssues(issues) };
    const c = configOf(values);
    if (!opts.accept) return { code: 0, output: renderConfigured(values, c) };
    if (!isBlank(values.accepted) && values.accepted !== opts.accept)
      return { code: 2, output: `既に ${values.accepted} で了承済み。別の構成にするなら、下段の構成の行(と accepted)を消してからやり直す\n` };
    if (isBlank(values.accepted) && opts.accept !== "manual") return { code: 2, output: "構成が手で書かれているので、了承は --accept manual で行う\n" };
    const r = writeKeys(text, [["accepted", opts.accept]]);
    return { code: 0, output: renderConfigured({ ...values, accepted: opts.accept }, c), text: r.written.length ? r.text : undefined };
  }

  const issues = checkAnswers(values);
  if (issues.length) return { code: 2, output: renderIssues(issues) };
  const rec = recommend(values);
  if (!opts.accept) return { code: 0, output: renderProposals(values, rec, LIGHTEST) };
  if (opts.accept === "manual") return { code: 2, output: "下段に構成が書かれていないので --accept manual は使えない。recommended か lightest を選ぶ\n" };
  const chosen = opts.accept === "recommended" ? rec : LIGHTEST;
  // アカウントが変わる構成は、人がその変更に同意した印(--confirm-account-change)が無ければ書き込まない
  const change = accountChangeOf(values, chosen);
  if (change && !opts.confirmAccountChange)
    return { code: 2, output: renderAccountChange(values, [opts.accept === "recommended" ? "推奨構成" : "最軽量構成"]).join("\n") };
  const r = writeKeys(text, [...ORDER.map((k) => [k, chosen[k]]), ["accepted", opts.accept]]);
  if (!change) return { code: 0, output: renderWritten(r.written), text: r.text };
  const a = replaceAnswer(r.text, "cloudflare_account", "separate", CHANGE_NOTE[change]);
  return { code: 0, output: renderWritten([...a.written, ...r.written]), text: a.text };
}
