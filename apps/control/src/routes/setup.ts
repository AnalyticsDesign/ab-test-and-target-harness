import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { sql } from "kysely";
import { z } from "zod";
import type { AppEnv } from "../app";
import { ApiError, validationFailed } from "../errors";
import { createWorkspace, grantInstanceAdmin } from "../instance-admins";
import { UsageSettingsSchema } from "../instance-settings";
import { timingSafeEqualString } from "../ids";
import { errorResponses } from "../openapi";

const SetupSchema = z.strictObject({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional().describe("省略時はメールアドレスの @ より前"),
  workspaceName: z.string().min(1).max(100),
  usageVisibility: UsageSettingsSchema.shape.usageVisibility
    .optional()
    .describe("使用状況を見られる人(members = すべてのメンバー / instance_admins = システム管理者のみ)。省略 = members。後から管理画面の設定 > システム > Cloudflare 使用状況で変えられる"),
});

const SetupResultSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
});

export const setupRoutes = new Hono<AppEnv>();

/** spec §13.3: 初回のみ。ゲートはこのルートの先頭(トークン一致)と auth.ts の hooks.before(トークン一致 + organization 0 件 + lock 未完了) */
setupRoutes.post(
  "/setup",
  describeRoute({
    tags: ["setup"],
    summary: "初回セットアップ。システム管理者(最初のオーナー)と最初のワークスペースを作る",
    description: "無認証だが header `X-Setup-Token` が必須(無い・一致しない場合は何もせず 403 setup_closed)。オーナー作成後は 403 setup_closed で閉じる。パスワードは受け取らず、セッションも返さない。オーナーは続けて同じメールアドレスの Google アカウントでログインする",
    security: [], // 無認証の入口(セッションでも API キーでもなく X-Setup-Token で守る)
    responses: {
      201: { description: "オーナーとワークスペースを作成した", content: { "application/json": { schema: resolver(SetupResultSchema) } } },
      ...errorResponses(400, 403, 422, 429, 503),
    },
  }),
  // D10 最終レビュー finding 2 (a): lock に触れる前にトークンを確かめる。stale の経路は前回の残り(organization / user)を
  // 消すので、トークンの確認が後段の hooks.before だけだと、無認証の POST /setup で導入全体が消えうる。
  // body の検証より前に置く(トークンを持たない呼び出しには形の誤り 400 / 422 も返さず、一律 403 setup_closed)。
  // AB_SETUP_TOKEN が無い = セットアップは閉じている。hooks.before の確認は多層防御としてそのまま残す
  async (c, next) => {
    const expected = c.env.AB_SETUP_TOKEN;
    const given = c.req.header("x-setup-token");
    if (!expected || !given || !(await timingSafeEqualString(given, expected))) throw new ApiError(403, "setup_closed");
    await next();
  },
  validator("json", SetupSchema, (result) => {
    if (!result.success) throw validationFailed(result.error);
  }),
  async (c) => {
    const parsed = c.req.valid("json");
    const auth = c.get("auth");
    const db = c.get("db");
    const now = Date.now();
    const STALE_MS = 60_000;
    // (1) lock 行を先勝ちで取る。D1 にトランザクションが無いので、排他は「行が 1 つしか存在できないこと」だけに載せる:
    //     lock がまだ無い → primary key の UNIQUE 制約で insert が先勝ち
    //     lock が中断された前回のもの(未完了かつ 60 秒より古い) → 観測した行そのものを狙う CAS で先勝ち
    //     どちらの経路でも、勝った 1 リクエストだけが以降(user 作成 → Workspace 作成)へ進む
    const existing = await db.selectFrom("setup_lock").selectAll().where("id", "=", 1).executeTakeFirst();
    if (existing) {
      if (existing.completed === 1) throw new ApiError(403, "setup_closed");
      if (now - existing.created_at <= STALE_MS) throw new ApiError(403, "setup_closed"); // 60 秒以内の同時実行
      // CAS: 観測したときのまま(未完了 + 同じ created_at)残っている場合だけ自分のものにする。
      // delete + insert に分けると 2 リクエストが互いの行を消し合えるため、1 文の条件付き update にする
      const claimed = await sql<{ id: number }>`
        update setup_lock set created_at = ${now}
        where id = 1 and completed = 0 and created_at = ${existing.created_at}
        returning id
      `.execute(db);
      if (claimed.rows.length !== 1) throw new ApiError(403, "setup_closed"); // 他のリクエストが先に stale lock を取った
      // ここに来るのはトークンが一致したリクエストだけ(ルート先頭の確認)
      // backlog D10: setup が一度も完了していない(lock が未完了)間の organization は、失敗した試行の残りしかありえない(作れるのは setup だけ)。
      // 消さないと auth.ts の『organization が 0 件』のゲートで再試行が永久に閉じる(補償のワークスペースの削除まで失敗した場合)
      await sql`delete from organization`.execute(db);
      // CAS に勝った側だけが前回の痕跡を消す。organization が無い = 招待経由の user は存在し得ない
      await sql`delete from "user"`.execute(db);
    } else {
      try {
        await sql`insert into setup_lock (id, created_at, completed) values (1, ${now}, 0)`.execute(db);
      } catch {
        throw new ApiError(403, "setup_closed"); // 同時実行の相手が先に insert した
      }
    }
    // 補償は「user → lock」の順で、user 削除に失敗したら lock を**消さない**。片側だけ成功して孤児 user + lock 無しになると、
    // 次の setup は hooks.before の「user 0 件」ゲートで永久に 403 になる(stale-lock 回復経路にも入れない)。
    // lock を残せば 60 秒後の stale 経路が `delete from "user"` で孤児を消して回復できる(rulings §4 CX-High-4)。
    // 消す lock は自分が書いた(created_at = now の)未完了の行だけ(D10 最終レビュー finding 2 (b))。60 秒を超えて
    // 別のリクエストに stale の lock を取り直された後に補償へ来た場合、相手の lock を消すと 3 本目が並行して入れてしまう
    const compensate = async (userId?: string) => {
      if (userId) {
        try {
          await sql`delete from "user" where id = ${userId}`.execute(db);
        } catch (e) {
          console.error("setup compensate: user delete failed; keeping setup_lock so the stale path can recover", e);
          return;
        }
      }
      await sql`delete from setup_lock where id = 1 and completed = 0 and created_at = ${now}`.execute(db).catch(() => {});
    };
    let token: string | null = null;
    let userId: string;
    // (2) user を作る
    try {
      // 決定 46 (4): パスワードは control が乱数で持たせるだけ(誰も知らない)。ログインは常に Google、非常時はリセットから
      const randomPassword = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      const { headers, response } = await auth.api.signUpEmail({
        body: { email: parsed.email, name: parsed.name ?? parsed.email.split("@")[0]!, password: randomPassword },
        headers: new Headers({ "x-setup-token": c.req.header("x-setup-token") ?? "" }),
        returnHeaders: true,
      });
      token = headers.get("set-auth-token");
      userId = response.user.id;
    } catch (e) {
      const status = (e as { status?: string }).status;
      await compensate();
      if (status === "FORBIDDEN") throw new ApiError(403, "setup_closed");
      throw e;
    }
    // message は封筒の利用者向け文言(日本語)のままにし、内部の原因は detail に載せる(errorHandler が 5xx をサーバー側にも記録する)
    if (!token) { await compensate(userId); throw new ApiError(503, "setup_failed", { hint: "再試行してください", detail: "no session token" }); }
    // (3) システム管理者として登録してから、ワークスペースを作る(決定 53 (2) / K6)。ワークスペースが 0 個のうちに登録すれば、
    // createWorkspace がシステム管理者全員(= この人)を OWNER にするだけで不変条件が成り立つ。
    // 失敗したら、この試行のワークスペースを消してから user と(自分の)lock 行を消して 503(登録・member は FK の CASCADE で消える)。
    // ワークスペースを消せなかったら user も lock も残して 503(「1 分ほど待って」)。lock が未完了のまま残るので、
    // 60 秒後にトークン付きの再試行が stale の経路で organization と user を消して回復する
    // backlog D10: この試行で作ったワークスペース。補償で消すため try の外に置く
    let workspaceId: string | null = null;
    try {
      await grantInstanceAdmin(c.env, userId, null);
      workspaceId = await createWorkspace(c.env, parsed.workspaceName);
      // completed = 1 で以後の setup を閉じる。初期導入で決めた「見られる人」(brief K7。省略なら行を作らない = 既定のすべてのメンバー)も
      // 同じ batch で書く。batch は 1 トランザクションなので、失敗すれば設定も完了も書かれない。
      // 補償が失敗しても lock は未完了のまま残り、60 秒後の stale 経路で回復する。
      // D10 最終レビュー finding 2 (b): 完了は lock を取った本人(created_at = now)だけが書ける。60 秒を超えたこの試行の途中で
      // 別のリクエストが stale の lock を取り直し(この試行の行を消し)ていたら、更新は 0 行になる → throw して補償へ。
      // 0 行でも batch の中の他の文は実行されてしまうので、設定の insert は「自分の完了が書けたとき」だけ行が入る
      // insert … select … where exists にして、完了の update の後ろに置く(設定だけが残ることを文の側で防ぐ。補償で消すと相手の設定まで消しうる)
      const stmts = [c.env.DB.prepare("update setup_lock set completed = 1 where id = 1 and completed = 0 and created_at = ?1").bind(now)];
      if (parsed.usageVisibility) {
        stmts.push(
          c.env.DB.prepare(
            "insert into instance_settings (key, value, updated_at, updated_by) select 'usageVisibility', ?1, ?2, null where exists (select 1 from setup_lock where id = 1 and completed = 1 and created_at = ?3) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
          ).bind(JSON.stringify(parsed.usageVisibility), Date.now(), now),
        );
      }
      const [completion] = await c.env.DB.batch(stmts);
      if (completion?.meta.changes !== 1) throw new Error("setup_lock was taken over by another setup request before completion");
      // sign-up が作ったセッションは返さずに消す(setup token の持ち主にパスワードなしのセッションを渡さない)。
      // 消し損ねても 201 のまま返す: トークンは応答に載らないので行は誰にも渡らず 7 日で失効する(plan R3)
      await sql`delete from session where "userId" = ${userId}`.execute(db).catch((e) => console.error("setup: session cleanup failed", e));
      return c.json({ workspaceId, userId }, 201);
    } catch (e) {
      // この試行で作ったワークスペースを消す(残すと auth.ts の『organization が 0 件』のゲートで再試行できず、owner の行を持たない組織が残る)。
      // 消せなかったら lock を残す(compensate を呼ばない)。60 秒後の stale の経路が organization と user を消して回復する
      if (workspaceId) {
        const removed = await sql`delete from organization where id = ${workspaceId}`.execute(db).then(() => true, (err) => (console.error("setup compensate: workspace delete failed; keeping setup_lock so the stale path can recover", err), false));
        if (!removed) throw new ApiError(503, "setup_failed", { hint: "1 分ほど待ってから再試行してください", detail: String(e) });
      }
      await compensate(userId);
      throw new ApiError(503, "setup_failed", { hint: "再試行してください", detail: String(e) });
    }
  },
);
