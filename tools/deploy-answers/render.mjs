// 検査スクリプトの出力(Markdown)。見出しは固定(エージェントは見出しの順に、要約せずにそのまま見せる)
import { summaryOf, placementOf, reasonsOf, cannotOf, tasksOf, billingOf, notesOf, sameConfig, answersFor, FLOOD, FLOOD_PAID, WHY_ANYONE } from "./judge.mjs";

const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- なし");

/** 文の中の phrase を、最初の 1 つだけ残して消す(同じ説明の括弧を出力の中で繰り返さない) */
const firstOnly = (text, phrase) => {
  const i = text.indexOf(phrase);
  return i < 0 ? text : text.slice(0, i + phrase.length) + text.slice(i + phrase.length).split(phrase).join("");
};

function changeReason(values) {
  if (values.existing_plan === "paid") return `既存のアカウントは Workers Paid。${FLOOD_PAID}`;
  const why = values.other_workers === "yes" ? "止まると困る Worker があると答えた" : "止まると困る Worker が無いとは確かめられていない";
  return `${FLOOD}、無料枠を使い切られ、その日は同じアカウントのほかの Worker も止まる(${why})`;
}

const CHANGE_LEAD = "答えでは既存のアカウントに入れる予定だったが、この構成では、この製品用に新しく Free の Cloudflare アカウントを作り、そこに入れる。";

/** 提示の各構成の節の中(要約の下)に出す、アカウントが変わることの確認。行の配列を返す */
function accountChangeNote(values) {
  return [`**確認: アカウントが変わる**: ${CHANGE_LEAD}理由: ${changeReason(values)}。`, ""];
}

/**
 * アカウントが変わることの確認(--confirm-account-change の無い --accept で出す。提示では各構成の節の中に accountChangeNote で出す)。行の配列を返す
 * 人に見せる節なので、人が判断に要ることだけを書く(エージェント向けの扱いは README の 4.・deploy.md 0.2)
 * @param {string[]} names アカウントが変わる案の名前(「推奨構成」「最軽量構成」)
 */
export function renderAccountChange(values, names) {
  const which = names.length > 1 ? "推奨構成と最軽量構成のどちらでも" : `${names[0]}では`;
  return [
    "## 確認: アカウントが変わる", "",
    `**${which}、アカウントが変わる**: ${CHANGE_LEAD}`, "",
    `理由: ${changeReason(values)}。`, "",
  ];
}

/** 推奨構成と最軽量構成の提示 */
export function renderProposals(values, rec, light) {
  const same = sameConfig(rec, light);
  const host = values.install_host;
  // アカウントを入れ替える構成では、入れ替えた後の答え(cloudflare_account: separate)で文言を作る
  const vr = answersFor(values, rec);
  const vl = answersFor(values, light);
  const both = (f) =>
    same ? [list(f(vr, rec)), ""] : ["### 推奨構成の場合", "", list(f(vr, rec)), "", "### 最軽量構成の場合", "", list(f(vl, light)), ""];
  const lines = [
    "## 推奨構成", "",
    `**${summaryOf(rec, host)}**`, "",
    placementOf(rec), "",
    ...(vr.accountChange ? accountChangeNote(values) : []),
    list(reasonsOf(vr, rec)), "",
    "### この構成でできないこと", "",
    list(cannotOf(vr, rec)), "",
    "## 最軽量構成", "",
    ...(same
      ? ["推奨構成と同じ。", ""]
      : [
          `**${summaryOf(light, host)}**`, "",
          placementOf(light), "",
          ...(vl.accountChange ? accountChangeNote(values) : []),
          "ゾーンも支払い方法の登録も要らない、最も手軽な構成。", "",
          "### この構成でできないこと", "",
          list(cannotOf(vl, light)), "",
        ]),
    "## 人に頼む作業", "",
    ...both((v, c) => tasksOf(v, c)),
    "## 課金と止まり方", "",
    ...both((_, c) => billingOf(c)),
    "## 注意", "",
    list(notesOf(vr, rec)), "",
  ];
  return firstOnly(lines.join("\n"), WHY_ANYONE);
}

const ACCEPTED_LABEL = {
  recommended: "推奨構成で了承済み",
  lightest: "最軽量構成で了承済み",
  manual: "手で指定した構成で了承済み",
};

/** 下段に書かれた構成の要約 */
export function renderConfigured(values, c) {
  const label = ACCEPTED_LABEL[values.accepted] ?? "手で指定した構成。未了承(了承は --accept manual)";
  const lines = [
    "## 指定された構成", "",
    `**${summaryOf(c, values.install_host)}**(${label})`, "",
    placementOf(c), "",
    "### この構成でできないこと", "",
    list(cannotOf(values, c)), "",
    "## 人に頼む作業", "",
    list(tasksOf(values, c)), "",
    "## 課金と止まり方", "",
    list(billingOf(c)), "",
    "## 注意", "",
    list(notesOf(values, c)), "",
  ];
  return firstOnly(lines.join("\n"), WHY_ANYONE);
}

export const renderIssues = (issues) => ["## 聞き直す問い", "", ...issues.map((i) => `- ${i.id}(${i.key}): ${i.message}`), ""].join("\n");

export const renderParseErrors = (file, errors) => ["## 書式の誤り", "", ...errors.map((e) => `- ${file} の ${e.line} 行目: ${e.message}`), ""].join("\n");

export const renderWritten = (written) =>
  written.length ? ["## 書き込んだ行", "", ...written.map((w) => `- ${w}`), ""].join("\n") : "書き込みなし(既に書かれている)\n";
