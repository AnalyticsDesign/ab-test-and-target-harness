import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { assetItemUrls, assetNameCandidates } from "@wtt/core";
import { call, json, setupOwner, inviteAndJoin, createSite, createExperiment, expectEnvelope, runDirect, siteRow } from "./helpers";
import { fakeImages } from "./housekeeping-helpers";
import { countingD1, tripsMatching } from "./d1-trips";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
/** JPEG(JFIF)の先頭 16 バイト */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
/** 画像のアップロードの multipart。B68: 項目は file と(任意の)name だけ。extra で他の項目を足せる(422 の確かめ) */
function form(bytes: Uint8Array, type: string, name = "a.png", extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new File([bytes], name, { type }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

/** ファイルのパートに Content-Type を付けない multipart(宣言が空のとき)。FormData では作れない */
function untypedForm(bytes: Uint8Array, name: string) {
  const enc = new TextEncoder();
  const boundary = "untypedboundary";
  const parts = [enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`), bytes, enc.encode(`\r\n--${boundary}--\r\n`)];
  const raw = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    raw.set(p, offset);
    offset += p.length;
  }
  return { raw, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** WebP の先頭 16 バイト(`RIFF` + サイズ + `WEBP` + `VP8 `) */
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

/** ISO-BMFF コンテナの先頭 16 バイト(box size + `ftyp` + major brand + 予備) */
const isoBmff = (brand: string) =>
  new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand), 0, 0, 0, 0]);

/** n バイトの PNG(先頭だけ本物) */
const pngOf = (n: number) => {
  const b = new Uint8Array(n);
  b.set(PNG);
  return b;
};

type Usage = { count: number; bytes: number; pendingCount: number; pendingBytes: number; maxCount: number; maxBytes: number; maxFileBytes: number };
type UsedBy = { experimentId: string; variantId: string };
type AssetJson = {
  id: string; name: string; publicUrl: string; thumbnailUrl: string | null; thumbnail: string; mime: string; size: number;
  width: number | null; height: number | null; createdAt: number; createdBy: { id: string; name: string | null };
  usedBy: UsedBy[]; deliveredIn: string[]; inUse: boolean; keptAt: number | null;
};
type Uploaded = AssetJson & { renamedFrom?: string; usage: Usage };
type AssetListItem = Omit<AssetJson, "publicUrl" | "thumbnailUrl" | "createdBy"> & { path?: string; publicUrl?: string; thumbnailUrl?: string | null; creator: number };
type AssetList = { urlPrefix: string | null; assets: AssetListItem[]; creators: Array<{ id: string; name: string | null }>; experiments: Record<string, { name: string; status: string; variants: Record<string, string> }>; usage: Usage };

const BASE = "http://localhost:8788/dev-assets";
const upload = (token: string, sid: string, fd: FormData, envOverride?: Partial<typeof env>) => call("POST", `/sites/${sid}/assets`, { token, raw: fd, envOverride });
async function uploadOk(token: string, sid: string, name = "a.png", extra: Record<string, string> = {}, bytes = PNG): Promise<Uploaded> {
  const res = await upload(token, sid, form(bytes, "image/png", name, extra));
  expect(res.status).toBe(201);
  return json<Uploaded>(res);
}
const list = async (token: string, sid: string, query = ""): Promise<AssetList> => {
  const res = await call("GET", `/sites/${sid}/assets${query}`, { token });
  expect(res.status).toBe(200);
  return json<AssetList>(res);
};
const r2Count = async (sid: string) => (await env.ASSETS!.list({ prefix: `sites/${sid}/` })).objects.length;
const rowCount = async (sid: string) => (await env.DB.prepare(`select count(*) as n from assets where site_id = ?`).bind(sid).first<{ n: number }>())!.n;

/** D1 に直接画像の行を入れる(名前の重なり・削除待ちの種) */
async function seedAsset(sid: string, o: { id: string; name: string; size?: number; deletedAt?: number | null; createdAt?: number }): Promise<string> {
  const url = `${BASE}/sites/${sid}/images/${o.id}.png`;
  const at = o.createdAt ?? 1_700_000_000_000;
  await env.DB.prepare(
    `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, deleted_at, updated_at)
     values (?1, ?2, ?3, ?4, ?5, ?6, 'image/png', ?7, 'skipped', 'u', ?8, ?9, ?8)`,
  )
    .bind(o.id, sid, o.name, o.name.replace(/[A-Z]/g, (c) => c.toLowerCase()), `sites/${sid}/images/${o.id}.png`, url, o.size ?? 1, at, o.deletedAt ?? null)
    .run();
  return url;
}

/** 画像の行を足す batch に印を付けるための目印 */
const ASSET_INSERT = Symbol.for("wtt.test.assetInsert");
/** `insert into "assets"` を含む batch だけを `onBatch` に渡す D1 ラッパ(statement の SQL は batch から読めないので、prepare で印を付ける) */
function interceptAssetInsertBatch(db: D1Database, onBatch: (run: () => Promise<D1Result[]>) => Promise<D1Result[]>): D1Database {
  const marked = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === ASSET_INSERT) return true;
        if (p === "bind") return (...args: unknown[]) => marked(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          return /^\s*insert into "assets"/i.test(sqlText) ? marked(stmt) : stmt;
        };
      }
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          // 印の付いた proxy は batch に渡すと本物として扱われないことがあるので、中身(bind 済みの本物)を取り出しては渡さない:
          // D1 の batch は proxy の statement も受ける(failingD1Insert と同じ包み方で実測済み)
          const run = () => target.batch(stmts);
          return stmts.some((s) => (s as unknown as Record<symbol, unknown>)[ASSET_INSERT] === true) ? onBatch(run) : run();
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/** 2 本のアップロードの「足す batch」が両方そろうまで待ち、そろったら到着の順に 1 本ずつ流す(両方の事前の照会が終わった後に INSERT が順に進む) */
function serializeTwoInserts(db: D1Database): D1Database {
  const waiting: Array<{ run: () => Promise<D1Result[]>; done: (r: Promise<D1Result[]>) => void }> = [];
  return interceptAssetInsertBatch(db, (run) =>
    new Promise<D1Result[]>((resolve) => {
      waiting.push({ run, done: resolve });
      if (waiting.length === 2) {
        void (async () => {
          for (const w of waiting) {
            const p = w.run();
            w.done(p);
            await p.catch(() => {});
          }
        })();
      }
    }),
  );
}

/** 「足す batch」を `times` 回、名前の UNIQUE で落とす D1 ラッパ(同時に同じ名前が上がり続けた状態) */
function uniqueFailing(db: D1Database, times: number): { db: D1Database; calls(): number } {
  let n = 0;
  return {
    db: interceptAssetInsertBatch(db, async (run) => {
      n++;
      if (n <= times) throw new Error("D1_ERROR: UNIQUE constraint failed: assets.site_id, assets.name_key: SQLITE_CONSTRAINT");
      return run();
    }),
    calls: () => n,
  };
}

/** 名前の候補の照会(json_each を使う select)の回数を数える D1 ラッパ */
function countingCandidateQueries(db: D1Database): { db: D1Database; count(): number } {
  let n = 0;
  return {
    db: new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "prepare") {
          return (sqlText: string) => {
            if (/select "name_key" from "assets"/i.test(sqlText) && /json_each/i.test(sqlText)) n++;
            return target.prepare(sqlText);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database,
    count: () => n,
  };
}

const putChanges = (token: string, sid: string, eid: string, vid: string, body: unknown[]) =>
  call("PUT", `/sites/${sid}/experiments/${eid}/variants/${vid}/changes`, { token, body });
const imageChange = (src: string, id = "c_img") => ({ id, type: "IMAGE", selector: "img.hero", payload: { src } });
const attrSrcChange = (value: string, id = "c_attr") => ({ id, type: "ATTRIBUTE", selector: "img.side", payload: { name: "src", value } });
const htmlChange = (html: string, id = "c_html") => ({ id, type: "HTML", selector: ".box", payload: { html, position: "append", runScripts: false } });
/** 既定のパターン a はオリジナル(変更を持てない)なので、a にも変更を置くテストはオリジナルを外す */
const bothEditable = async (token: string, sid: string, eid: string) =>
  expect(
    (await call("PUT", `/sites/${sid}/experiments/${eid}/variants`, { token, body: [{ id: "a", name: "A", weight: 50, original: false }, { id: "b", name: "B", weight: 50 }] })).status,
  ).toBe(200);
const addDeliveredRef = (sid: string, aid: string, eid: string) =>
  env.DB.prepare(`insert into asset_delivered_refs (site_id, asset_id, experiment_id) values (?1, ?2, ?3)`).bind(sid, aid, eid).run();

describe("assets: upload (B68 spec §4.2)", () => {
  it("uploads an image to R2 under the site image key and returns the public url", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const a = await uploadOk(ed.token, sid);
    expect(a.publicUrl).toMatch(new RegExp(`^${BASE}/sites/${sid}/images/asset_[a-z0-9]+\\.png$`));
    expect(a).toMatchObject({ name: "a.png", mime: "image/png", size: PNG.byteLength, usedBy: [], deliveredIn: [], inUse: false, keptAt: null, thumbnail: "skipped", thumbnailUrl: null });
    const key = a.publicUrl.slice(BASE.length + 1);
    expect(await env.ASSETS!.head(key)).not.toBeNull();
    const served = await call("GET", `/dev-assets/${key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    // 一覧は VIEWER 以上
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await list(v.token, sid)).assets.map((x) => x.id)).toEqual([a.id]);
    // アップロードした URL は IMAGE Change として受理される
    expect((await putChanges(ed.token, sid, eid, "b", [imageChange(a.publicUrl)])).status).toBe(200);
  });

  it("upload_without_experiment_id_from_the_current_admin_form_is_201", async () => {
    // 今の管理画面(AssetUpload.tsx)は file だけを送る
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const fd = new FormData();
    fd.set("file", new File([PNG], "hero.png", { type: "image/png" }));
    const res = await upload(owner.token, sid, fd);
    expect(res.status).toBe(201);
    expect((await json<Uploaded>(res)).publicUrl).toContain(`/sites/${sid}/images/`);
  });

  it("accepts multipart uploads with a charset parameter alongside the boundary", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const request = new Request("http://control.test", {
      method: "POST",
      body: form(PNG, "image/png", "hero.png"),
    });
    const res = await call("POST", `/sites/${sid}/assets`, {
      token: owner.token,
      raw: await request.arrayBuffer(),
      headers: { "content-type": `${request.headers.get("content-type")}; charset=UTF-8` },
    });
    expect(res.status).toBe(201);
    expect(await json<Uploaded>(res)).toMatchObject({ name: "hero.png", mime: "image/png", size: PNG.length });
  });

  it("upload_rejects_experiment_id_field", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "a.png", { experimentId: eid }));
    expect(res.status).toBe(422);
    const body = await expectEnvelope(res);
    expect(body).toMatchObject({ error: "validation_failed", path: ["experimentId"] });
    expect(body.hint).toContain("画像はサイトに属します");
    // ほかの知らない項目も 422(hint は付けない)
    const other = await upload(owner.token, sid, form(PNG, "image/png", "a.png", { folder: "x" }));
    expect(other.status).toBe(422);
    expect((await expectEnvelope(other)).hint).toBeUndefined();
    expect(await r2Count(sid)).toBe(0);
  });

  it("upload_uses_file_name_as_default_name", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    expect((await uploadOk(owner.token, sid, "  spring banner.png ")).name).toBe("spring banner.png");
    // 空の name はファイル名を使う
    expect((await uploadOk(owner.token, sid, "b.png", { name: "  " })).name).toBe("b.png");
  });

  it("upload_accepts_explicit_name", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid, "IMG_0001.png", { name: "料金ページのバナー" });
    expect(a.name).toBe("料金ページのバナー");
    expect(a.renamedFrom).toBeUndefined();
  });

  it("upload_numbers_duplicate_names", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid, "a.png");
    const second = await uploadOk(owner.token, sid, "a.png");
    expect(second).toMatchObject({ name: "a (2).png", renamedFrom: "a.png" });
  });

  it("upload_name_conflict_is_case_insensitive", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid, "Banner.PNG");
    expect((await uploadOk(owner.token, sid, "banner.png")).name).toBe("banner (2).png");
  });

  it("upload_numbers_100_char_ascii_and_japanese_names", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    for (const base of ["a".repeat(96) + ".png", "あ".repeat(96) + ".png"]) {
      const first = await uploadOk(owner.token, sid, "x.png", { name: base });
      expect(first.name).toBe(base);
      const second = await uploadOk(owner.token, sid, "x.png", { name: base });
      expect(second.name).toBe(assetNameCandidates(base, 2, 1)[0]);
      expect(second.name.length).toBe(100);
      expect(second.name.endsWith(" (2).png")).toBe(true);
    }
  });

  it("upload_numbers_names_with_percent_underscore_backslash", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // LIKE のワイルドカードとして読まれない(a_b と axb を取り違えない)
    await seedAsset(sid, { id: "asset_seed000001", name: "axb%.png" });
    expect((await uploadOk(owner.token, sid, "x.png", { name: "a_b%\\.png" })).name).toBe("a_b%\\.png");
    expect((await uploadOk(owner.token, sid, "x.png", { name: "a_b%\\.png" })).name).toBe("a_b%\\ (2).png");
  });

  it("upload_numbers_across_9_to_10", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAsset(sid, { id: "asset_seed000001", name: "a.png" });
    for (let n = 2; n <= 9; n++) await seedAsset(sid, { id: `asset_seed00000${n}`, name: `a (${n}).png` });
    expect((await uploadOk(owner.token, sid, "a.png")).name).toBe("a (10).png");
  });

  it("upload_uses_next_50_candidates_when_first_50_taken / name_candidates_paginate", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAsset(sid, { id: "asset_seed0000001", name: "a.png" });
    for (let n = 2; n <= 51; n++) await seedAsset(sid, { id: `asset_seed${String(n).padStart(7, "0")}`, name: `a (${n}).png` });
    const counter = countingCandidateQueries(env.DB);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "a.png"), { DB: counter.db });
    expect(res.status).toBe(201);
    expect(await json<Uploaded>(res)).toMatchObject({ name: "a (52).png", renamedFrom: "a.png" });
    expect(counter.count()).toBe(2); // 2〜51 の照会と 52〜101 の照会
  });

  it("upload_name_taken_after_retries_is_409_and_removes_r2_object", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const failing = uniqueFailing(env.DB, 3);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "a.png"), { DB: failing.db });
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body).toMatchObject({ error: "asset_name_taken", path: ["name"] });
    expect(body.hint).toBe("同じ名前の画像が同時に上がりました。もう一度アップロードしてください");
    expect(failing.calls()).toBe(3); // 最初の 1 回 + 書き直し 2 回
    expect(await r2Count(sid)).toBe(0);
    expect(await rowCount(sid)).toBe(0);
    // 2 回までの負けなら、書き直して通る
    const twice = uniqueFailing(env.DB, 2);
    expect((await upload(owner.token, sid, form(PNG, "image/png", "a.png"), { DB: twice.db })).status).toBe(201);
  });

  it("upload_drops_r2_object_when_the_candidate_requery_fails_after_put", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 最初の窓(2〜51)で空いているのは a (51).png だけにする。そこで負けると、書き直しは次の窓(52〜101)を照会する
    await seedAsset(sid, { id: "asset_seed0000001", name: "a.png" });
    for (let n = 2; n <= 50; n++) await seedAsset(sid, { id: `asset_seed${String(n).padStart(7, "0")}`, name: `a (${n}).png` });
    // 2 回目の候補の照会(書き直しのとき)を D1 の失敗にする。1 回目は put の前の照会
    let candidates = 0;
    const FAIL = Symbol("fail");
    const failingSecondCandidates = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "prepare") {
          return (sqlText: string) => {
            const stmt = target.prepare(sqlText);
            if (!(/json_each/i.test(sqlText) && ++candidates === 2)) return stmt;
            const marked = (st: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(st, { get: (x, p) => (p === FAIL ? true : p === "bind" ? (...a: unknown[]) => marked(x.bind(...a)) : ((y) => (typeof y === "function" ? y.bind(x) : y))(Reflect.get(x, p))) });
            return marked(stmt);
          };
        }
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (stmts.some((st) => (st as unknown as Record<symbol, unknown>)[FAIL] === true)) throw new Error("injected candidate query failure");
            return target.batch(stmts);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const failing = uniqueFailing(failingSecondCandidates, 1);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "a.png"), { DB: failing.db });
    expect(res.status).toBe(500);
    expect(candidates).toBe(2);
    expect(await r2Count(sid)).toBe(0);
    expect(await rowCount(sid)).toBe(50); // 種の 50 行だけ
  });

  it("upload_retry_after_unique_conflict_continues_from_known_candidates_without_requery", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 996 枚が hero.png〜hero (996).png。2 回続けて、書く直前にほかのアップロードが候補を取る
    const rows = [{ name: "hero.png" }, ...Array.from({ length: 995 }, (_, i) => ({ name: `hero (${i + 2}).png` }))];
    for (let i = 0; i < rows.length; i += 100) {
      await env.DB.batch(
        rows.slice(i, i + 100).map((r, j) =>
          env.DB.prepare(
            `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, updated_at)
             values (?1, ?2, ?3, ?3, ?4, ?5, 'image/png', 1, 'skipped', 'u', 1700000000000, 1700000000000)`,
          ).bind(`asset_h${String(i + j).padStart(10, "0")}`, sid, r.name, `sites/${sid}/images/h${i + j}.png`, `${BASE}/sites/${sid}/images/h${i + j}.png`),
        ),
      );
    }
    let raced = 0;
    const racing = interceptAssetInsertBatch(env.DB, async (run) => {
      if (raced < 2) {
        raced++;
        await seedAsset(sid, { id: `asset_racer0000${raced}`, name: `hero (${996 + raced}).png` });
      }
      return run();
    });
    const counted = countingD1(racing);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "hero.png"), { DB: counted.DB });
    expect(res.status).toBe(201);
    expect((await json<Uploaded>(res)).name).toBe("hero (999).png");
    const lookups = tripsMatching(counted.trips, /json_each/i);
    const inserts = tripsMatching(counted.trips, /insert into "assets"/i);
    // 候補の照会は最初の batch(2〜51)+ 窓を進めた 19 回(52〜1001)= 20。書き直しでは照会し直さない
    expect(lookups).toBe(20);
    expect(inserts).toBe(3);
    // 要求全体の D1 の呼び出し(セッション・loadSite・凍結の確かめを含む。縮小版は Images なしで作らない)
    expect(counted.trips.length).toBe(28); // 入口の 5(凍結・セッション 2・loadSite 2)+ 照会 20 + 書き込み 3
    expect(counted.trips.length).toBeLessThanOrEqual(30);
  });

  it("upload_name_lookups_over_budget_is_409_and_removes_r2_object", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 照会 25 回(上限)の後も空きが無い: 1,250 枚より多い同じ本体の名前(上限の枚数を広げた導入)
    const names = ["x.png", ...Array.from({ length: 1260 }, (_, i) => `x (${i + 2}).png`)];
    for (let i = 0; i < names.length; i += 100) {
      await env.DB.batch(
        names.slice(i, i + 100).map((n, j) =>
          env.DB.prepare(
            `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, updated_at)
             values (?1, ?2, ?3, ?3, ?4, ?5, 'image/png', 1, 'skipped', 'u', 1700000000000, 1700000000000)`,
          ).bind(`asset_x${String(i + j).padStart(10, "0")}`, sid, n, `sites/${sid}/images/x${i + j}.png`, `${BASE}/sites/${sid}/images/x${i + j}.png`),
        ),
      );
    }
    const counted = countingD1(env.DB);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "x.png"), { DB: counted.DB, AB_ASSET_SITE_MAX_COUNT: "5000" });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "asset_name_taken", path: ["name"] });
    expect(tripsMatching(counted.trips, /json_each/i)).toBe(25);
    expect(await r2Count(sid)).toBe(0);
  });

  it("upload_name_conflict_with_a_row_inserted_just_before_the_write_is_renumbered", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 照会の後・書く直前に、同じ名前の行が入った(同時に同じ名前を上げた)
    let seeded = false;
    const db = interceptAssetInsertBatch(env.DB, async (run) => {
      if (!seeded) {
        seeded = true;
        await seedAsset(sid, { id: "asset_racer00001", name: "a.png" });
      }
      return run();
    });
    const res = await upload(owner.token, sid, form(PNG, "image/png", "a.png"), { DB: db });
    expect(res.status).toBe(201);
    expect((await json<Uploaded>(res)).name).toBe("a (2).png");
  });

  it("upload_key_has_no_file_name", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid, "secret-project-tanaka.png");
    expect(a.publicUrl).not.toContain("secret");
    const obj = await env.ASSETS!.head(a.publicUrl.slice(BASE.length + 1));
    expect(obj!.customMetadata ?? {}).toEqual({});
  });

  it("upload_rejected_when_count_limit_reached", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const limit = { AB_ASSET_SITE_MAX_COUNT: "1" };
    expect((await upload(owner.token, sid, form(PNG, "image/png"), limit)).status).toBe(201);
    const res = await upload(owner.token, sid, form(PNG, "image/png", "b.png"), limit);
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body).toMatchObject({ error: "asset_quota_exceeded", usage: { count: 1, maxCount: 1 } });
    expect(await r2Count(sid)).toBe(1);
  });

  it("upload_rejected_when_total_bytes_exceeded", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // 合計 1MB まで。0.6MB を 2 枚目で超える
    const limit = { AB_ASSET_SITE_MAX_MB: "1" };
    expect((await upload(owner.token, sid, form(pngOf(600 * 1024), "image/png"), limit)).status).toBe(201);
    const res = await upload(owner.token, sid, form(pngOf(600 * 1024), "image/png", "b.png"), limit);
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "asset_quota_exceeded", usage: { count: 1, bytes: 600 * 1024, maxBytes: 1024 * 1024 } });
    expect(await r2Count(sid)).toBe(1);
  });

  it("concurrent_uploads_do_not_exceed_count_limit", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const db = serializeTwoInserts(env.DB);
    const o = { DB: db, AB_ASSET_SITE_MAX_COUNT: "1" };
    const results = await Promise.all([upload(owner.token, sid, form(PNG, "image/png", "a.png"), o), upload(owner.token, sid, form(PNG, "image/png", "b.png"), o)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await rowCount(sid)).toBe(1);
    expect(await r2Count(sid)).toBe(1); // 負けた側の R2 のファイルは消える
  });

  it("concurrent_uploads_report_post_batch_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const db = serializeTwoInserts(env.DB);
    const results = await Promise.all([upload(owner.token, sid, form(PNG, "image/png", "a.png"), { DB: db }), upload(owner.token, sid, form(PNG, "image/png", "b.png"), { DB: db })]);
    const bodies = await Promise.all(results.map((r) => json<Uploaded>(r)));
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    // 後に足した方の 201 は両方の画像を数える(照会の値に 1 枚を足して作らない)
    expect(bodies.map((b) => b.usage.count).sort()).toEqual([1, 2]);
    expect(Math.max(...bodies.map((b) => b.usage.bytes))).toBe(2 * PNG.byteLength);
  });

  it("quota_conflict_409_includes_winner_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const db = serializeTwoInserts(env.DB);
    const o = { DB: db, AB_ASSET_SITE_MAX_COUNT: "1" };
    const results = await Promise.all([upload(owner.token, sid, form(PNG, "image/png", "a.png"), o), upload(owner.token, sid, form(PNG, "image/png", "b.png"), o)]);
    const loser = results.find((r) => r.status === 409)!;
    expect(await expectEnvelope(loser)).toMatchObject({ error: "asset_quota_exceeded", usage: { count: 1, bytes: PNG.byteLength } });
  });

  it("upload_counts_pending_deletion_toward_limits", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAsset(sid, { id: "asset_pending001", name: "old.png", deletedAt: Date.now() });
    const res = await upload(owner.token, sid, form(PNG, "image/png"), { AB_ASSET_SITE_MAX_COUNT: "1" });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ usage: { count: 1, pendingCount: 1 } });
    // 削除待ちの名前も重なりに残る
    expect((await uploadOk(owner.token, sid, "old.png")).name).toBe("old (2).png");
  });

  it("upload_response_has_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    expect(a.usage).toEqual({ count: 1, bytes: PNG.byteLength, pendingCount: 0, pendingBytes: 0, maxCount: 1000, maxBytes: 1024 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024 });
    expect(a.createdBy.id).toBe(owner.userId);
  });

  it("upload_thumbnail_state_follows_images_binding", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    // Images の binding がある導入は縮小版を作る(作るのは別の段)ので pending
    const res = await upload(owner.token, sid, form(PNG, "image/png"), { IMAGES: {} as ImagesBinding });
    expect((await json<Uploaded>(res)).thumbnail).toBe("pending");
    const row = await env.DB.prepare(`select thumb_state from assets where site_id = ?`).bind(sid).first<{ thumb_state: string }>();
    expect(row!.thumb_state).toBe("pending");
  });

  it("asset_upload_415_hint_names_the_actual_format_when_it_differs_from_the_declared_one (B66 / W9)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const up = (bytes: Uint8Array, type: string, name: string) => upload(owner.token, sid, form(bytes, type, name));
    // 中身が JPEG の `.png`(ブラウザは拡張子から image/png を宣言する)。対応形式を並べるだけでは原因が分からない
    let res = await up(JPEG, "image/png", "photo.png");
    expect(res.status).toBe(415);
    let body = await expectEnvelope(res);
    expect(body).toMatchObject({ error: "unsupported_media_type", declared: "image/png", detected: "image/jpeg" });
    expect(body.message).toContain("拡張子");
    expect(body.hint).toContain("JPEG");
    expect(body.hint).toContain("PNG");
    expect(body.hint).toContain(".jpg");
    for (const [bytes, type, name, detected, label] of [
      [PNG, "text/html", "x.html", "image/png", "PNG"],
      [WEBP, "application/octet-stream", "photo.webp", "image/webp", "WebP"],
      [JPEG, "application/octet-stream", "photo.jpg", "image/jpeg", "JPEG"],
      [JPEG, "image/jpg", "photo.jpg", "image/jpeg", "JPEG"],
    ] as const) {
      res = await up(bytes, type, name);
      expect(res.status).toBe(415);
      body = await expectEnvelope(res);
      expect(body).toMatchObject({ declared: type, detected });
      expect(body.message).not.toContain("拡張子");
      expect(body.hint).toContain(`ファイルの中身は ${label} ですが`);
      expect(body.hint).toContain(type);
      expect(body.hint).toContain(`Content-Type を ${detected} にしてください`);
      expect(body.hint).not.toContain("拡張子を実際の形式に合わせて");
    }
    // 宣言が空(ファイルのパートに Content-Type が無い)。FormData は空の type を application/octet-stream にするので、multipart を手で組む
    res = await call("POST", `/sites/${sid}/assets`, { token: owner.token, ...untypedForm(WEBP, "photo.webp") });
    expect(res.status).toBe(415);
    body = await expectEnvelope(res);
    expect(body).toMatchObject({ declared: "", detected: "image/webp" });
    expect(body.message).not.toContain("拡張子");
    expect(body.hint).toContain("形式の指定がないまま送られています");
    expect(body.hint).toContain("Content-Type を image/webp にしてください");
    expect(body.hint).not.toContain("拡張子を実際の形式に合わせて");
    for (const [bytes, type, name] of [
      [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png", "x.png"],
      [PNG.slice(0, 8), "image/png", "short.png"],
    ] as const) {
      res = await up(bytes, type, name);
      expect(res.status).toBe(415);
      body = await expectEnvelope(res);
      expect(body.detected).toBeUndefined();
      expect(body.hint).toContain("PNG / JPEG / GIF / WebP / AVIF");
      expect(body.hint).not.toContain("ですが");
      expect(body.hint).toContain("拡張子とファイルの中身の両方で確かめています");
    }
    expect(await r2Count(sid)).toBe(0);
  });

  it("asset_upload_returns_415_not_500_when_the_declared_type_is_an_object_prototype_name (B134)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    for (const type of ["constructor", "__proto__"]) {
      for (const bytes of [PNG, new TextEncoder().encode("not an image at all")]) {
        const res = await upload(owner.token, sid, form(bytes, type, "x.png"));
        expect(res.status).toBe(415);
        expect(await expectEnvelope(res)).toMatchObject({ error: "unsupported_media_type", declared: type });
      }
    }
    expect(await r2Count(sid)).toBe(0);
  });

  it("asset_upload_rejects_non_image_and_over_limit", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    let res = await upload(owner.token, sid, form(new TextEncoder().encode("<svg/>"), "image/png", "x.png"));
    expect(res.status).toBe(415);
    expect((await json(res)).error).toBe("unsupported_media_type");
    res = await upload(owner.token, sid, form(PNG, "text/html", "x.html"));
    expect(res.status).toBe(415);
    await expectEnvelope(res);
    res = await upload(owner.token, sid, form(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", "x.svg"));
    expect(res.status).toBe(415);
    res = await upload(owner.token, sid, form(isoBmff("mp42"), "image/avif", "x.avif"));
    expect(res.status).toBe(415);
    await expectEnvelope(res);
    // 上限(env AB_ASSET_MAX_MB)超過。テストでは 1MB に下げる
    res = await upload(owner.token, sid, form(pngOf(1024 * 1024 + 1), "image/png"), { AB_ASSET_MAX_MB: "1" });
    expect(res.status).toBe(413);
    expect(await json(res)).toMatchObject({ error: "asset_too_large", maxMb: 1 });
    expect(await r2Count(sid)).toBe(0);
    expect((await list(owner.token, sid)).assets.length).toBe(0);
    res = await upload(owner.token, sid, form(isoBmff("avif"), "image/avif", "x.avif"));
    expect(res.status).toBe(201);
    expect(await json<Uploaded>(res)).toMatchObject({ mime: "image/avif" });
    // VIEWER は 403(認可判定は roles.ts の loadSite)
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await upload(v.token, sid, form(PNG, "image/png"))).status).toBe(403);
    // 別 Workspace の ADMIN(= 非メンバー)は 404
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const outsider = await inviteAndJoin(owner.token, second.id, "admin");
    expect((await upload(outsider.token, sid, form(PNG, "image/png"))).status).toBe(404);
  });
});

