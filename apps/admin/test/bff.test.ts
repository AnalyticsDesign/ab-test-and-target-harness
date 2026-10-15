import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BFF(spec §13.4)の転送規則と Cookie の属性を、外から検証できる範囲で固定する。
 * Route Handler は素の Request を受けて Response を返すだけなので、`next/headers` の Cookie 置き場だけ差し替えれば直接呼べる。
 * 画面のマークアップは対象外(admin の E2E は Task 13)
 */

type CookieInit = { name: string; value: string; httpOnly?: boolean; sameSite?: string; path?: string; secure?: boolean; maxAge?: number };

let jar: ReturnType<typeof newJar>;

const newJar = (entries: Record<string, string> = {}) => ({
  store: new Map(Object.entries(entries)),
  set: vi.fn<(c: CookieInit) => void>(),
  deleted: [] as string[],
  get(name: string) {
    const v = this.store.get(name);
    return v === undefined ? undefined : { value: v };
  },
  delete(name: string) {
    this.deleted.push(name);
    this.store.delete(name);
  },
});

vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

const { GET, POST, DELETE } = await import("@/app/api/control/[...path]/route");
const { POST: login } = await import("@/app/api/session/login/route");
const { POST: logout } = await import("@/app/api/session/logout/route");
const { POST: setup } = await import("@/app/api/session/setup/route");
const { POST: acceptInvite } = await import("@/app/api/session/accept-invite/route");
const { GET: googleStart } = await import("@/app/api/session/google/route");
const { GET: oauth } = await import("@/app/api/session/oauth/route");
const { oauthErrorMessage } = await import("@/lib/oauth-errors");
const { controlFetch } = await import("@/lib/control");

const CONTROL = "http://control.test"; // vitest.config.ts の test.env.AB_CONTROL_URL
const ORIGIN = "http://admin.test"; // ブラウザが付ける Origin(fetch の POST は必ず付ける)

let fetchMock: ReturnType<typeof vi.fn>;
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
};
/** control の応答を作る。set-auth-token / set-cookie はブラウザに漏れてはいけないので既定で付けておく */
const controlRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "set-cookie": "control_session=leak", ...headers },
  });

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });
/** ブラウザからの POST を模す(Origin 付き) */
const post = (url: string, init: RequestInit = {}) => new Request(url, { method: "POST", ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } });

