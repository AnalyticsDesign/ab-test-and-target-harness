/**
 * plan12 K7: control の API 契約の基準(test/contract/v<N>.json。N = API_CONTRACT_VERSION)を作る・更新する。
 * 使い方: `pnpm -C apps/control contract:update`(tsx で Node から動かす)
 *
 * - `/openapi.json` は src/app-routes.ts の app から得る(Workers の binding は使わない。ミドルウェアが env を触るので、
 *   形だけの偽の env を渡す。openapi.json を作る経路は D1 も KV も読まない)
 * - 今の契約と今の版の基準を比べ、additive な差は基準に足して書く。breaking な差があれば何も書かずに失敗する
 *   (API_CONTRACT_VERSION を上げれば、新しい v<N+1>.json を今の契約で作る。古い v<N>.json は残す)
 * - 基準から消す変更はここでは起きない(足すだけ)。手で消したら diff のレビューで見る
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { API_CONTRACT_VERSION } from "@wtt/core";
import { app } from "../src/app-routes";
import { updateBaseline } from "../test/contract/diff";
import { normalizeContract, type Baseline, type OpenApiDoc } from "../test/contract/normalize";

/** 認証・DB を使う前に /openapi.json の文書だけが返る。getAuth が env.DB を WeakMap の鍵に使うので、DB だけはオブジェクトにする */
const FAKE_ENV = {
  DB: {},
  BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  AB_CONTROL_URL: "http://localhost:8788",
  AB_ADMIN_URL: "http://localhost:3000",
};

const res = await app.request("/openapi.json", {}, FAKE_ENV as never);
if (res.status !== 200) {
  console.error(`contract:update: /openapi.json が ${res.status} を返しました`);
  process.exit(1);
}
const current = normalizeContract((await res.json()) as OpenApiDoc);

const file = path.join(import.meta.dirname, "../test/contract", `v${API_CONTRACT_VERSION}.json`);
const baseline = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Baseline) : undefined;
const result = updateBaseline(baseline, current, { apiContractVersion: API_CONTRACT_VERSION });

if (!result.ok) {
  console.error(`contract:update: ${result.message}`);
  for (const d of result.details) console.error(`  - ${d}`);
  console.error("基準は変えていません。互換を外す変更(応答のプロパティの削除など)は、packages/core/src/api-contract.ts の API_CONTRACT_VERSION を +1 してから(MIN_CLIENT_VERSION も既定で同じ値に)もう一度実行してください。必要の無い変更なら戻してください");
  process.exit(1);
}
if (!result.changed && baseline) {
  console.log(`contract:update: v${API_CONTRACT_VERSION}.json は今の契約と一致しています(変更なし)`);
} else {
  writeFileSync(file, `${JSON.stringify(result.baseline, null, 2)}\n`);
  console.log(baseline ? `contract:update: v${API_CONTRACT_VERSION}.json に ${result.additive.length} 件の追加を足しました` : `contract:update: v${API_CONTRACT_VERSION}.json を新しく作りました`);
  for (const a of result.additive) console.log(`  + ${a}`);
}
