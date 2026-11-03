import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError, describeError, fieldErrors } from "@/lib/client";
import { sectionOfField } from "@/components/settings/sections";
import { InstallTag } from "@/components/settings/InstallTag";
import { SharingCard } from "@/components/settings/SharingCard";
import { groupDomainChecks } from "@/components/settings/domains-view";
import { sharingNoticeFor, sharingPatch, withSharingHint, type SharingAdjusted } from "@/components/settings/sharing-notice";
import { createdHref } from "@/components/SiteForms";
import type { Site } from "@/lib/types";

// 節のリンク(SectionLink)は pathname を読む。ルーターの外で描くので差し替える
vi.mock("next/navigation", () => ({ usePathname: () => "/w/w1/sites/s1/settings" }));

/** カードが読むサイトの値だけを埋める(残りは使わない) */
const site = (over: Partial<Site> = {}): Site =>
  ({
    id: "s1",
    mode: "A",
    visitorCookieName: "_ab_vid",
    uuidCookieEnabled: true,
    uuidCookieName: "_ab_uuid",
    shareSubdomains: true,
    outsideDomains: [],
    uncheckedDomains: [],
    cookieGroups: [
      { domain: "example.com", hosts: ["www.example.com", "form.example.com"] },
      { domain: "example-shop.jp", hosts: ["shop.example-shop.jp"] },
    ],
    ...over,
  }) as Site;

const render = (s: Site, opts: { share?: boolean; mode?: "A" | "B"; error?: string; adjusted?: SharingAdjusted | null } = {}) =>
  renderToStaticMarkup(
    createElement(SharingCard, {
      site: s,
      share: opts.share ?? s.shareSubdomains,
      mode: opts.mode ?? s.mode,
      disabled: false,
      error: opts.error,
      className: "card",
      hidden: false,
      adjusted: opts.adjusted ?? null,
      onShareChange: () => {},
    }),
  );

describe("訪問者 ID の共有のカード(B139)", () => {
  it("共有がオンなら、チェックとまとまりの一覧・まとまりごとの表を出す", () => {
    const html = render(site());
    expect(html).toContain("<h2>訪問者 ID の共有</h2>");
    expect(html).toMatch(/<input type="checkbox" name="shareSubdomains" checked=""\/> サブドメインをまたいで ID を共有する\(既定\)/);
    expect(html).toContain("<code>example.com</code>: www.example.com・form.example.com で共有");
    expect(html).toContain("<code>example-shop.jp</code>: shop.example-shop.jp だけ");
    expect(html).toContain("登録ドメイン(サブドメインを付けないドメイン)が違うドメインどうしでは、ブラウザが Cookie を渡さないので ID は別になります(テストはどのドメインでも出ます)");
    expect(html).toContain('data-testid="sharing-table"');
    expect(html).toContain("<th>まとまり(登録ドメイン)</th><th>含むドメイン</th><th>ID の Cookie</th>");
    expect(html).toContain("JavaScript から読める");
    expect(html).toContain("<code>_ab_uuid</code> を、各まとまりの範囲で発行します");
    expect(html).not.toContain("未保存の入力での状態です");
  });

  it("含むドメインのホスト名は code で出し、HttpOnly の札は緑・JavaScript から読める札は橙にする", () => {
    const on = render(site());
    expect(on).toContain("<code>www.example.com</code>、<code>form.example.com</code>");
    expect(on).toContain('<span class="badge badge-warn">JavaScript から読める</span>');
    const off = render(site({ mode: "B", shareSubdomains: false, cookieGroups: [] }));
    expect(off).toContain('<span class="badge badge-ok">HttpOnly(JavaScript から読めない)</span>');
  });

  it("Mode B で共有がオンなら、オフにすると HttpOnly に戻ることを添える", () => {
    const html = render(site({ mode: "B" }));
    expect(html).toContain("共有がオンなので、JavaScript から読める形で発行します(共有をオフにすると、今と同じ HttpOnly に戻ります)");
  });

  it("信頼の前提の注意は、いつも出す", () => {
    const text = "共有すると、同じ登録ドメインのすべてのホストが ID を読み書きできます。第三者に任せたサブドメインや、利用者が中身を作れるサブドメインがあるなら、共有をオフにしてください";
    expect(render(site())).toContain(text);
    expect(render(site({ shareSubdomains: false, cookieGroups: [] }))).toContain(text);
  });

  it("共有がオフなら表を出さず、Mode B では HttpOnly のままと説明する", () => {
    const html = render(site({ mode: "B", shareSubdomains: false, cookieGroups: [] }));
    expect(html).not.toContain('data-testid="sharing-table"');
    expect(html).not.toContain('data-testid="sharing-groups"');
    expect(html).toMatch(/<input type="checkbox" name="shareSubdomains"\/>/);
    expect(html).toContain("HttpOnly(JavaScript から読めない)");
    expect(html).toContain("ID はドメインごとに別で、HttpOnly のままです");
    expect(html).toContain("<code>_ab_uuid</code>(発行したドメインだけ)");
  });

  it("Mode A で共有がオフなら、JavaScript から読めることは今と同じと説明する", () => {
    const html = render(site({ shareSubdomains: false, cookieGroups: [] }));
    expect(html).toContain("ID はドメインごとに別です(共有がオフ)。Mode A では、ID の Cookie はタグが JavaScript で書くので、常に JavaScript から読めます(今と同じ)");
  });

  it("保存済みがオフのままチェックをオンにしたら、範囲は保存すると決まると出し、未保存と添える", () => {
    const html = render(site({ shareSubdomains: false, cookieGroups: [] }), { share: true });
    expect(html).toContain("保存すると、登録ドメインごとに計算します");
    expect(html).not.toContain('data-testid="sharing-table"');
    expect(html).toContain("未保存の入力での状態です。保存すると反映されます。");
  });

  it("保存済みがオンのままチェックを外したら、オフの説明と未保存を出す", () => {
    const html = render(site({ mode: "B" }), { share: false });
    expect(html).not.toContain('data-testid="sharing-table"');
    expect(html).toContain("HttpOnly のままです");
    expect(html).toContain("未保存の入力での状態です");
  });
});