describe("assets: list (B68 spec §4.1)", () => {
  it("list_returns_assets_experiments_and_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { name: "料金ページ" });
    await bothEditable(owner.token, sid, eid);
    const a = await uploadOk(owner.token, sid, "a.png");
    const b = await uploadOk(owner.token, sid, "b.png");
    expect((await putChanges(owner.token, sid, eid, "a", [imageChange(a.publicUrl)])).status).toBe(200);
    expect((await putChanges(owner.token, sid, eid, "b", [imageChange(a.publicUrl), attrSrcChange(b.publicUrl)])).status).toBe(200);
    const l = await list(owner.token, sid);
    expect(l.assets.map((x) => x.id)).toEqual([b.id, a.id]); // 新しい順
    expect(Object.keys(l.experiments)).toEqual([eid]); // 名前は 1 回だけ
    expect(l.experiments[eid]).toMatchObject({ name: "料金ページ", status: "draft" });
    expect(Object.keys(l.experiments[eid]!.variants).sort()).toEqual(["a", "b"]);
    expect(l.usage).toMatchObject({ count: 2, bytes: 2 * PNG.byteLength, pendingCount: 0, pendingBytes: 0 });
    // 作った人は上の段の creators(配列)に 1 回だけ。各件は添字だけ(I5・Q331)
    expect(l.assets.map((x) => x.creator)).toEqual([0, 0]);
    expect(l.assets[1]).not.toHaveProperty("createdBy");
    expect(l.creators).toEqual([{ id: owner.userId, name: expect.any(String) }]);
  });

  it("list_used_by_image_and_attribute_src", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: e1 } = await createExperiment(owner.token, sid);
    const { id: e2 } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid, "a.png");
    const html = await uploadOk(owner.token, sid, "html.png");
    expect((await putChanges(owner.token, sid, e1, "b", [imageChange(a.publicUrl), htmlChange(`<img src="${html.publicUrl}">`)])).status).toBe(200);
    await bothEditable(owner.token, sid, e2);
    expect((await putChanges(owner.token, sid, e2, "a", [attrSrcChange(a.publicUrl)])).status).toBe(200);
    // 終了したテストのパターンも出る
    await runDirect(sid, e2, "archived");
    const l = await list(owner.token, sid);
    const got = l.assets.find((x) => x.id === a.id)!;
    expect(got.usedBy).toEqual(expect.arrayContaining([{ experimentId: e1, variantId: "b" }, { experimentId: e2, variantId: "a" }]));
    expect(got.usedBy).toHaveLength(2);
    expect(got.inUse).toBe(true);
    expect(l.experiments[e2]!.status).toBe("archived");
    // HTML の中の URL は数えない
    expect(l.assets.find((x) => x.id === html.id)!).toMatchObject({ usedBy: [], inUse: false });
  });

  it("list_delivered_in_from_refs", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid, { name: "公開済み" });
    const a = await uploadOk(owner.token, sid);
    await addDeliveredRef(sid, a.id, eid);
    const l = await list(owner.token, sid);
    expect(l.assets[0]).toMatchObject({ usedBy: [], deliveredIn: [eid], inUse: true });
    expect(l.experiments[eid]).toMatchObject({ name: "公開済み" });
  });

  it("list_excludes_pending_deletion_but_counts_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    await seedAsset(sid, { id: "asset_pending001", name: "old.png", size: 100, deletedAt: Date.now() });
    const l = await list(owner.token, sid);
    expect(l.assets.map((x) => x.id)).toEqual([a.id]);
    expect(l.usage).toMatchObject({ count: 2, bytes: PNG.byteLength + 100, pendingCount: 1, pendingBytes: 100 });
  });

  it("list_kept_at", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    await env.DB.prepare(`update assets set kept_at = 1234 where id = ?`).bind(a.id).run();
    expect((await list(owner.token, sid)).assets[0]!.keptAt).toBe(1234);
  });

  it("list_items_carry_path_and_rebuild_the_exact_public_url (I5)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const up = await uploadOk(owner.token, sid, "hero.png");
    // 公開ベースを変える前に上げた画像(今の urlPrefix で始まらない)は publicUrl をそのまま載せる
    await seedAsset(sid, { id: "asset_oldbase01", name: "old.png" });
    await env.DB.prepare(`update assets set public_url = ?1 where id = 'asset_oldbase01'`).bind(`https://old.example/sites/${sid}/images/asset_oldbase01.png`).run();
    const l = await list(owner.token, sid);
    expect(l.urlPrefix).toBe(`${BASE}/sites/${sid}/`);
    const byId = new Map(l.assets.map((x) => [x.id, x]));
    const mine = byId.get(up.id)!;
    expect(mine.path).toBe(`images/${up.id}.png`);
    expect(mine).not.toHaveProperty("publicUrl");
    expect(assetItemUrls(l.urlPrefix!, mine).publicUrl).toBe(up.publicUrl);
    const old = byId.get("asset_oldbase01")!;
    expect(old).toMatchObject({ publicUrl: `https://old.example/sites/${sid}/images/asset_oldbase01.png` });
    expect(old).not.toHaveProperty("path");
    // 戻した URL で IMAGE を保存できる(control の確かめが照らす public_url と同じ)
    const { id: eid } = await createExperiment(owner.token, sid);
    expect((await putChanges(owner.token, sid, eid, "b", [imageChange(assetItemUrls(l.urlPrefix!, mine).publicUrl)])).status).toBe(200);
  });

  it("list_without_r2_reports_zero_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid);
    const res = await call("GET", `/sites/${sid}/assets`, { token: owner.token, envOverride: { ASSETS: undefined, AB_ASSET_SITE_MAX_COUNT: "7" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      urlPrefix: null,
      assets: [],
      creators: [],
      experiments: {},
      usage: { count: 0, bytes: 0, pendingCount: 0, pendingBytes: 0, maxCount: 7, maxBytes: 1024 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024 },
    });
  });

  it("list_viewer_can_read / list_other_workspace_404", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid);
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await list(v.token, sid)).assets).toHaveLength(1);
    const second = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
    const outsider = await inviteAndJoin(owner.token, second.id, "admin");
    expect((await call("GET", `/sites/${sid}/assets`, { token: outsider.token })).status).toBe(404);
  });

  it("list_ignores_experiment_id_query", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid);
    expect((await list(owner.token, sid, "?experimentId=exp_other")).assets).toHaveLength(1);
  });

  it("list_reports_skipped_for_pending_thumbnails_without_images_binding", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAsset(sid, { id: "asset_migrated01", name: "画像(asset_migrated01)" });
    await env.DB.prepare(`update assets set thumb_state = 'pending' where id = 'asset_migrated01'`).run();
    const l = await list(owner.token, sid);
    expect(l.assets[0]).toMatchObject({ thumbnail: "skipped" });
    expect(assetItemUrls(l.urlPrefix!, l.assets[0]!).thumbnailUrl).toBeNull();
    const withImages = await call("GET", `/sites/${sid}/assets`, { token: owner.token, envOverride: { IMAGES: {} as ImagesBinding } });
    expect((await json<AssetList>(withImages)).assets[0]!.thumbnail).toBe("pending");
  });
});

