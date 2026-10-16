// 答えから推奨構成と最軽量構成を導く。理由・できないこと・人に頼む作業・課金と止まり方・注意の文言もここで決める
import { featuresOf } from "./questions.mjs";

/**
 * Free の上限に効く使い方と、Workers Paid を推奨する PV の区分(上限の 7 割を超えうる区分)。
 * 履歴(history)は構成によらず効く。Safari 対策は Mode B(サーバー発行 Cookie)を使う構成(dlite_hosts がある)でだけ効く。
 * A/B テストだけなら、割り当てとゴールの計測はブラウザの中で完結し、上限に効かない
 */
export const FREE_LIMITS = {
  history: { label: "約 5 万 PV/日", paidAt: ["30k_70k", "over_70k"], what: "訪問者ごとの履歴の保存" },
  itp: { label: "約 10 万 PV/日", paidAt: ["over_70k"], what: "表示のたびの Cloudflare への問い合わせ(Mode B)" },
};

/** その構成で先に効く上限。履歴が Mode B より低いので先に見る。上限に効かなければ null */
export function limitFor(features, c) {
  if (features.has("history")) return FREE_LIMITS.history;
  if (c.dlite_hosts.length > 0) return FREE_LIMITS.itp;
  return null;
}

export function exceedsFree(features, pv, c) {
  const l = limitFor(features, c);
  return l !== null && l.paidAt.includes(pv);
}

/** 訪問者の表示のたびに Cloudflare(edge)を呼ぶ構成か */
const usesEdge = (features, c) => features.has("history") || c.dlite_hosts.length > 0;

/**
 * ドメインなしの構成の注意の書き出し(人が読む文。「第三者」では像が浮かばないので、誰が・どうやって・なぜ届くかを書く)。
 * WHY_ANYONE は出力の初出だけに残す(render.mjs の firstOnly)
 */
export const WHY_ANYONE = "(タグのアドレスはサイトの HTML に書かれるので、誰でも知ることができる)";
export const FLOOD = `万が一、悪意のある人がプログラムで大量のアクセスを送ってきた場合${WHY_ANYONE}、ドメインなしの構成にはアクセスを制限する仕組み(WAF)を置けないため`;
export const FLOOD_PAID = `${FLOOD}、そのアクセスの分もすべて請求に含まれる(支出の上限も掛けられない)`;

const accountIsPaid = (values) => values.cloudflare_account === "existing" && values.existing_plan === "paid";

/**
 * ドメインなしの構成を、既存のアカウントではなく、この製品用に新しく作る Free のアカウントに入れる理由。入れ替えないなら null。
 * ドメインなしの構成には WAF が無いので、Paid のアカウントでは第三者に使われた分まで上限なく課金され、
 * Free のアカウントでは無料枠を使い切られると同じアカウントのほかの Worker も止まる。
 * 止まると困る Worker の有無を聞いていない(ドメインありと答えた人の最軽量構成)ときは「分からない」と同じに扱う
 * @returns {"paid"|"other_workers"|null}
 */
export function accountChangeOf(values, c) {
  if (values.cloudflare_account !== "existing" || c.edge_address !== "workers-dev") return null;
  if (values.existing_plan === "paid") return "paid";
  if (values.existing_plan === "free" && values.other_workers !== "no") return "other_workers";
  return null;
}

/** 構成 c をとったときの答え。アカウントを入れ替えるなら cloudflare_account を separate にし、理由を accountChange に入れる */
export function answersFor(values, c) {
  const change = accountChangeOf(values, c);
  return change ? { ...values, cloudflare_account: "separate", accountChange: change } : values;
}

/** @typedef {{ edge_address: "route"|"workers-dev", zone_name: string|null, asset_public_base: string, dlite_hosts: string[], plan: "free"|"paid" }} Config */

/** @returns {Config} */
export function recommend(values) {
  const f = featuresOf(values);
  const route = values.site_on_cloudflare === "yes";
  const c = {
    edge_address: route ? "route" : "workers-dev",
    zone_name: route ? "auto" : null,
    asset_public_base: values.image_upload !== true ? "none" : route ? "auto" : "dev-assets",
    dlite_hosts: route && f.has("itp") ? [values.install_host] : [],
    plan: "free",
  };
  // ドメインなしで Paid にすると、上限を掛けられないまま第三者に使われた分まで課金されるので、PV では Paid にしない。
  // 既存の Paid のアカウントでも、ドメインなしなら新しい Free のアカウントに入れる(answersFor)ので Paid にならない
  if (accountIsPaid(answersFor(values, c)) || (route && exceedsFree(f, values.daily_pv, c))) c.plan = "paid";
  return c;
}