describe("共有の衝突(422 sharing_conflict)", () => {
  const err = new ApiClientError(422, "sharing_conflict", {
    error: "sharing_conflict",
    path: ["shareSubdomains"],
    domain: "example.com",
    message: "サイト「採用」と、訪問者 ID の Cookie がぶつかります",
    hint: "このサイトの訪問者 ID の Cookie 名を変えると解けます",
  });

  it("エラーは共有のチェックの欄のキーになり、訪問者 ID の節を開く", () => {
    const fe = fieldErrors(err);
    expect(fe).toEqual({ shareSubdomains: "サイト「採用」と、訪問者 ID の Cookie がぶつかります" });
    expect(sectionOfField(Object.keys(fe)[0]!)).toBe("identity");
    // 直し方(hint)はフォームの下のエラーの箱に出る
    expect(describeError(err)).toContain("Cookie 名を変えると解けます");
  });

  it("欄のエラーには、直し方(hint)も添える(他のエラー・hint の無い封筒は変えない)", () => {
    const fe = withSharingHint(fieldErrors(err), err.code, err.extra.hint);
    expect(fe.shareSubdomains).toBe("サイト「採用」と、訪問者 ID の Cookie がぶつかります このサイトの訪問者 ID の Cookie 名を変えると解けます");
    const html = render(site(), { error: fe.shareSubdomains });
    expect(html).toContain('<span role="alert" class="field-error">サイト「採用」と、訪問者 ID の Cookie がぶつかります このサイトの訪問者 ID の Cookie 名を変えると解けます</span>');
    const plain = { name: "必須です" };
    expect(withSharingHint(plain, "validation_failed", "直してください")).toBe(plain);
    const noHint = { shareSubdomains: "ぶつかります" };
    expect(withSharingHint(noHint, "sharing_conflict", undefined)).toBe(noHint);
  });

  it("カードはエラーをチェックの欄の下に出す", () => {
    const html = render(site(), { error: fieldErrors(err).shareSubdomains });
    const checkbox = html.indexOf('name="shareSubdomains"');
    const alert = html.indexOf('<span role="alert" class="field-error">サイト「採用」と、訪問者 ID の Cookie がぶつかります</span>');
    expect(alert).toBeGreaterThan(checkbox);
    // 同じ欄(field)の中で、次の見出しより前
    expect(alert).toBeLessThan(html.indexOf("<h3>ID の Cookie の状態</h3>"));
  });
});