describe("assets: rename (B68 spec §4.3)", () => {
  const rename = (token: string, sid: string, aid: string, body: unknown, envOverride?: Partial<typeof env>) =>
    call("PATCH", `/sites/${sid}/assets/${aid}`, { token, body, envOverride });

  it("rename_changes_name_but_not_public_url", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const res = await rename(owner.token, sid, a.id, { name: "  新しい名前.png " });
    expect(res.status).toBe(200);
    const body = await json<Uploaded>(res);
    expect(body).toMatchObject({ id: a.id, name: "新しい名前.png", publicUrl: a.publicUrl, usedBy: [] });
    expect((await list(owner.token, sid)).assets[0]!.name).toBe("新しい名前.png");
  });

  it("rename_rejects_empty_and_over_100_chars_without_truncating", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    for (const name of ["   ", "\u0001", "a".repeat(101)]) {
      const res = await rename(owner.token, sid, a.id, { name });
      expect(res.status).toBe(422);
      expect(await expectEnvelope(res)).toMatchObject({ error: "validation_failed", path: ["name"] });
    }
    expect((await rename(owner.token, sid, a.id, { name: "a".repeat(100) })).status).toBe(200);
    // 知らない欄は 422(strict)
    expect((await rename(owner.token, sid, a.id, { name: "x", experimentId: "e" })).status).toBe(422);
  });

  it("rename_conflict_returns_409_with_path", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid, "a.png");
    const b = await uploadOk(owner.token, sid, "b.png");
    const res = await rename(owner.token, sid, b.id, { name: "a.png" });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "asset_name_taken", path: ["name"] });
    // 自分と同じ名前(大文字・小文字だけ違う)は重なりではない
    expect((await rename(owner.token, sid, b.id, { name: "B.png" })).status).toBe(200);
  });

  it("rename_conflict_case_insensitive_and_nfc", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await uploadOk(owner.token, sid, "x.png", { name: "Banner.png" });
    await uploadOk(owner.token, sid, "x.png", { name: "が.png" });
    const c = await uploadOk(owner.token, sid, "c.png");
    expect((await rename(owner.token, sid, c.id, { name: "BANNER.PNG" })).status).toBe(409);
    // NFD の「が」(か + 濁点)は NFC にそろえてから比べる
    expect((await rename(owner.token, sid, c.id, { name: "が.png" })).status).toBe(409);
  });

  it("rename_conflicts_with_pending_deletion_name", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAsset(sid, { id: "asset_pending001", name: "old.png", deletedAt: Date.now() });
    const a = await uploadOk(owner.token, sid);
    const res = await rename(owner.token, sid, a.id, { name: "old.png" });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).hint).toContain("削除待ちの画像も含みます");
  });

  it("rename_does_not_mark_unpublished", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const before = await siteRow(sid);
    expect((await rename(owner.token, sid, a.id, { name: "z.png" })).status).toBe(200);
    const after = await siteRow(sid);
    expect(after.content_updated_at).toBe(before.content_updated_at);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("rename_response_has_usage", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const body = await json<Uploaded>(await rename(owner.token, sid, a.id, { name: "z.png" }));
    expect(body.usage).toMatchObject({ count: 1, bytes: PNG.byteLength });
  });

  it("rename_pending_deletion_404 / missing 404", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await seedAsset(sid, { id: "asset_pending001", name: "old.png", deletedAt: Date.now() });
    expect((await rename(owner.token, sid, "asset_pending001", { name: "new.png" })).status).toBe(404);
    expect((await rename(owner.token, sid, "asset_missing01", { name: "new.png" })).status).toBe(404);
  });

  it("rename_viewer_403 / rename_without_r2_409", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await rename(v.token, sid, a.id, { name: "z.png" })).status).toBe(403);
    const res = await rename(owner.token, sid, a.id, { name: "z.png" }, { ASSETS: undefined });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("image_upload_disabled");
  });
});