beforeEach(() => {
  jar = newJar();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BFF /api/control/[...path]", () => {
  // backlog D13 / 決定 56 (1): control へ転送する要求は版を名乗る(ブラウザが名乗った値は引き継がない)
  it("the proxy and the session routes send x-wtt-client-version to control", async () => {
    jar = newJar({ wtt_session: "tok" });
    fetchMock.mockResolvedValueOnce(controlRes(200, { ok: true }));
    await GET(new Request(`${ORIGIN}/api/control/me`, { headers: { "x-wtt-client-version": "999" } }), params(["me"]));
    expect(lastCall().headers.get("x-wtt-client-version")).toBe("1");
    // controlFetch(サーバー側の読み取りすべての入口)。呼び出し元が渡した値も BFF の版で上書きする(レビュー r1 CX-Medium-4)
    fetchMock.mockResolvedValueOnce(controlRes(200, { ok: true }));
    await controlFetch("/me", { headers: { "x-wtt-client-version": "999" } });
    expect(lastCall().headers.get("x-wtt-client-version")).toBe("1");
    fetchMock.mockResolvedValueOnce(controlRes(201, { workspaceId: "w", userId: "u" }));
    await setup(post(`${ORIGIN}/api/session/setup`, { headers: { "content-type": "application/json", "x-setup-token": "t" }, body: JSON.stringify({ email: "a@example.com", name: "A", workspaceName: "W" }) }));
    expect(lastCall().headers.get("x-wtt-client-version")).toBe("1");
  });

  it("Cookie のトークンを Bearer に載せ替えて control に転送する(query 付き)", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, [{ id: "s1" }]));
    const res = await GET(new Request("http://admin.test/api/control/sites/s1?limit=10", { headers: { cookie: "wtt_session=tok1" } }), params(["sites", "s1"]));
    expect(res.status).toBe(200);
    const { url, headers } = lastCall();
    expect(url).toBe(`${CONTROL}/sites/s1?limit=10`);
    expect(headers.get("authorization")).toBe("Bearer tok1");
    // ブラウザのヘッダは引き継がない(Cookie も持ち込みの authorization も control には見せない)
    expect(headers.get("cookie")).toBeNull();
  });

  it("ブラウザが送ったヘッダは authorization も含めて一切引き継がない", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, {}));
    const req = new Request("http://admin.test/api/control/me", {
      headers: {
        authorization: "Bearer stolen",
        cookie: "wtt_session=tok1",
        // control が意味を持って読むヘッダを持ち込ませない(初回セットアップの門と API キーの門)
        "x-setup-token": "guessed-setup-token",
        "x-api-key": "wtt_stolen_key",
        "x-invitation-id": "inv1",
        "x-forwarded-for": "10.0.0.1",
      },
    });
    await GET(req, params(["me"]));
    const { headers } = lastCall();
    expect(headers.get("authorization")).toBe("Bearer tok1"); // Cookie 由来のものだけ
    for (const name of ["cookie", "x-setup-token", "x-api-key", "x-invitation-id", "x-forwarded-for"]) {
      expect(headers.get(name), name).toBeNull();
    }
  });

  it("未ログイン(Cookie 無し)では authorization を付けない", async () => {
    fetchMock.mockResolvedValue(controlRes(401, { error: "unauthorized", message: "認証が必要です" }));
    const res = await GET(new Request("http://admin.test/api/control/me"), params(["me"]));
    expect(res.status).toBe(401);
    expect(lastCall().headers.get("authorization")).toBeNull();
  });

  it("multipart は content-type(boundary 付き)と body をそのまま転送する", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(201, { url: "https://assets.example/x.png" }));
    const raw = "--xyz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\r\n\x89PNG\r\n--xyz--\r\n";
    const req = post("http://admin.test/api/control/sites/s1/assets", { headers: { "content-type": "multipart/form-data; boundary=xyz" }, body: raw });
    await POST(req, params(["sites", "s1", "assets"]));
    const { init, headers } = lastCall();
    expect(headers.get("content-type")).toBe("multipart/form-data; boundary=xyz");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(raw);
  });

  it("JSON body は content-type を落とさずに転送する(落とすと control が 422 にする)", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, { ok: true }));
    await POST(post("http://admin.test/api/control/sites/s1/publish", { headers: { "content-type": "application/json" }, body: "{\"a\":1}" }), params(["sites", "s1", "publish"]));
    const { init, headers } = lastCall();
    expect(headers.get("content-type")).toBe("application/json");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("{\"a\":1}");
  });

  it("`..` を含むパスは control に投げずに 400 で断る", async () => {
    const res = await GET(new Request("http://admin.test/api/control/sites/..%2F..%2Fsetup"), params(["sites", "..", "..", "setup"]));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("セッショントークンを発行する control のパスはブラウザから通さない(前方一致・大小文字を畳む)", async () => {
    const blocked = [
      ["auth", "sign-in", "email"],
      ["auth", "sign-up", "email"],
      ["auth", "get-session"],
      ["auth", "sign-out"],
      ["auth", "list-sessions"],
      ["auth", "token"],
      ["auth", "handoff", "exchange"], // 決定 46: 応答 body に使い捨てコードの引き換えでセッショントークンが載る
      ["auth", "google", "start"],
      ["auth", "callback", "google"],
      ["break-glass", "reset-link"],
      ["setup"],
      ["invitations", "inv1", "accept"],
      ["AUTH", "Get-Session"], // 大小文字で門をすり抜けさせない
      ["Auth", "Handoff", "Exchange"],
      ["auth", "get-session", "x"], // 下位パスも塞ぐ(control 側 AUTH_ALLOW と対の門)
    ];
    for (const path of blocked) {
      const res = await POST(post("http://admin.test/api/control/x"), params(path));
      expect(res.status, path.join("/")).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("トークン発行以外の /auth/* は通す(パスワード再設定)", async () => {
    fetchMock.mockResolvedValue(controlRes(200, { status: true }));
    const res = await POST(post("http://admin.test/api/control/auth/reset-password", { headers: { "content-type": "application/json" }, body: "{}" }), params(["auth", "reset-password"]));
    expect(res.status).toBe(200);
    expect(lastCall().url).toBe(`${CONTROL}/auth/reset-password`);
  });

  it("control の set-auth-token / set-cookie はブラウザに返さない", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, { ok: true }, { "set-auth-token": "leaked-token" }));
    const res = await GET(new Request("http://admin.test/api/control/me"), params(["me"]));
    expect(res.headers.get("set-auth-token")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("control に届かないときも 502 の封筒を返す(500 の HTML にしない)", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await GET(new Request("http://admin.test/api/control/me"), params(["me"]));
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ error: "control_unreachable", message: expect.any(String) });
  });

  it("ブラウザの Origin はそのまま渡し(自オリジンのとき)、無ければ何も付けない(BFF が admin を名乗らない)", async () => {
    fetchMock.mockResolvedValue(controlRes(200, {}));
    await POST(post("http://admin.test/api/control/auth/reset-password", { body: "{}" }), params(["auth", "reset-password"]));
    expect(lastCall().headers.get("origin")).toBe(ORIGIN); // control 側の trustedOrigins が最終判定

    // Origin 無し(ブラウザ以外)。ここで admin のオリジンを代わりに名乗ると control の CSRF 検査が素通りになる
    await POST(new Request("http://admin.test/api/control/auth/reset-password", { method: "POST", headers: { host: "admin.example", "x-forwarded-proto": "https" }, body: "{}" }), params(["auth", "reset-password"]));
    expect(lastCall().headers.get("origin")).toBeNull();
  });

  it("パスのセグメントは URL エンコードしてから組み立てる", async () => {
    fetchMock.mockResolvedValue(controlRes(200, {}));
    await GET(new Request("http://admin.test/api/control/x"), params(["invitations", "a b/c?d"]));
    expect(lastCall().url).toBe(`${CONTROL}/invitations/a%20b%2Fc%3Fd`);
  });

  // Codex Security F13 / F7(2026-10-08): SameSite=Lax は cross-site を止めるが same-site cross-origin は止めない。
  // admin を設置サイトと同じ親ドメインに置く構成(admin.example.com と www.example.com)では、設置サイト上の
  // XSS や侵害された第三者タグが same-site の攻撃者になる。Cookie を Bearer に載せ替える前に出自を確かめる
  describe("出自のゲート(Sec-Fetch-Site / Origin)", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["same-site", { "sec-fetch-site": "same-site" }],
      ["cross-site", { "sec-fetch-site": "cross-site" }],
      ["cross-site with same-origin Origin(偽装)", { "sec-fetch-site": "cross-site", origin: ORIGIN }],
      ["Sec-Fetch 無し + 他オリジンの Origin(古いブラウザの form POST)", { origin: "https://www.example.com" }],
      ["Sec-Fetch 無し + Origin null", { origin: "null" }],
      ["same-origin を名乗るが Origin が他オリジン", { "sec-fetch-site": "same-origin", origin: "https://www.example.com" }],
    ];
    for (const [name, headers] of cases) {
      it(`${name} の POST publish は control に届く前に 403 bad_origin`, async () => {
        jar = newJar({ wtt_session: "tok1" });
        const res = await POST(new Request("http://admin.test/api/control/sites/s1/publish", { method: "POST", headers }), params(["sites", "s1", "publish"]));
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: "bad_origin", message: expect.any(String) });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it("same-site の GET(<script src> 相当)も 403(下書きの config を実行可能な応答で漏らさない)", async () => {
      jar = newJar({ wtt_session: "tok1" });
      const res = await GET(new Request("http://admin.test/api/control/sites/s1/experiments/e1/analytics-recipe", { headers: { "sec-fetch-site": "same-site", "sec-fetch-dest": "script" } }), params(["sites", "s1", "experiments", "e1", "analytics-recipe"]));
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("same-origin / none / ヘッダ無し(出自不明)は従来どおり転送する", async () => {
      jar = newJar({ wtt_session: "tok1" });
      fetchMock.mockResolvedValue(controlRes(200, { ok: true }));
      for (const headers of <Record<string, string>[]>[{ "sec-fetch-site": "same-origin" },{ "sec-fetch-site": "Same-Origin" }, { "sec-fetch-site": "none" }, {}, { origin: ORIGIN }]) {
        const res = await POST(new Request("http://admin.test/api/control/sites/s1/publish", { method: "POST", headers }), params(["sites", "s1", "publish"]));
        expect(res.status, JSON.stringify(headers)).toBe(200);
        expect(lastCall().headers.get("authorization")).toBe("Bearer tok1");
      }
    });

    it("応答に Cross-Origin-Resource-Policy: same-origin を付け、control の nosniff / cache-control を引き継ぐ", async () => {
      jar = newJar({ wtt_session: "tok1" });
      fetchMock.mockResolvedValue(controlRes(200, { ok: true }, { "x-content-type-options": "nosniff", "cache-control": "no-store" }));
      const res = await GET(new Request("http://admin.test/api/control/sites/s1"), params(["sites", "s1"]));
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      // control が付けなかったときは付けない(無いものを作らない)
      fetchMock.mockResolvedValue(controlRes(200, { ok: true }));
      const res2 = await GET(new Request("http://admin.test/api/control/sites/s1"), params(["sites", "s1"]));
      expect(res2.headers.get("x-content-type-options")).toBeNull();
      expect(res2.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    });

    it("draft-bootstrap(text/javascript の応答)はブラウザからは呼べない", async () => {
      jar = newJar({ wtt_session: "tok1" });
      for (const path of [["sites", "s1", "experiments", "e1", "draft-bootstrap"], ["sites", "s1", "experiments", "e1", "Draft-Bootstrap"], ["sites", "s1", "experiments", "e1", "draft-bootstrap", "x"]]) {
        const res = await GET(new Request(`http://admin.test/api/control/${path.join("/")}`, { headers: { "sec-fetch-site": "same-origin" } }), params(path));
        expect(res.status, path.join("/")).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: "forbidden", hint: expect.stringContaining("draft-bootstrap") });
      }
      // 古いブラウザの <script src>(Origin も Sec-Fetch-Site も無い)は出自の門を通るが、遮断の一覧で 403
      const legacy = await GET(new Request("http://admin.test/api/control/sites/s1/experiments/e1/draft-bootstrap", { headers: { "sec-fetch-dest": "script" } }), params(["sites", "s1", "experiments", "e1", "draft-bootstrap"]));
      expect(legacy.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("cf-connecting-ip(control の IP 単位レート制限の鍵)", () => {
  it("受信した cf-connecting-ip は転送しない。旧フラグ AB_TRUST_CLIENT_IP_HEADER が環境に残っていても同じ(決定 35 (4))", async () => {
    // Cloudflare 配下では CF-Connecting-IP は Cloudflare が接続元 IP で上書きするので、BFF の転送はそもそも届かない。
    // Cloudflare 外の構成は spec に無く、そこで転送すると「ブラウザの JS が自分で IP を名乗って制限を回避できる」欠陥に戻る
    vi.stubEnv("AB_TRUST_CLIENT_IP_HEADER", "1");
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, {}));
    await DELETE(new Request("http://admin.test/api/control/sites/s1", { method: "DELETE", headers: { "cf-connecting-ip": "203.0.113.9" } }), params(["sites", "s1"]));
    expect(lastCall().headers.get("cf-connecting-ip")).toBeNull();

    await login(post("http://admin.test/api/session/login", { headers: { "cf-connecting-ip": "203.0.113.9" }, body: "{}" }));
    expect(lastCall().headers.get("cf-connecting-ip")).toBeNull();
  });
});

describe("POST /api/session/login", () => {
  it("トークンを HttpOnly Cookie に入れ、body には出さない", async () => {
    fetchMock.mockResolvedValue(controlRes(200, { user: { id: "u1" } }, { "set-auth-token": "tok-new" }));
    const res = await login(post("http://admin.test/api/session/login", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", password: "pw" }),
    }));
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(JSON.stringify({ ok: true })); // トークンはどこにも出さない
    const cookie = jar.set.mock.calls[0]?.[0] as CookieInit;
    expect(cookie).toEqual({ name: "wtt_session", value: "tok-new", httpOnly: true, sameSite: "lax", path: "/", secure: false, maxAge: 604800 });
    const { url, headers } = lastCall();
    expect(url).toBe(`${CONTROL}/auth/sign-in/email`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("origin")).toBe(ORIGIN); // 無いと control が 403 MISSING_OR_NULL_ORIGIN
  });

  it("x-forwarded-proto: https のときだけ Secure を付ける", async () => {
    fetchMock.mockResolvedValue(controlRes(200, {}, { "set-auth-token": "tok-new" }));
    await login(post("http://admin.test/api/session/login", { headers: { "x-forwarded-proto": "https" }, body: "{}" }));
    expect((jar.set.mock.calls[0]?.[0] as CookieInit).secure).toBe(true);
  });

  it("control の封筒(429 rate_limited)はそのまま返し、Cookie は付けない", async () => {
    fetchMock.mockResolvedValue(controlRes(429, { error: "rate_limited", message: "リクエストが多すぎます", hint: "しばらく待ってから再試行してください" }));
    const res = await login(post("http://admin.test/api/session/login", { body: "{}" }));
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: "rate_limited", hint: "しばらく待ってから再試行してください" });
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("Better Auth の英語エラーは日本語の封筒に置き換える", async () => {
    fetchMock.mockResolvedValue(controlRes(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }));
    const res = await login(post("http://admin.test/api/session/login", { body: "{}" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "invalid_credentials", message: "メールアドレスかパスワードが違います" });
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("セッション作成を断られたときは「招待されていません」と伝える(パスワード誤りに丸めない)", async () => {
    // control のセッション作成フックが断ると Better Auth 素の封筒(error キーが無い 403)になる。
    // ここで拾わないと、パスワードは合っているのに「メールアドレスかパスワードが違います」と出てしまう
    fetchMock.mockResolvedValue(controlRes(403, { code: "NOT_INVITED", message: "not_invited" }));
    const res = await login(post("http://admin.test/api/session/login", { body: "{}" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_invited");
    expect(body.message).toBe(oauthErrorMessage("not_invited"));
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("control に届かないときは 502 の封筒", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await login(post("http://admin.test/api/session/login", { body: "{}" }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "control_unreachable" });
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("Origin ゲート(状態を変える session ルート)", () => {
  it("Origin が無い / null の要求は control に届く前に 403", async () => {
    const routes: Array<[string, (r: Request) => Promise<Response>]> = [
      ["login", login],
      ["setup", setup],
      ["accept-invite", acceptInvite],
    ];
    const headerSets: Record<string, string>[] = [{}, { origin: "null" }]; // Origin 無し / 不透明なオリジン
    for (const [name, handler] of routes) {
      for (const headers of headerSets) {
        const res = await handler(new Request(`http://admin.test/api/session/${name}`, { method: "POST", headers, body: JSON.stringify({ id: "inv1" }) }));
        expect(res.status, name).toBe(403);
        await expect(res.json()).resolves.toMatchObject({ error: "missing_origin" });
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("他オリジンの Origin は 403 bad_origin、自オリジンは通る(login / setup / accept-invite)", async () => {
    // Codex Security F8: accept-invite は control 側で Better Auth の Origin 照合を通らない唯一の session 発行経路なので、
    // BFF の門が「Origin の有無」だけでは、他サイトの text/plain の form POST で被害者を攻撃者のアカウントにログインさせられる
    const routes: Array<[string, (r: Request) => Promise<Response>]> = [
      ["login", login],
      ["setup", setup],
      ["accept-invite", acceptInvite],
    ];
    for (const [name, handler] of routes) {
      const res = await handler(new Request(`http://admin.test/api/session/${name}`, { method: "POST", headers: { origin: "https://www.example.com", "content-type": "application/json" }, body: JSON.stringify({ id: "inv1" }) }));
      expect(res.status, name).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_origin" });
    }
    // Fetch Metadata が同一オリジンを名乗っても、Origin が他オリジンなら Origin の不一致で断る
    for (const site of ["same-origin", "none"]) {
      const res = await login(new Request("http://admin.test/api/session/login", { method: "POST", headers: { origin: "https://www.example.com", "sec-fetch-site": site, "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", password: "x" }) }));
      expect(res.status, site).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_origin" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // 自オリジンは control に届く
    fetchMock.mockResolvedValue(controlRes(200, { token: "t", workspaceId: "w" }));
    const ok = await acceptInvite(post("http://admin.test/api/session/accept-invite", { headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "inv1", name: "A", password: "password123" }) }));
    expect(ok.status).toBe(200);
  });

  it("selfOrigin: https の要求では x-forwarded-host を見ない(admin は Workers 直受けで、転送ヘッダはクライアントが名乗れる)", async () => {
    // backlog B16。Origin との一致に使うので、ここが偽装できると門が開く
    const res = await login(new Request("https://admin.test/api/session/login", { method: "POST", headers: { origin: "https://www.example.com", "x-forwarded-host": "www.example.com", "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", password: "x" }) }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    // http(ローカルの next dev)では従来どおり host / x-forwarded-host を使う
    fetchMock.mockResolvedValue(controlRes(200, {}, { "set-auth-token": "t" }));
    const dev = await login(new Request("http://localhost:3000/api/session/login", { method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", password: "x" }) }));
    expect(dev.status).toBe(200);
    // https で自オリジン(url の host)と Origin が一致すれば通る
    fetchMock.mockResolvedValue(controlRes(200, {}, { "set-auth-token": "t" }));
    const secure = await login(new Request("https://admin.test/api/session/login", { method: "POST", headers: { origin: "https://admin.test", "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", password: "x" }) }));
    expect(secure.status).toBe(200);
  });
});

describe("POST /api/session/setup", () => {
  it("setupToken を x-setup-token ヘッダに移し、応答からトークンを落とす。パスワードが無くても通り、Cookie は張らない", async () => {
    fetchMock.mockResolvedValue(controlRes(201, { workspaceId: "ws1", userId: "u1" }));
    const res = await setup(post("http://admin.test/api/session/setup", {
      body: JSON.stringify({ setupToken: "s3cret", email: "a@example.com", name: "A", workspaceName: "W" }),
    }));
    await expect(res.json()).resolves.toEqual({ workspaceId: "ws1" }); // userId も返さない
    const { url, init, headers } = lastCall();
    expect(url).toBe(`${CONTROL}/setup`);
    expect(headers.get("x-setup-token")).toBe("s3cret");
    expect(headers.get("origin")).toBe(ORIGIN);
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@example.com", name: "A", workspaceName: "W" }); // setupToken は body に残さない
    expect(jar.set).not.toHaveBeenCalled(); // OWNER は続けて Google でログインするので、ここではセッションを作らない
  });

  it("control の封筒(403 setup_closed)をそのまま返す", async () => {
    fetchMock.mockResolvedValue(controlRes(403, { error: "setup_closed", message: "初回セットアップは既に完了しています" }));
    const res = await setup(post("http://admin.test/api/session/setup", { body: "{}" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "setup_closed" });
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("POST /api/session/accept-invite", () => {
  it("未ログインなら body(name / password)を送る", async () => {
    fetchMock.mockResolvedValue(controlRes(200, { token: "tok-new", workspaceId: "ws1" }));
    const res = await acceptInvite(post("http://admin.test/api/session/accept-invite", {
      body: JSON.stringify({ id: "inv 1", name: "A", password: "password1" }),
    }));
    await expect(res.json()).resolves.toEqual({ workspaceId: "ws1" });
    const { url, init, headers } = lastCall();
    expect(url).toBe(`${CONTROL}/invitations/inv%201/accept`);
    expect(headers.get("authorization")).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({ name: "A", password: "password1" });
    expect(jar.set.mock.calls[0]?.[0]).toMatchObject({ name: "wtt_session", value: "tok-new", httpOnly: true, sameSite: "lax" });
  });

  it("ログイン中なら Bearer を送り body は空にする", async () => {
    jar = newJar({ wtt_session: "tok-old" });
    fetchMock.mockResolvedValue(controlRes(200, { token: "tok-new", workspaceId: "ws1" }));
    await acceptInvite(post("http://admin.test/api/session/accept-invite", { body: JSON.stringify({ id: "inv1", name: "A", password: "password1" }) }));
    const { init, headers } = lastCall();
    expect(headers.get("authorization")).toBe("Bearer tok-old");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("id が無ければ control を呼ばずに 400", async () => {
    const res = await acceptInvite(post("http://admin.test/api/session/accept-invite", { body: "{}" }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/session/logout", () => {
  it("control のセッションを失効させ、Cookie を消して /login に 303", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, {}));
    const res = await logout(post("http://admin.test/api/session/logout"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    const { url, init, headers } = lastCall();
    expect(url).toBe(`${CONTROL}/auth/sign-out`);
    expect(headers.get("authorization")).toBe("Bearer tok1");
    // content-type が無いと Better Auth は 415、origin が無いと 403 になる(どちらもセッションが失効しないまま残る)
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("origin")).toBe(ORIGIN);
    expect(init.body).toBe("{}");
    expect(jar.deleted).toEqual(["wtt_session"]);
  });

  it("Origin の無い form POST でも admin 自身を名乗って失効させる(logout だけの例外)", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockResolvedValue(controlRes(200, {}));
    const res = await logout(new Request("http://admin.test/api/session/logout", { method: "POST", headers: { host: "admin.example", "x-forwarded-proto": "https" } }));
    expect(res.status).toBe(303);
    expect(lastCall().headers.get("origin")).toBe("https://admin.example");
    expect(jar.deleted).toEqual(["wtt_session"]);
  });

  it("control が落ちていても Cookie は消す", async () => {
    jar = newJar({ wtt_session: "tok1" });
    fetchMock.mockRejectedValue(new Error("down"));
    const res = await logout(post("http://admin.test/api/session/logout"));
    expect(res.status).toBe(303);
    expect(jar.deleted).toEqual(["wtt_session"]);
  });
});

describe("Google sign-in through the BFF (決定 46 (6))", () => {
  const FLOW = "flow-0123456789abcdef";
  const back = (q: string) => new Request(`http://admin.test/api/session/oauth?${q}`, { headers: { host: "admin.test" } });

  it("google: mints a flow cookie and redirects the browser to control's start, keeping only a safe next", async () => {
    const res = await googleStart(new Request("http://admin.test/api/session/google?next=/invite/inv_1"));
    expect(res.status).toBe(302);
    const set = jar.set.mock.calls.at(-1)![0];
    expect(set).toMatchObject({ name: "wtt_oauth_flow", httpOnly: true, sameSite: "lax", path: "/api/session", maxAge: 600 });
    expect(set.value).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${CONTROL}/auth/google/start`);
    expect(to.searchParams.get("flow")).toBe(set.value);
    expect(to.searchParams.get("next")).toBe("/invite/inv_1");
    const bad = await googleStart(new Request("http://admin.test/api/session/google?next=https://evil.example/"));
    expect(new URL(bad.headers.get("location")!).searchParams.get("next")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** flow Cookie が「同じ path・maxAge 0」で失効させられたか(jar.delete では path が合わず、実ブラウザでは消えない) */
  const flowExpired = () => jar.set.mock.calls.some(([c]) => c.name === "wtt_oauth_flow" && c.value === "" && c.maxAge === 0 && c.path === "/api/session" && c.httpOnly === true);

  it("oauth: exchanges the hand-off code server-side only when the flow matches the cookie", async () => {
    jar = newJar({ wtt_oauth_flow: FLOW });
    fetchMock.mockResolvedValue(controlRes(200, { token: "sess.sig" }));
    const res = await oauth(back(`code=code_1&flow=${FLOW}&next=/invite/inv_1`));
    const { url, init } = lastCall();
    expect(url).toBe(`${CONTROL}/auth/handoff/exchange`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "code_1" });
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ name: "wtt_session", value: "sess.sig", httpOnly: true, sameSite: "lax", path: "/" }));
    expect(flowExpired()).toBe(true);
    expect(jar.deleted).not.toContain("wtt_oauth_flow");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://admin.test/invite/inv_1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // 同じ交換をブラウザの JS が汎用プロキシから呼んでも、トークンは返らない(2 枚目の門)
    const viaProxy = await POST(post("http://admin.test/api/control/auth/handoff/exchange", { headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "code_1" }) }), params(["auth", "handoff", "exchange"]));
    expect(viaProxy.status).toBe(403);
    await expect(viaProxy.text()).resolves.not.toContain("sess.sig");
    expect(fetchMock).toHaveBeenCalledTimes(1); // プロキシは control に転送すらしない
  });

  it("oauth_rejects_token_without_matching_login_transaction: no cookie, a different flow, or no flow → no exchange, no session", async () => {
    fetchMock.mockResolvedValue(controlRes(200, { token: "sess.sig" }));
    for (const [cookie, q] of [
      [{}, `code=c&flow=${FLOW}`], // 攻撃者の URL を踏まされたブラウザ(flow Cookie が無い)
      [{ wtt_oauth_flow: "other-flow-0123456789" }, `code=c&flow=${FLOW}`],
      [{ wtt_oauth_flow: FLOW }, "code=c"],
    ] as const) {
      jar = newJar(cookie);
      const res = await oauth(back(q));
      expect(res.headers.get("location")).toBe("http://admin.test/login?error=oauth_failed");
      expect(jar.set.mock.calls.some(([c]) => c.name === "wtt_session")).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("oauth_transaction_cookie_is_one_time: the flow cookie is expired (same path, maxAge 0) even when the exchange fails", async () => {
    jar = newJar({ wtt_oauth_flow: FLOW });
    fetchMock.mockResolvedValue(controlRes(400, { error: "invalid_handoff", message: "x" }));
    expect((await oauth(back(`code=c&flow=${FLOW}`))).headers.get("location")).toBe("http://admin.test/login?error=oauth_failed");
    expect(flowExpired()).toBe(true);
    expect(jar.set.mock.calls.some(([c]) => c.name === "wtt_session")).toBe(false);
  });

  it("oauth: lands on /w without a safe next, and on /login?error=oauth_failed when control is unreachable, answers without a token, or the code is missing", async () => {
    jar = newJar({ wtt_oauth_flow: FLOW });
    fetchMock.mockResolvedValue(controlRes(200, { token: "sess.sig" }));
    expect((await oauth(back(`code=c&flow=${FLOW}&next=//evil.example`))).headers.get("location")).toBe("http://admin.test/w");
    jar = newJar({ wtt_oauth_flow: FLOW });
    fetchMock.mockRejectedValue(new Error("down"));
    expect((await oauth(back(`code=c&flow=${FLOW}`))).headers.get("location")).toBe("http://admin.test/login?error=oauth_failed");
    jar = newJar({ wtt_oauth_flow: FLOW });
    fetchMock.mockResolvedValue(controlRes(200, {}));
    expect((await oauth(back(`code=c&flow=${FLOW}`))).headers.get("location")).toBe("http://admin.test/login?error=oauth_failed");
    jar = newJar({ wtt_oauth_flow: FLOW });
    expect((await oauth(back(`flow=${FLOW}`))).headers.get("location")).toBe("http://admin.test/login?error=oauth_failed");
  });
});

describe("controlUrl", () => {
  it("reads AB_CONTROL_URL at request time, not at module load", async () => {
    // Workers では process.env が起動時に vars で埋まる。ビルド時の .env.local が焼き込まれないよう、
    // モジュール読み込み時の定数ではなく呼び出し時に読む(決定 45 の Task 1 スパイクで確認した経路)
    const { controlUrl } = await import("@/lib/control");
    const saved = process.env.AB_CONTROL_URL;
    try {
      process.env.AB_CONTROL_URL = "http://changed.test/";
      expect(controlUrl()).toBe("http://changed.test");
      jar = newJar({ wtt_session: "tok" });
      fetchMock.mockResolvedValue(controlRes(200, { id: "u1" }));
      await GET(new Request("http://admin.test/api/control/me"), params(["me"]));
      expect(lastCall().url).toBe("http://changed.test/me");
    } finally {
      process.env.AB_CONTROL_URL = saved;
    }
  });

  it("keeps Secure when req.url is https even if x-forwarded-proto says http", async () => {
    const { isHttps } = await import("@/lib/control");
    expect(isHttps(new Request("https://admin.test/x", { headers: { "x-forwarded-proto": "http" } }))).toBe(true);
    expect(isHttps(new Request("http://admin.test/x", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(isHttps(new Request("http://admin.test/x"))).toBe(false);
  });
});