describe("作成で衝突を避けたときの知らせ", () => {
  it("URL の値は、サイトの共有の値と合うときだけ知らせにする", () => {
    expect(sharingNoticeFor("off", { shareSubdomains: false })).toBe("off");
    expect(sharingNoticeFor("off", { shareSubdomains: true })).toBeNull();
    expect(sharingNoticeFor("renamed", { shareSubdomains: true })).toBe("renamed");
    expect(sharingNoticeFor("renamed", { shareSubdomains: false })).toBeNull();
    expect(sharingNoticeFor(undefined, { shareSubdomains: true })).toBeNull();
    expect(sharingNoticeFor("other", { shareSubdomains: false })).toBeNull();
    expect(sharingNoticeFor(["off", "renamed"], { shareSubdomains: false })).toBe("off"); // 重なったら先頭
  });

  it("共有をオフにして作ったことを知らせる", () => {
    const html = render(site({ shareSubdomains: false, cookieGroups: [] }), { adjusted: "off" });
    expect(html).toContain('data-testid="sharing-adjusted"');
    expect(html).toContain("このサイトは ID の共有をオフにして作りました");
  });

  it("Cookie 名を変えて作ったことを、今の名前と一緒に知らせる", () => {
    const html = render(site({ visitorCookieName: "_ab_vid_x1" }), { adjusted: "renamed" });
    expect(html).toContain("正本 Cookie 名を <code>_ab_vid_x1</code> に変えて作りました(共有はオンのままです)");
  });

  it("作成の後、調整があればサイト設定の訪問者 ID の節へ、何を変えたかを付けて移る", () => {
    const created = site({ id: "site_x" });
    expect(createdHref("w1", created)).toBe("/w/w1/sites/site_x");
    expect(createdHref("w1", { ...created, sharingAdjusted: { reason: "conflict", shareSubdomains: false, visitorCookieName: "_ab_vid" } })).toBe(
      "/w/w1/sites/site_x/settings?section=identity&sharing=off",
    );
    expect(createdHref("w1", { ...created, sharingAdjusted: { reason: "conflict", shareSubdomains: true, visitorCookieName: "_ab_vid_x" } })).toBe(
      "/w/w1/sites/site_x/settings?section=identity&sharing=renamed",
    );
  });

  it("知らせが無ければ出さない", () => {
    expect(render(site())).not.toContain('data-testid="sharing-adjusted"');
  });
});

// 保存の本文に shareSubdomains を足すかどうか(変えたときだけ送る。送ると自動の移行の対象から外れる)
describe("sharingPatch", () => {
  it("保存済みと同じなら shareSubdomains を送らない(オンでもオフでも)", () => {
    expect(sharingPatch(true, true)).toEqual({});
    expect(sharingPatch(false, false)).toEqual({});
    expect("shareSubdomains" in sharingPatch(true, true)).toBe(false);
  });

  it("保存済みと違えば、画面の値を送る", () => {
    expect(sharingPatch(false, true)).toEqual({ shareSubdomains: false });
    expect(sharingPatch(true, false)).toEqual({ shareSubdomains: true });
  });

  it("オン→オフ→オンと戻して保存すると、保存済みと同じなので送らない", () => {
    let share = true; // 保存済みはオン
    share = false;
    share = true;
    expect(sharingPatch(share, true)).toEqual({});
  });
});