describe("assets: delete = pending deletion (B68 spec §4.4)", () => {
  const del = (token: string, sid: string, aid: string, envOverride?: Partial<typeof env>) => call("DELETE", `/sites/${sid}/assets/${aid}`, { token, envOverride });

  it("delete_unused_marks_pending_and_keeps_r2", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const before = Date.now();
    const res = await del(owner.token, sid, a.id);
    expect(res.status).toBe(200);
    const body = await json<{ status: string; purgeAfter: number; usage: Usage }>(res);
    expect(body.status).toBe("pending_deletion");
    expect(body.purgeAfter).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(body.usage).toMatchObject({ count: 1, pendingCount: 1, pendingBytes: PNG.byteLength });
    // R2 には触れない(縮小版もあれば残る)
    await env.ASSETS!.put(`sites/${sid}/thumbs/${a.id}.webp`, new Uint8Array([1]));
    expect(await r2Count(sid)).toBe(2);
    const row = await env.DB.prepare(`select deleted_at, deleted_by from assets where id = ?`).bind(a.id).first<{ deleted_at: number; deleted_by: string }>();
    expect(row).toMatchObject({ deleted_by: owner.userId });
    expect(row!.deleted_at).toBeGreaterThanOrEqual(before);
    expect((await list(owner.token, sid)).assets).toHaveLength(0);
  });

  it("delete_success_reads_assets_only_in_the_mark_batch", async () => {
    // 成功の経路は印の 1 文 + 使用量の読みの 1 batch だけ。assets を読む別の往復(先の SELECT)をしない
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    let outside = 0;
    let batches = 0;
    const counted = (st: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(st, {
        get(x, p) {
          if (p === "run" || p === "first" || p === "all" || p === "raw") {
            outside++;
          }
          if (p === "bind") return (...args: unknown[]) => counted(x.bind(...args));
          const y = Reflect.get(x, p);
          return typeof y === "function" ? y.bind(x) : y;
        },
      });
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "prepare") return (sqlText: string) => (/"assets"/.test(sqlText) ? counted(target.prepare(sqlText)) : target.prepare(sqlText));
        if (prop === "batch") return (stmts: D1PreparedStatement[]) => (batches++, target.batch(stmts));
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    expect((await del(owner.token, sid, a.id, { DB: db })).status).toBe(200);
    expect(outside).toBe(0);
    expect(batches).toBe(1);
  });

  it("delete_blocked_by_draft_image_src", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid);
    await putChanges(owner.token, sid, eid, "b", [imageChange(a.publicUrl)]);
    const res = await del(owner.token, sid, a.id);
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body).toMatchObject({ error: "asset_in_use", usedBy: [{ experimentId: eid, variantId: "b" }], deliveredIn: [] });
    expect(body.hint).toBe("パターンの変更から外してください。公開したときの内容で使われている画像は、そのエクスペリエンスを削除するまで削除できません");
  });

  it("delete_in_use_reads_reasons_in_two_trips (M1: 0 行の理由は 行の有無 1 + 使い方 1 batch = 最大 8)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid);
    await putChanges(owner.token, sid, eid, "b", [imageChange(a.publicUrl)]);
    const counted = countingD1(env.DB);
    const res = await del(owner.token, sid, a.id, { DB: counted.DB });
    expect(res.status).toBe(409);
    // 入口の 5(凍結・セッション 2・loadSite 2)+ 印の batch 1 + 行の有無 1 + 使い方の batch 1(下書き・公開したときの定義の 2 文)
    expect(counted.trips.length).toBe(8);
  });

  it("delete_frozen_after_the_gate_uses_at_most_9_trips (M1)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const counted = countingD1(env.DB, {
      match: /update "assets" set "deleted_at"/i,
      run: () => env.DB.prepare(`insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{"reason":"test"}', 1)`).run(),
    });
    const res = await del(owner.token, sid, a.id, { DB: counted.DB });
    expect(res.status).toBe(503);
    expect(counted.trips.length).toBe(9); // 上の 8 + 凍結の読み直し 1
  });

  it("delete_blocked_by_draft_attribute_src", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid);
    await bothEditable(owner.token, sid, eid);
    expect((await putChanges(owner.token, sid, eid, "a", [attrSrcChange(a.publicUrl)])).status).toBe(200);
    const res = await del(owner.token, sid, a.id);
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ usedBy: [{ experimentId: eid, variantId: "a" }] });
  });

  it("delete_blocked_by_delivered_definition", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid);
    await addDeliveredRef(sid, a.id, eid);
    const res = await del(owner.token, sid, a.id);
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "asset_in_use", usedBy: [], deliveredIn: [eid] });
  });

  it("delete_blocked_for_archived_experiment", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid);
    await putChanges(owner.token, sid, eid, "b", [imageChange(a.publicUrl)]);
    await runDirect(sid, eid, "archived");
    expect((await del(owner.token, sid, a.id)).status).toBe(409);
  });

  it("delete_not_blocked_by_html_only_use", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const a = await uploadOk(owner.token, sid);
    await putChanges(owner.token, sid, eid, "b", [htmlChange(`<img src="${a.publicUrl}">`)]);
    expect((await list(owner.token, sid)).assets[0]!.inUse).toBe(false);
    expect((await del(owner.token, sid, a.id)).status).toBe(200);
  });

  it("delete_ignores_other_site_changes", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: other } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    // 別のサイトの変更に同じ URL を直接書く(保存の口は別のサイトの URL を受けないので D1 に直接入れる)
    const { id: eid } = await createExperiment(owner.token, other);
    await env.DB.prepare(
      `insert into changes (site_id, experiment_id, variant_id, id, type, selector, payload_json, position, created_by, updated_by, created_at, updated_at)
       values (?1, ?2, 'b', 'c_x', 'IMAGE', 'img', ?3, 0, 'u', 'u', 1, 1)`,
    )
      .bind(other, eid, JSON.stringify({ src: a.publicUrl }))
      .run();
    expect((await del(owner.token, sid, a.id)).status).toBe(200);
  });

  it("delete_pending_again_is_404 / delete_missing_404", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    expect((await del(owner.token, sid, a.id)).status).toBe(200);
    expect((await del(owner.token, sid, a.id)).status).toBe(404);
    expect((await del(owner.token, sid, "asset_missing01")).status).toBe(404);
  });

  it("delete_viewer_403 / delete_without_r2_409", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await del(v.token, sid, a.id)).status).toBe(403);
    const res = await del(owner.token, sid, a.id, { ASSETS: undefined });
    expect(res.status).toBe(409);
    expect((await expectEnvelope(res)).error).toBe("image_upload_disabled");
  });

  it("delete_skipped_when_frozen", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    await env.DB.prepare(`insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{"reason":"test"}', 1)`).run();
    const res = await del(owner.token, sid, a.id);
    expect(res.status).toBe(503);
    expect((await expectEnvelope(res)).error).toBe("write_frozen");
    const row = await env.DB.prepare(`select deleted_at from assets where id = ?`).bind(a.id).first<{ deleted_at: number | null }>();
    expect(row!.deleted_at).toBeNull();
  });

  it("delete_frozen_after_the_gate_is_503_not_409", async () => {
    // 入口の関門を通った後に凍結が入ると、印の 1 文の NOT_FROZEN_SQL で 0 行になる。使われていないなら 409 にせず 503
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const a = await uploadOk(owner.token, sid);
    let frozen = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!frozen) {
              frozen = true;
              await target.prepare(`insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{"reason":"test"}', 1)`).run();
            }
            return target.batch(stmts);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    const res = await del(owner.token, sid, a.id, { DB: db });
    expect(res.status).toBe(503);
  });

  it("list_unused_label_matches_delete_result", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    const used = await uploadOk(owner.token, sid, "used.png");
    const delivered = await uploadOk(owner.token, sid, "delivered.png");
    const htmlOnly = await uploadOk(owner.token, sid, "html.png");
    const unused = await uploadOk(owner.token, sid, "unused.png");
    await putChanges(owner.token, sid, eid, "b", [attrSrcChange(used.publicUrl), htmlChange(`<img src="${htmlOnly.publicUrl}">`)]);
    await addDeliveredRef(sid, delivered.id, eid);
    const l = await list(owner.token, sid);
    for (const a of l.assets) {
      const res = await del(owner.token, sid, a.id);
      expect(res.status, a.name).toBe(a.inUse ? 409 : 200);
    }
    expect(l.assets.filter((a) => !a.inUse).map((a) => a.id).sort()).toEqual([htmlOnly.id, unused.id].sort());
  });
});

