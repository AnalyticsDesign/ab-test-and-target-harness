import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { auditRetentionJob } from "../src/cron/audit-retention";
import { runCron } from "../src/cron/runner";
import type { Env } from "../src/env";
import { BREAK_GLASS, call, createExperiment, createSite, experimentRow, inviteAndJoin, joinWithPassword, setupOwner, siteRow, testEnv, TEXT_CHANGE } from "./helpers";

/**
 * B129 plan Task 13 Step 3(spec §10、Q10・Q21・Q28): 操作の記録の負荷の計測(手元の miniflare の D1)。
 * 合否にするのは D1 の rows_written・rows_read(索引を含む D1 の meta)と同時 20 本の失敗 0 だけ。Worker の CPU は手元では合否に使わない(Q21)。
 * 応答の時間は参考に出すだけ。値は console.log(vitest の stdout に出る)と task.meta(`--reporter=json` の出力の meta)に残す。
 * 手元の D1 は DELETE では索引の項目を rows_written に数えない(INSERT は数える。実装の記録の R52)ので、Cron の削除の rows_written は本番の値ではない
 */

type Entry = { sql: string; read: number; written: number; changes: number; batch: boolean };

/** D1 の呼び出しごとに meta(rows_read・rows_written・changes)を控える D1 ラッパ。first() は all() で流して meta を取る(D1 の first も文の全体を実行する) */
function metered(base: D1Database): { db: D1Database; log(): Entry[]; reset(): void } {
  let log: Entry[] = [];
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const push = (sqlText: string, r: D1Result, batch: boolean) =>
    log.push({ sql: sqlText, read: r.meta.rows_read ?? 0, written: r.meta.rows_written ?? 0, changes: r.meta.changes ?? 0, batch });
  const wrap = (stmt: D1PreparedStatement, sqlText: string): D1PreparedStatement => {
    const w = new Proxy(stmt, {
      get(s, p) {
        if (p === "run" || p === "all")
          return async () => {
            const r = (await (Reflect.get(s, p) as () => Promise<D1Result>).call(s)) as D1Result;
            push(sqlText, r, false);
            return r;
          };
        if (p === "first")
          return async (col?: string) => {
            const r = await s.all<Record<string, unknown>>();
            push(sqlText, r, false);
            const row = r.results[0] ?? null;
            return col === undefined ? row : row === null ? null : (row[col] ?? null);
          };
        if (p === "bind") return (...a: unknown[]) => wrap(s.bind(...a), sqlText);
        const v = Reflect.get(s, p);
        return typeof v === "function" ? v.bind(s) : v;
      },
    });
    real.set(w, stmt);
    sqlOf.set(w, sqlText);
    return w;
  };
  const db = new Proxy(base, {
    get(t, p) {
      if (p === "prepare") return (q: string) => wrap(t.prepare(q), q);
      if (p === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          const out = await t.batch(stmts.map((s) => real.get(s) ?? s));
          out.forEach((r, i) => push(sqlOf.get(stmts[i]!) ?? "?", r, true));
          return out;
        };
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as D1Database;
  return { db, log: () => [...log], reset: () => (log = []) };
}

const sum = (xs: Entry[], k: "read" | "written") => xs.reduce((s, e) => s + e[k], 0);
const isAudit = (e: Entry) => /^\s*insert into "?audit_events"?/i.test(e.sql);
const isList = (e: Entry) => /from "?audit_events"?/i.test(e.sql) && !isAudit(e);
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 測った値を task.meta に置く(`--reporter=json` の出力で読める) */
const keep = (task: { meta: object }, value: unknown) => Object.assign(task.meta, { measured: value });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * データベースの大きさ(バイト)。D1 は PRAGMA page_count・pragma_page_count() を断り(SQLITE_AUTH)、dbstat も無いので、
 * D1 の meta.size_after を使う(保持の Cron が制御用の D1 の大きさに使う値と同じ)
 */
async function dbBytes(): Promise<number> {
  return (await env.DB.prepare("select 1").run()).meta.size_after;
}

/** 記録の行(実際の操作で書いたもの)を型にして、x の順に n 行を 1 文で写す。at は x の順(本番と同じく at・id の順に増える)。 */
const COPY_SQL = `insert into audit_events (at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via,
    actor_user_id, actor_email, actor_name, api_key_id, api_key_name, target_type, target_id, target_label, detail_json)
  with recursive c(x) as (select ?1 union all select x + 1 from c where x + 1 < ?1 + ?2),
  tpl(lo, hi, id, via) as (select value ->> '$[0]', value ->> '$[1]', value ->> '$[2]', value ->> '$[3]' from json_each(?5))
  select ?3 + x * ?4, t.category, t.action, t.workspace_id, t.site_id,
    case when t.experiment_id is null then null else printf('exp_%04d', x % 2000) end,
    t.site_generation, t.experiment_generation, tpl.via, t.actor_user_id, t.actor_email, t.actor_name, t.api_key_id, t.api_key_name,
    t.target_type, case when t.target_type = 'experiment' then printf('exp_%04d', x % 2000) else t.target_id end, t.target_label, t.detail_json
  from c join tpl on tpl.lo <= x % 800 and x % 800 < tpl.hi join audit_events t on t.id = tpl.id
  order by x`;

describe("操作の記録の負荷(B129 Task 13、手元の D1)", () => {
  /**
   * Q10: 29 万行(spec §10.4 の「保存の多い大きな導入」の 365 日)の大きさと、INSERT の rows_written(1 行あたり、索引を含む)。
   * 行の配分(spec §10.4 の 1 日 800 行 = 保存 500 回 × 1.5 行 + その他の操作 50 回。password の割合は spec に数字が無いので置いた仮定):
   *   エクスペリエンスの content(google)735 = 基本設定 245・パターン 245・変更 245 / エクスペリエンスの content(password)15 /
   *   ほかの content(目標の作成。google)30 / access(google。招待の発行)15 / access(password)5
   * 行の形は実際の操作が書いた記録の行を型にする(控えのメール・名前・detail は本物の長さ)。エクスペリエンスの ID は 2,000 本に散らす
   */
  it("size_and_rows_written_of_290k_rows (Q10)", { timeout: 600_000 }, async ({ task }) => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId, { domain: "www.size.example.com" });
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_0000", name: "トップのボタンの色" });
    const base = `/sites/${sid}/experiments/${eid}`;
    const ok = async (method: string, path: string, body: unknown, status = 200) => expect((await call(method, path, { token: owner.token, body })).status).toBe(status);
    await ok("PATCH", base, { name: "トップのボタンの色(2)", trafficPercentage: 50 });
    await ok("PUT", `${base}/variants`, [
      { id: "a", name: "元のページ", weight: 50 },
      { id: "b", name: "緑のボタン", weight: 50 },
    ]);
    await ok("PUT", `${base}/variants/b/changes`, [TEXT_CHANGE()]);
    await ok("POST", `/sites/${sid}/goals`, { id: "g_buy", name: "購入", type: "CUSTOM", config: {} }, 201);
    await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const tplId = async (action: string) => (await env.DB.prepare(`select id from audit_events where action = ?1 order by id limit 1`).bind(action).first<{ id: number }>())!.id;
    const t = {
      update: await tplId("experiment.update"),
      variants: await tplId("experiment.variants"),
      changes: await tplId("experiment.changes"),
      goal: await tplId("goal.create"),
      invite: await tplId("invitation.create"),
    };
    const templates = (
      await env.DB.prepare(`select id, action, length(cast(coalesce(actor_email, '') as blob)) + length(cast(coalesce(actor_name, '') as blob)) + length(cast(coalesce(target_label, '') as blob)) + length(cast(detail_json as blob)) as text_bytes, detail_json from audit_events where id in (?1, ?2, ?3, ?4, ?5)`)
        .bind(t.update, t.variants, t.changes, t.goal, t.invite)
        .all<{ id: number; action: string; text_bytes: number; detail_json: string }>()
    ).results;
    // [lo, hi, 型の id, via](x % 800 がこの範囲の行)
    const mix = JSON.stringify([
      [0, 245, t.update, "google"],
      [245, 490, t.variants, "google"],
      [490, 735, t.changes, "google"],
      [735, 750, t.changes, "password"],
      [750, 780, t.goal, "google"],
      [780, 795, t.invite, "google"],
      [795, 800, t.invite, "password"],
    ]);
    const N = 290_000;
    const CHUNK = 29_000;
    const start = Date.now() - 365 * DAY + HOUR;
    const step = Math.floor((364 * DAY) / N);
    const rowsBefore = (await env.DB.prepare("select count(*) as n from audit_events").first<{ n: number }>())!.n;
    const before = await dbBytes();
    let written = 0;
    let inserted = 0;
    const t0 = performance.now();
    for (let from = 0; from < N; from += CHUNK) {
      const r = await env.DB.prepare(COPY_SQL).bind(from, CHUNK, start, step, mix).run();
      written += r.meta.rows_written ?? 0;
      inserted += r.meta.changes ?? 0;
    }
    const insertMs = performance.now() - t0;
    expect(inserted).toBe(N);
    const after = await dbBytes();
    // 配分ごとの 1 行あたりの rows_written(大きさを測った後に 800 行ずつ足して測る。経路と区分で索引の数が決まる)
    const perClass: Record<string, number> = {};
    const classes: Array<[string, number, string]> = [
      ["experiment content google", t.update, "google"],
      ["experiment content password", t.changes, "password"],
      ["goal content google", t.goal, "google"],
      ["access google", t.invite, "google"],
      ["access password", t.invite, "password"],
    ];
    for (const [name, id, via] of classes) {
      const r = await env.DB.prepare(COPY_SQL).bind(N, 800, start, step, JSON.stringify([[0, 800, id, via]])).run();
      perClass[name] = (r.meta.rows_written ?? 0) / (r.meta.changes ?? 1);
    }
    const bytes = after - before;
    const result = {
      rows: N,
      rowsBefore,
      bytesBefore: before,
      bytesAfter: after,
      bytesOfRows: bytes,
      mbOfRows: +(bytes / 1024 / 1024).toFixed(1),
      bytesPerRow: +(bytes / N).toFixed(1),
      rowsWrittenTotal: written,
      rowsWrittenPerRow: +(written / N).toFixed(3),
      rowsWrittenPerClass: perClass,
      insertMs: Math.round(insertMs),
      templates: templates.map((x) => ({ action: x.action, textBytes: x.text_bytes, detail: x.detail_json })),
    };
    keep(task, result);
    console.log("size_and_rows_written_of_290k_rows", JSON.stringify(result));
    // 合否ではない(spec §10.4 の見積もり 約 175 MB = 0.6 KB / 行 を実測で置き換える)。桁が大きく外れたら落とす
    expect(bytes, JSON.stringify(result)).toBeGreaterThan(0);
    expect(bytes, JSON.stringify(result)).toBeLessThan(175 * 1024 * 1024 * 2);
    // 1 行の rows_written は 主キー 1 + 索引(spec §10.1 の 3〜7。INSERT は手元の D1 も索引の項目を数える)
    expect(perClass, JSON.stringify(result)).toEqual({
      "experiment content google": 4, // at・ws_at・exp_at
      "experiment content password": 6, // + pw_at・ws_pw_at
      "goal content google": 3, // at・ws_at
      "access google": 5, // at・ws_at・access_at・ws_access_at
      "access password": 7, // + pw_at・ws_pw_at
    });
  });

  /**
   * spec §10.1・§10.4: 1 回の保存の rows_written・rows_read(D1 の meta)。保存の batch の中の記録の文の meta だけを引き、記録の前(batch − 記録の文)と後を比べる。
   * 増えた分の見込み = 記録 1 行 3〜7(content × google のエクスペリエンスの行 4、エクスペリエンス以外 3、password の content は +2 で 6)
   */
  it("rows_per_save (spec §10.1)", { timeout: 120_000 }, async ({ task }) => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_save" });
    const pw = await joinWithPassword(owner, "editor");
    const m = metered(env.DB);
    const base = `/sites/${sid}/experiments/${eid}`;
    type SaveMeter = { batchWritten: number; batchRead: number; auditRows: number; auditWritten: number; auditRead: number; beforeWritten: number; beforeRead: number; requestWritten: number; requestRead: number; ms: number };
    const measured: Record<string, SaveMeter> = {};
    const op = async (name: string, method: string, path: string, body: unknown, status = 200, as: { token: string; env?: Partial<Env> } = { token: owner.token }) => {
      m.reset();
      const t0 = performance.now();
      const res = await call(method, path, { token: as.token, body, envOverride: { ...as.env, DB: m.db } });
      const ms = performance.now() - t0;
      expect(res.status, `${name}: ${await res.clone().text()}`).toBe(status);
      const log = m.log();
      const batch = log.filter((e) => e.batch);
      const audit = batch.filter(isAudit);
      measured[name] = {
        batchWritten: sum(batch, "written"),
        batchRead: sum(batch, "read"),
        auditRows: audit.reduce((s, e) => s + e.changes, 0),
        auditWritten: sum(audit, "written"),
        auditRead: sum(audit, "read"),
        beforeWritten: sum(batch, "written") - sum(audit, "written"),
        beforeRead: sum(batch, "read") - sum(audit, "read"),
        requestWritten: sum(log, "written"),
        requestRead: sum(log, "read"),
        ms: Math.round(ms),
      };
    };
    // 典型の操作
    await op("experiment PATCH", "PATCH", base, { name: "New", trafficPercentage: 50 });
    await op("variants PUT (2)", "PUT", `${base}/variants`, [
      { id: "a", name: "A", weight: 50 },
      { id: "b", name: "B", weight: 50 },
    ]);
    await op("changes PUT (1 change)", "PUT", `${base}/variants/b/changes`, [TEXT_CHANGE()]);
    await op("goal create", "POST", `/sites/${sid}/goals`, { id: "g_buy", name: "購入", type: "CUSTOM", config: {} }, 201);
    // 複数のパターンを変える操作: パターンの構成(4 つ)と、3 つのパターンの変更を順に保存
    await op("multi: variants PUT (4)", "PUT", `${base}/variants`, ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase(), weight: 25 })));
    for (const v of ["b", "c", "d"]) await op(`multi: changes PUT ${v}`, "PUT", `${base}/variants/${v}/changes`, [TEXT_CHANGE(`c_${v}`)]);
    // 経路が password(非常口の間のパスワードのセッション)の保存は索引 +2
    await op("experiment PATCH (password)", "PATCH", base, { name: "By password" }, 200, { token: pw.token, env: BREAK_GLASS });
    const multi = Object.entries(measured).filter(([k]) => k.startsWith("multi:"));
    const multiTotal = { auditRows: multi.reduce((s, [, v]) => s + v.auditRows, 0), auditWritten: multi.reduce((s, [, v]) => s + v.auditWritten, 0), beforeWritten: multi.reduce((s, [, v]) => s + v.beforeWritten, 0) };
    const result = { measured, multiTotal };
    keep(task, result);
    console.log("rows_per_save", JSON.stringify(result));
    for (const [name, v] of Object.entries(measured)) {
      expect(v.auditRows, `${name}: ${JSON.stringify(result)}`).toBe(1);
      expect(v.auditWritten, `${name}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(3);
      expect(v.auditWritten, `${name}: ${JSON.stringify(result)}`).toBeLessThanOrEqual(7);
    }
    expect(measured["experiment PATCH"]!.auditWritten).toBe(4);
    expect(measured["goal create"]!.auditWritten).toBe(3);
    expect(measured["experiment PATCH (password)"]!.auditWritten).toBe(6);
    expect(multiTotal.auditRows).toBe(4);
  });

  /**
   * spec §10.5・Q28: 一覧を 20 本同時に開いたとき(変更履歴・ワークスペースの記録・導入全体の記録を 20 本ずつ並列)の失敗 0 と rows_read。
   * 測るデータに「access は 0 行(記録は消せないので、初期設定の 1 行だけ)・変更履歴(content)はある」を入れる。
   * 続けて、保持の Cron(5,000 行がすべて access × password の削除)の batch と同時に 20 本ずつ開く
   */
  it("concurrent_reads_and_retention (spec §10.5)", { timeout: 300_000 }, async ({ task }) => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_read" });
    const w = owner.workspaceId;
    const siteGen = (await siteRow(sid)).generation;
    const expGen = (await experimentRow(sid, eid)).generation;
    const now = Date.now() - 60_000;
    // 新しい content の行: そのエクスペリエンスの今の世代 1,000・同じワークスペースのほかの content 2,000(どちらも 30 日以内)
    const fill = (n: number, o: { at: number; step: number; category: string; via: string; workspace: string | null; site?: string | null; exp?: string | null; expGen?: string | null; action: string }) =>
      env.DB.prepare(
        `insert into audit_events (at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via, actor_user_id, actor_email, actor_name, target_type, target_id, target_label, detail_json)
         with recursive c(x) as (select 0 union all select x + 1 from c where x + 1 < ?1)
         select ?2 - x * ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'Owner', 'experiment', ?8, 'トップのボタンの色', '{"fields":["name"],"name":{"from":"A","to":"B"}}' from c`,
      )
        .bind(n, o.at, o.step, o.category, o.action, o.workspace, o.site ?? null, o.exp ?? null, siteGen, o.expGen ?? null, o.via, owner.userId, owner.email)
        .run();
    await fill(1_000, { at: now, step: 1_000, category: "content", via: "google", workspace: w, site: sid, exp: eid, expGen, action: "experiment.update" });
    await fill(2_000, { at: now - 500, step: 1_000, category: "content", via: "google", workspace: w, site: sid, action: "site.update" });
    expect((await env.DB.prepare(`select count(*) as n from audit_events where workspace_id = ?1 and category = 'access'`).bind(w).first<{ n: number }>())!.n).toBe(1);

    const APIS = {
      history: `/sites/${sid}/experiments/${eid}/history`,
      workspace: `/workspaces/${w}/audit-events`,
      workspaceAccess: `/workspaces/${w}/audit-events?category=access`,
      instance: "/audit-events",
    } as const;
    type One = { status: number; ms: number; read: number; listRead: number; queries: number };
    const one = async (path: string): Promise<One> => {
      const m = metered(env.DB);
      const t0 = performance.now();
      const res = await call("GET", path, { token: owner.token, envOverride: { DB: m.db } });
      await res.arrayBuffer();
      const ms = performance.now() - t0;
      const log = m.log();
      return { status: res.status, ms, read: sum(log, "read"), listRead: sum(log.filter(isList), "read"), queries: log.length };
    };
    const summary = (xs: One[]) => ({
      n: xs.length,
      failures: xs.filter((x) => x.status !== 200).length,
      readMin: Math.min(...xs.map((x) => x.read)),
      readMax: Math.max(...xs.map((x) => x.read)),
      listReadMax: Math.max(...xs.map((x) => x.listRead)),
      queries: Math.max(...xs.map((x) => x.queries)),
      msMedian: Math.round(median(xs.map((x) => x.ms))),
      msMax: Math.round(Math.max(...xs.map((x) => x.ms))),
    });
    const wave = async (): Promise<Record<keyof typeof APIS, ReturnType<typeof summary>>> => {
      const entries = Object.entries(APIS) as Array<[keyof typeof APIS, string]>;
      const runs = await Promise.all(entries.map(async ([k, path]) => [k, await Promise.all(Array.from({ length: 20 }, () => one(path)))] as const));
      return Object.fromEntries(runs.map(([k, xs]) => [k, summary(xs)])) as Record<keyof typeof APIS, ReturnType<typeof summary>>;
    };
    // 1 本だけのとき(基準)
    const single = Object.fromEntries(await Promise.all(Object.entries(APIS).map(async ([k, p]) => [k, summary([await one(p)])])));
    const alone = await wave();

    // 保持の Cron と重ねる: 366 日より前の 5,000 行(すべて access × password)を消す batch と同時に 20 本ずつ
    await fill(5_000, { at: Date.now() - 400 * DAY, step: 1, category: "access", via: "password", workspace: w, action: "member.role_change" });
    const cronMeter = metered(env.DB);
    const cronEnv: Env = { ...testEnv, DB: cronMeter.db };
    const runAt = Math.floor(Date.now() / DAY) * DAY - DAY + 20 * HOUR; // 昨日の UTC 20 時(daily の時刻の後)
    const c0 = performance.now();
    const [cronReport, withCron] = await Promise.all([
      runCron(cronEnv, runAt, [auditRetentionJob]).then((r) => ({ r, ms: performance.now() - c0 })),
      wave(),
    ]);
    const cronLog = cronMeter.log();
    const cron = {
      outcome: cronReport.r,
      ms: Math.round(cronReport.ms),
      rowsWritten: sum(cronLog, "written"),
      deleteWritten: sum(cronLog.filter((e) => /^DELETE FROM audit_events/i.test(e.sql.trim())), "written"),
      d1Calls: cronLog.length,
    };
    const left = (await env.DB.prepare(`select count(*) as n from audit_events where at < ?1`).bind(Date.now() - 366 * DAY).first<{ n: number }>())!.n;
    const result = { single, alone, withCron, cron, oldRowsLeft: left };
    keep(task, result);
    console.log("concurrent_reads_and_retention", JSON.stringify(result));
    const msg = JSON.stringify(result);
    // 合否: 20 本で失敗 0(Cron と重ねても)
    for (const s of [alone, withCron]) for (const [k, v] of Object.entries(s)) expect(v.failures, `${k}: ${msg}`).toBe(0);
    // 読む行(一覧の文。spec §10.2 の絞り込みごとの見込み。1 行あたり 記録 1 + 操作した人の照会 1、導入全体はワークスペースの名前で + 1)
    const perRow = { history: 2, workspace: 2, instance: 3 } as const;
    for (const s of [alone, withCron]) for (const [k, n] of Object.entries(perRow)) expect(s[k as keyof typeof perRow].listReadMax, `${k}: ${msg}`).toBeLessThanOrEqual(n * 101 + 4);
    // 人とアクセス権(access は初期設定の 1 行だけ): 別の content の 3,000 行も、消す前の 5,000 行(別の期間)も読まない
    for (const s of [alone, withCron]) expect(s.workspaceAccess.listReadMax, msg).toBeLessThanOrEqual(4);
    // Cron: 5,000 行を消し、ジョブ全体の rows_written は約 3.5 万以下(Q28。手元の D1 は DELETE の索引を数えないので本番の値ではない)
    expect(cronReport.r, msg).toEqual([{ job: "audit-retention", outcome: "ran" }]);
    expect(left, msg).toBe(0);
    expect(cron.rowsWritten, msg).toBeLessThanOrEqual(5_000 * 7 + 20);
  });
});