// B148: 共有のカードと導入タグの案内は、ドメインの節を指す
describe("共有のカードとドメインの節(B148)", () => {
  const domainsLink = (html: string, text: string) => expect(html).toMatch(new RegExp(`<a href="/w/w1/sites/s1/settings\\?section=domains">${text}</a>`));
  const modeB = (over: Partial<Site> = {}) =>
    site({ mode: "B", outsideDomains: ["form.example.com"], uncheckedDomains: [], edgeDomains: ["www.example.com"], ...over });

  it("範囲の計算元は「タグを置くドメイン」(ドメインの節へのリンク)で、hint にも同じことを書く", () => {
    const html = render(site());
    expect(html).toContain("共有する範囲(登録ドメインごと。");
    domainsLink(html, "タグを置くドメイン");
    expect(html).toContain("から計算):");
    expect(html).toContain("範囲はタグを置くドメインから、登録ドメインごとに計算します。");
    expect(html).not.toContain("受け付けるサイトのアドレス");
    expect(html).not.toContain("hosts");
  });

  it("説明の 1 文目の末尾の「(Cloudflare 外のドメインでも)」は Mode B だけ", () => {
    expect(render(modeB())).toContain("同じ ID で目標の達成を記録できます(Cloudflare 外のドメインでも)。");
    expect(render(site())).toContain("同じ ID で目標の達成を記録できます。");
    expect(render(site())).not.toContain("(Cloudflare 外のドメインでも)");
  });

  it("カードの末尾に、タグを置くドメインの判定はドメインの節で変えると案内する", () => {
    const html = render(site());
    expect(html).toContain("タグを置くドメインと Cloudflare 経由かの判定は ");
    domainsLink(html, "ドメインで変える");
  });

  it("Cloudflare 外のドメインの警告は、Mode B・共有オフ・外のドメインありのときだけ出す", () => {
    const warn = (html: string) => html.includes('data-testid="sharing-outside-warning"');
    const off = modeB({ shareSubdomains: false, cookieGroups: [] });
    const html = render(off);
    expect(warn(html)).toBe(true);
    expect(html).toContain("<code>form.example.com</code>");
    expect(html).toContain("では ID がつながりません(そこで達成した目標は、テストの結果に入りません)。「サブドメインをまたいで ID を共有する」をオンにしてください。");
    expect(html).toMatch(/data-testid="sharing-outside-warning"[^>]*style="[^"]*font-weight:(600|700)/);
    // 共有がオン・外のドメインが無い・Mode A のときは出さない
    expect(warn(render(off, { share: true }))).toBe(false);
    expect(warn(render(modeB({ shareSubdomains: false, cookieGroups: [], outsideDomains: [] })))).toBe(false);
    expect(warn(render(site({ mode: "A", shareSubdomains: false, cookieGroups: [], outsideDomains: ["form.example.com"] })))).toBe(false);
    // 入力中の導入の形が A なら、保存済みが B でも出さない
    expect(warn(render(off, { mode: "A" }))).toBe(false);
  });

  it("状態の表の「Cloudflare 外のドメイン」の列と「未判定:」の注記は Mode B だけ", () => {
    const b = modeB({ uncheckedDomains: ["form.example.com"], outsideDomains: [] });
    const html = render(b);
    expect(html).toContain("<th>まとまり(登録ドメイン)</th><th>含むドメイン</th><th>Cloudflare 外のドメイン</th><th>ID の Cookie</th>");
    expect(html).toContain("未判定: <code>form.example.com</code>(保存すると決まります)");
    const out = render(modeB());
    expect(out).toMatch(/<td><code>example\.com<\/code><\/td><td>.*<\/td><td><code>form\.example\.com<\/code><\/td>/);
    expect(out).toContain("<td>なし</td>"); // 外のドメインが無いまとまり
    expect(out).not.toContain("未判定:");
    const a = render(site());
    expect(a).toContain("<th>まとまり(登録ドメイン)</th><th>含むドメイン</th><th>ID の Cookie</th>");
    expect(a).not.toContain("<th>Cloudflare 外のドメイン</th>");
    expect(a).not.toContain("未判定:");
  });

  it("まとまりごとの判定: 保存済みが Mode B なら判定の結果を、まだ Mode A なら全部を未判定にする", () => {
    const g = { domain: "example.com", hosts: ["www.example.com", "form.example.com"] };
    expect(groupDomainChecks(modeB({ uncheckedDomains: ["www.example.com"] }), g)).toEqual({ outside: ["form.example.com"], unchecked: ["www.example.com"] });
    expect(groupDomainChecks(site({ mode: "A" }), g)).toEqual({ outside: [], unchecked: ["www.example.com", "form.example.com"] });
  });
});

describe("導入タグの案内(B148)", () => {
  const tag = (over: Partial<Site> = {}) =>
    renderToStaticMarkup(createElement(InstallTag, { site: site({ domain: "www.example.com", ...over }), tagOrigin: "https://tag.example.net", canAdmin: true }));

  it("ドメインの行は代表のドメインと、ドメインの節へのリンク。受け付けるサイトのアドレスの文は無い", () => {
    const html = tag();
    expect(html).toContain("www.example.com");
    expect(html).toMatch(/<a href="\/w\/w1\/sites\/s1\/settings\?section=domains">ドメインで変える<\/a>/);
    expect(html).toContain("複数のドメインのページに置くときは、ドメインの節の「タグを置くドメイン」に足します。");
    expect(html).not.toContain("受け付けるサイトのアドレス");
    expect(html).not.toContain("一般で");
  });

  it("Mode B では、Route を置いてから保存すると確かめると添える", () => {
    const text = "Mode B では、足したドメインに Route を置いてから保存すると、Cloudflare 経由かを確かめます(手順はドメインの節)。";
    expect(tag({ mode: "B" })).toContain(text);
    expect(tag({ mode: "A" })).not.toContain(text);
  });
});