describe("assets: usage across users (B68)", () => {
  it("usage_after_operations_by_multiple_users", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const limit = { AB_ASSET_SITE_MAX_COUNT: "3" };
    const up = async (token: string, name: string) => {
      const res = await upload(token, sid, form(PNG, "image/png", name), limit);
      return { status: res.status, body: await json<Uploaded & { usage: Usage }>(res) };
    };
    const a = await up(owner.token, "a.png");
    const b = await up(ed.token, "b.png");
    expect(b.body.usage.count).toBe(2);
    const d = await json<{ usage: Usage }>(await call("DELETE", `/sites/${sid}/assets/${a.body.id}`, { token: ed.token }));
    expect(d.usage).toMatchObject({ count: 2, pendingCount: 1 });
    const c = await up(owner.token, "c.png");
    expect(c.body.usage).toMatchObject({ count: 3, pendingCount: 1 });
    // 上限(3 枚。削除待ちも数える)の 409 も最新の使用量を返す
    const over = await up(ed.token, "d.png");
    expect(over.status).toBe(409);
    expect(over.body.usage).toMatchObject({ count: 3, pendingCount: 1 });
    const l = await json<AssetList>(await call("GET", `/sites/${sid}/assets`, { token: ed.token, envOverride: limit }));
    expect(l.usage).toEqual(c.body.usage);
    expect(l.usage).toEqual(over.body.usage);
  });
});