/** ゾーンも支払い方法の登録も要らない、最も手軽な構成 */
export const LIGHTEST = Object.freeze({ edge_address: "workers-dev", zone_name: null, asset_public_base: "none", dlite_hosts: Object.freeze([]), plan: "free" });

/** 下段に書かれた構成(省略時は deploy.md の既定: route・Free・Mode B なし) */
export function configOf(values) {
  return {
    edge_address: values.edge_address ?? "route",
    zone_name: values.zone_name ?? null,
    asset_public_base: values.asset_public_base,
    dlite_hosts: Array.isArray(values.dlite_hosts) ? values.dlite_hosts : [],
    plan: values.plan ?? "free",
  };
}

export const sameConfig = (a, b) =>
  a.edge_address === b.edge_address && a.asset_public_base === b.asset_public_base && a.plan === b.plan && a.dlite_hosts.join(",") === b.dlite_hosts.join(",");

export function summaryOf(c, host) {
  const parts = [
    c.edge_address === "route" ? `ドメインあり(${host ?? "設置ホスト"})` : "ドメインなし(*.workers.dev)",
    c.plan === "paid" ? "Workers Paid" : "Free",
    c.asset_public_base === "none"
      ? "画像のアップロードなし"
      : c.asset_public_base === "dev-assets"
        ? "画像のアップロードあり(管理用の Worker 経由で配信)"
        : "画像のアップロードあり(R2 から配信)",
  ];
  if (c.dlite_hosts.length) parts.push("Safari 対策(Mode B)あり");
  return parts.join(" × ");
}

/** 管理画面と control の置き場所(構成の要約には入らないので別の 1 行で出す。既定はどの構成でも *.workers.dev) */
export const placementOf = (c) =>
  c.edge_address === "route"
    ? "管理画面と control(管理用の Worker)は *.workers.dev に置く(自分のドメインに載せるのは任意。デプロイガイド 3.6・4.2)"
    : "管理画面と control(管理用の Worker)も *.workers.dev に置く";

/** 推奨構成を選んだ理由(答えごとに 1 行) */
export function reasonsOf(values, c) {
  const f = featuresOf(values);
  const limit = limitFor(f, c);
  const r = [
    c.edge_address === "route"
      ? "タグを入れるサイトのドメインを Cloudflare で管理しているので、サイトと同じホストで動かす(WAF・キャッシュ・Safari 対策が使える)"
      : "タグを入れるサイトのドメインを Cloudflare で管理していないので、Cloudflare が用意するアドレス(*.workers.dev)で動かす(後からドメインに移せる)",
  ];
  // アカウントの入れ替えの理由は、提示の確認の段落(render.mjs の accountChangeNote)に書く
  if (accountIsPaid(values)) r.push("このアカウントは既に Workers Paid なので、Paid として扱う");
  else if (!limit && f.has("itp")) r.push("この構成では Safari 対策(Mode B: サーバー発行 Cookie)を使えないので、割り当てとゴールの計測は訪問者のブラウザの中で完結し、Free で足りる");
  else if (!limit) r.push("A/B テストとゴールの計測は訪問者のブラウザの中で完結し、Workers の無料枠をほとんど使わないので Free で足りる");
  else if (c.plan === "paid") r.push(`${limit.what}を使い、多い日の PV が Free の上限(${limit.label})の 7 割を超えうるので Workers Paid にする`);
  else if (values.daily_pv === "unknown") r.push(`PV が分からないので Free で始める(${limit.what}を使うので、上限は ${limit.label})`);
  else if (exceedsFree(f, values.daily_pv, c))
    r.push(`多い日の PV が Free の上限(${limit.label})の 7 割を超えうるが、Free にする。Workers Paid にすると、${FLOOD_PAID}`);
  else r.push(`多い日の PV が Free の上限(${limit.label})に収まる見込みなので Free で足りる`);
  r.push(
    c.asset_public_base === "none"
      ? "画像は URL で指定するので、画像の置き場(R2)を使わない(支払い方法の登録が要らない)"
      : c.asset_public_base === "dev-assets"
        ? "画像をアップロードするので R2 を使う。ドメインが無いので、管理用の Worker 経由で配る(R2 から直接配るより遅く、Workers の無料枠を使う)"
        : "画像をアップロードするので R2 を使い、wtt-assets.<ゾーン名> のアドレスで配る",
  );
  if (c.dlite_hosts.length) r.push(`Safari 対策として、${c.dlite_hosts.join(", ")} で Mode B(サーバー発行 Cookie)を使う`);
  return r;
}

