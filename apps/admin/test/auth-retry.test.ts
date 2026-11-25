import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import AuthedLayout from "@/app/w/layout";

const { bindingFetch } = vi.hoisted(() => ({ bindingFetch: vi.fn<(request: Request) => Promise<Response>>() }));
vi.mock("@/lib/control-binding", () => ({ controlBinding: async () => ({ fetch: bindingFetch }) }));
vi.mock("next/headers", () => ({ cookies: async () => new Map(), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  useRouter: () => ({}),
}));

const renderLogin = async () => renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
const renderProtected = async () => renderToStaticMarkup(await AuthedLayout({ children: createElement("p", null, "保護された本文") }));

function reply(path: string, respond: () => Response | Promise<Response>) {
  bindingFetch.mockImplementation(async (request) =>
    new URL(request.url).pathname === path ? respond() : new Response(null, { status: 503 }),
  );
}

function expectOneRequest(path: string) {
  expect(bindingFetch.mock.calls.filter(([request]) => new URL(request.url).pathname === path)).toHaveLength(1);
}

afterEach(() => bindingFetch.mockReset());

describe("管理画面が認証とログイン方法を取得できないとき", () => {
  it("保護画面は /me の 401 でログイン画面に移る", async () => {
    reply("/me", () => new Response(null, { status: 401 }));
    await expect(renderProtected()).rejects.toThrow("redirect:/login");
    expectOneRequest("/me");
  });

  const failures = [
    ["503", () => new Response(null, { status: 503 })],
    ["呼び出しの例外", () => { throw new Error("binding unavailable"); }],
    ["壊れた JSON", () => new Response("{")],
    ["不正な応答形式", () => Response.json({})],
  ] as const;

  it.each(failures)("保護画面は /me の %s で本文を出さず、再読み込みを案内する", async (_case, respond) => {
    reply("/me", respond);
    const html = await renderProtected();
    expect(html).toContain("再読み込みする");
    expect(html).not.toContain("保護された本文");
    expectOneRequest("/me");
  });

  it("ログイン画面は /login-options の 401 を認証の拒否として表示する", async () => {
    reply("/login-options", () => new Response(null, { status: 401 }));
    const html = await renderLogin();
    expect(html).toContain("ログイン方法の取得が拒否されました");
    expect(html).not.toContain('type="password"');
    expectOneRequest("/login-options");
  });

  it.each(failures)("ログイン画面は /login-options の %s で再読み込みを案内する", async (_case, respond) => {
    reply("/login-options", respond);
    const html = await renderLogin();
    expect(html).toContain("再読み込みする");
    expect(html).not.toContain("Google でログイン");
    expect(html).not.toContain('type="password"');
    expectOneRequest("/login-options");
  });

  it("取得できたログイン方法に従って、非常口のパスワード欄を表示する", async () => {
    reply("/login-options", () => Response.json({ google: true, passwordLogin: true }));
    const html = await renderLogin();
    expect(html).toContain("Google でログイン");
    expect(html).toContain('type="password"');
    expectOneRequest("/login-options");
  });
});