describe("assets: R2 and dev-assets (decision 43)", () => {
  it("dev-assets serves the three key shapes and rejects traversal", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const keys = [`sites/${sid}/experiments/exp_x/asset_old0000001.png`, `sites/${sid}/images/asset_new0000001.png`, `sites/${sid}/thumbs/asset_new0000001.webp`];
    for (const k of keys) await env.ASSETS!.put(k, PNG, { httpMetadata: { contentType: "image/png" } });
    for (const k of keys) expect((await call("GET", `/dev-assets/${k}`)).status, k).toBe(200);
    // 区切りだけの `..`(%2e%2e も)は URL の解釈で畳まれて届かないので、畳まれずに届く `..` を含む形で確かめる
    for (const k of [`sites/${sid}/images/..%2fthumbs/asset_new0000001.webp`, `sites/${sid}/images/asset_new0000001..png`, `sites/..${sid}/images/asset_new0000001.png`, `sites/${sid}/other/asset_new0000001.png`, `sites/${sid}/images/x/asset_new0000001.png`]) {
      expect((await call("GET", `/dev-assets/${k}`)).status, k).toBe(404);
    }
  });

  it("dev-assets is disabled when the public base is not control itself", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const res = await call("GET", `/dev-assets/sites/${sid}/images/a.png`, { token: owner.token, envOverride: { AB_ASSET_PUBLIC_BASE: "https://assets.example.com" } });
    expect(res.status).toBe(404);
    await expectEnvelope(res);
  });

  // 決定 43 (5): R2 binding が無い導入では画像の口を閉じる。公開ベースだけ空でも同じ(設定漏れは無効側)
  for (const [label, envOverride] of [
    ["no_binding", { ASSETS: undefined }],
    ["empty_public_base", { AB_ASSET_PUBLIC_BASE: "" }],
  ] as const) {
    it(`r2_disabled_${label} (upload_without_r2_is_409_after_role_check)`, async () => {
      const { token, workspaceId } = await setupOwner();
      const { id: sid } = await createSite(token, workspaceId);
      const up = await call("POST", `/sites/${sid}/assets`, { token, raw: form(PNG, "image/png"), envOverride });
      expect(up.status).toBe(409);
      expect((await expectEnvelope(up)).error).toBe("image_upload_disabled");
      const l = await call("GET", `/sites/${sid}/assets`, { token, envOverride });
      expect(l.status).toBe(200);
      expect((await json<AssetList>(l)).assets).toEqual([]);
      const dev = await call("GET", `/dev-assets/sites/${sid}/images/x.png`, { envOverride });
      expect(dev.status).toBe(404);
    });
  }

  it("site_delete_leaves_r2_untouched_when_binding_missing", async () => {
    // 決定 43 (5): R2 なし構成の Site 削除は R2 に触らない。R2 ありで 1 枚置いてから binding 無しで削除し、オブジェクトが残ることで早期 return を証明する
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    expect((await call("POST", `/sites/${sid}/assets`, { token, raw: form(PNG, "image/png") })).status).toBe(201);
    expect((await call("DELETE", `/sites/${sid}`, { token, envOverride: { ASSETS: undefined } })).status).toBe(204);
    expect(await r2Count(sid)).toBe(1);
    // 公開ベースが空でも binding があれば消す(新しいキー sites/<sid>/images/ と縮小版 sites/<sid>/thumbs/ も sites/<sid>/ の下)
    const { id: sid2 } = await createSite(token, workspaceId);
    const a = await uploadOk(token, sid2);
    await env.ASSETS!.put(`sites/${sid2}/thumbs/${a.id}.webp`, new Uint8Array([1]));
    expect((await call("DELETE", `/sites/${sid2}`, { token, envOverride: { AB_ASSET_PUBLIC_BASE: "" } })).status).toBe(204);
    expect(await r2Count(sid2)).toBe(0);
  });
});