/** 答えのうち、その構成ではできないこと */
export function cannotOf(values, c) {
  const f = featuresOf(values);
  const out = [];
  if (f.has("itp") && c.dlite_hosts.length === 0)
    out.push("Safari 対策(Mode B: サーバー発行 Cookie)が使えない。Safari では JavaScript で置いた Cookie が操作なしで 7 日で消え、同じ人が別の人として扱われうる(Mode B はドメインありの構成でだけ使える)");
  if (c.plan === "free" && exceedsFree(f, values.daily_pv, c)) out.push("多い日は Free の上限に達しうる。達した日の残りは出し分けと計測が止まる(ページは元の表示のまま動く)");
  if (values.image_upload === true && c.asset_public_base === "none") out.push("管理画面から画像をアップロードできない(画像の URL を書き換える変更で差し替えられる)");
  if (c.edge_address === "workers-dev") {
    const effect =
      c.plan === "paid"
        ? "、そのアクセスの分もすべて請求に含まれる(支出の上限も掛けられない)"
        : usesEdge(f, c)
          ? "、無料枠を使い切られ、その日は出し分けと計測が止まり、管理画面も使えなくなる"
          : "、無料枠を使い切られ、その日は管理画面が使えなくなる(訪問者への出し分けとゴールの計測はブラウザの中で続く)";
    const others = c.plan === "free" && values.cloudflare_account === "existing" ? "。同じアカウントのほかの Worker も止まる" : "";
    out.push(`${FLOOD}${effect}${others}`);
  }
  return out;
}

/** 人に頼む作業(導入の途中でエージェントが依頼する) */
export function tasksOf(values, c) {
  const t = [];
  if (values.accountChange)
    t.push("この製品用に Free の Cloudflare アカウントを新しく作る(最初に。今のアカウントには入れない。デプロイガイド 0.4 の「アカウントを作る」)");
  else if (values.cloudflare_account === "none" || values.cloudflare_account === "separate")
    t.push("Cloudflare のアカウントを作る(最初に。デプロイガイド 0.4 の「アカウントを作る」)");
  t.push("`wrangler login` でブラウザに出る Cloudflare の画面で「Allow」を押す");
  t.push("Google の OAuth クライアント(管理画面のログイン用)を作る(画面ごとにエージェントが案内する)");
  t.push(`Cloudflare の API トークンを作る: 設置タグの配信ファイルのデプロイ用・使用状況の表示用(どちらも期限なし)${c.edge_address === "route" ? "・ゾーンの設定用(期限 = 翌日)" : ""}`);
  if (c.asset_public_base !== "none") t.push("R2(画像の置き場)を有効にする(支払い方法の登録を求められることがある。無料枠の中なら請求は無い)");
  if (c.plan === "paid" && !accountIsPaid(values)) t.push("ダッシュボードで Workers Paid に切り替える");
  if (c.plan === "paid") t.push("導入の後、管理画面の「設定」→「使用状況」でプランを Workers Paid にする");
  t.push("Google でログインし、画面で動作を確かめる");
  return t;
}

export function billingOf(c) {
  const b = [
    c.plan === "paid"
      ? "Workers Paid: 月 $5 から。含まれる量を超えると自動で従量課金になり、支出の上限は設定できない。上限で止まることは無い"
      : "Free: 請求は起きない。1 日の上限(UTC 0 時に戻る)に達すると、その日の残りは Workers を使う処理が止まる(ページは元の表示のまま動く)",
  ];
  if (c.plan === "paid" && c.edge_address === "workers-dev") b.push(FLOOD_PAID);
  if (c.asset_public_base !== "none") b.push("R2: 無料枠の中なら請求は無い(有効にするとき支払い方法の登録を求められることがある)");
  return b;
}

export function notesOf(values, c) {
  const f = featuresOf(values);
  const n = [];
  if (values.daily_pv === "unknown" && c.plan === "free")
    n.push(
      c.edge_address === "route"
        ? "PV が分からないので Free で始める。管理画面のホームと「設定」→「使用状況」で消費を見て、上限に近づいたら Workers Paid にする"
        : "PV が分からないので Free で始める。管理画面のホームと「設定」→「使用状況」で消費を見て、上限に近づいたら、ドメインを Cloudflare に追加してから Workers Paid にする(デプロイガイド 2.8 でドメインありの構成に移れる)",
    );
  if (c.edge_address === "workers-dev" && c.plan === "free" && exceedsFree(f, values.daily_pv, c))
    n.push("多い日に止めたくないなら、ドメインを Cloudflare に追加してから Workers Paid にする(デプロイガイド 2.8 でドメインありの構成に移れる)");
  if (c.edge_address === "workers-dev" && c.plan === "paid")
    n.push(`このアカウントは Workers Paid。${FLOOD_PAID}。この製品用に Free のアカウントを別に作り、そこに入れることを勧める`);
  // 履歴を選んでいれば、上限の話は構成の理由に既に出ているので、重ねて言わない
  if (!f.has("history")) n.push("導入の後に管理画面で履歴の条件や割り当ての固定を使い始めると、Free の上限が約 5 万 PV/日になる");
  return n;
}