// B68 Task 5(spec §5.2): アップロードの直後に waitUntil で縮小版を作る(call() は ExecutionContext を待つので、その後に D1 と R2 を見る)
describe("assets: thumbnail after upload (B68 spec §5.2)", () => {
  it("upload_schedules_thumbnail", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const IMAGES = fakeImages({ width: 800, height: 600 });
    const res = await upload(token, sid, form(PNG, "image/png", "hero.png"), { IMAGES });
    expect(res.status).toBe(201);
    const a = await json<Uploaded>(res);
    expect(a.thumbnail).toBe("pending"); // 201 は作る前に返す
    const row = await env.DB.prepare(`select thumb_state, thumb_key, width, height from assets where id = ?`).bind(a.id).first();
    expect(row).toEqual({ thumb_state: "ready", thumb_key: `sites/${sid}/thumbs/${a.id}.webp`, width: 800, height: 600 });
    expect((await env.ASSETS!.head(`sites/${sid}/thumbs/${a.id}.webp`))?.httpMetadata?.contentType).toBe("image/webp");
    expect(IMAGES.calls.map((c) => [c.op, c.bytes])).toEqual([["info", PNG.byteLength], ["output", PNG.byteLength]]); // R2 から読み直さず、手元の本文を 2 回読む
    const l = await list(token, sid);
    const listed = l.assets[0]!;
    expect(listed).toMatchObject({ thumbnail: "ready", width: 800, height: 600 });
    expect(listed).not.toHaveProperty("thumbnailUrl");
    expect(assetItemUrls(l.urlPrefix!, listed)).toEqual({ publicUrl: a.publicUrl, thumbnailUrl: `${BASE}/sites/${sid}/thumbs/${a.id}.webp` });
  });

  it("upload_without_images_binding_is_skipped", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    expect(env.IMAGES).toBeUndefined(); // テストの env には本物の Images の binding を入れない(vitest.config.ts)
    const a = await uploadOk(token, sid);
    const row = await env.DB.prepare(`select thumb_state, thumb_attempts from assets where id = ?`).bind(a.id).first();
    expect(row).toEqual({ thumb_state: "skipped", thumb_attempts: 0 });
    expect((await env.ASSETS!.list({ prefix: `sites/${sid}/thumbs/` })).objects).toEqual([]);
  });
});
