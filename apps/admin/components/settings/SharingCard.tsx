"use client";
import { Fragment, useEffect, useState } from "react";
import type { Site } from "@/lib/types";
import { replaceParam } from "@/lib/url-state";
import { Field } from "../Field";
import { groupDomainChecks } from "./domains-view";
import { SectionLink } from "./SectionLink";
import type { SharingAdjusted } from "./sharing-notice";

/** ドメインの一覧(コード書式、「、」区切り) */
function Codes({ values }: { values: string[] }) {
  return (
    <>
      {values.map((v, i) => (
        <Fragment key={v}>
          {i > 0 ? "、" : null}
          <code>{v}</code>
        </Fragment>
      ))}
    </>
  );
}

/** まとまり 1 つを 1 行の文にする(例: example.com: www.example.com・form.example.com で共有) */
function GroupLine({ group }: { group: Site["cookieGroups"][number] }) {
  return (
    <span>
      <code>{group.domain}</code>: {`${group.hosts.join("・")}${group.hosts.length > 1 ? " で共有" : " だけ"}`}
    </span>
  );
}

/**
 * 訪問者 ID の節の 2 枚目のカード「訪問者 ID の共有」(spec §6.5)。
 * まとまり(cookieGroups)は control が保存済みの設定から計算した値で、共有がオフなら空。入力中の一覧からは計算しない(公開の接尾辞の一覧は control だけが持つ)。
 * チェックと導入の形はフォームの入力中の値(share / mode)で描く。保存済みと違うときは「未保存」と添える
 */
export function SharingCard({
  site,
  share,
  mode,
  disabled,
  canAdmin = true,
  error,
  className,
  hidden,
  adjusted,
  onShareChange,
}: {
  site: Site;
  share: boolean;
  mode: "A" | "B";
  disabled: boolean;
  /** 変えられるのは管理者以上。それ未満は案内の文言を「見る」にする(InstallTag と同じ) */
  canAdmin?: boolean;
  error?: string;
  className: string;
  hidden: boolean;
  /** 作成で衝突を避けるために変えたこと(sharingNoticeFor で突き合わせた値)。無ければ null */
  adjusted: SharingAdjusted | null;
  onShareChange: (v: boolean) => void;
}) {
  // 知らせはこの画面を開いた 1 回だけ。URL の ?sharing= は描いた後に外し、再読み込み・戻るでは出さない(外した後の再描画でも、この mount の間は出したまま)
  const [notice] = useState(adjusted);
  useEffect(() => {
    if (notice !== null) replaceParam("sharing", null);
  }, [notice]);
  const groups = site.cookieGroups;
  const unsaved = share !== site.shareSubdomains || mode !== site.mode;
  const verb = canAdmin ? "変える" : "見る";
  return (
    <section className={className} hidden={hidden} data-testid="sharing-card">
      <h2>訪問者 ID の共有</h2>
      {notice !== null ? <SharingNotice kind={notice} site={site} /> : null}
      <p className="muted">
        訪問者 ID の Cookie を、サブドメインをまたいで読めるようにします。申し込みフォームなどが別のサブドメインにあるときも、同じ ID で目標の達成を記録できます{mode === "B" ? "(Cloudflare 外のドメインでも)" : ""}。
      </p>
      <Field
        label="サブドメインをまたいだ共有"
        group
        hint={
          <>
            オンにすると、ID の Cookie を登録ドメイン(サブドメインを付けないドメイン。例: example.com)とそのサブドメインのどこでも読めるように発行します(Cookie の Domain 属性)。範囲はタグを置くドメインから、登録ドメインごとに計算します。UUID Cookie
            も同じ範囲で発行します。オフなら、ID はドメインごとに別です。
            <br />
            登録ドメイン(サブドメインを付けないドメイン)が違うドメインどうしでは、ブラウザが Cookie を渡さないので ID は別になります(テストはどのドメインでも出ます)
          </>
        }
        error={error}
      >
        <label className="row">
          {/* 値は state で持つ(無効のチェックは FormData に載らないため)。change は form に上がり、未保存の印とこの欄のエラーを消す */}
          <input name="shareSubdomains" type="checkbox" checked={share} onChange={(e) => onShareChange(e.target.checked)} disabled={disabled} /> サブドメインをまたいで ID を共有する(既定)
        </label>
        {share ? (
          <span className="muted" data-testid="sharing-groups">
            共有する範囲(登録ドメインごと。<SectionLink to="domains">タグを置くドメイン</SectionLink>から計算):
            <br />
            {groups.length > 0
              ? groups.map((g, i) => (
                  <span key={g.domain}>
                    {i > 0 ? <br /> : null}
                    <GroupLine group={g} />
                  </span>
                ))
              : site.shareSubdomains
                ? "—(共有できるドメインがありません)"
                : "保存すると、登録ドメインごとに計算します"}
          </span>
        ) : null}
      </Field>
      <p className="banner-warn" style={{ display: "block" }} data-testid="sharing-trust">
        共有すると、同じ登録ドメインのすべてのホストが ID を読み書きできます。第三者に任せたサブドメインや、利用者が中身を作れるサブドメインがあるなら、共有をオフにしてください。
        同じドメインの下に別の持ち主のサイト(レンタルサーバーの共用ドメインなど)や、この管理画面で別に登録したサイトがあると、ID の Cookie がそこにも届き、同意の撤回が互いに効きます
      </p>
      <h3>ID の Cookie の状態</h3>
      <div role="status" data-testid="sharing-status">
        <CookieStatus site={site} share={share} mode={mode} />
        {unsaved ? <p className="muted">未保存の入力での状態です。保存すると反映されます。</p> : null}
      </div>
      <p className="muted" data-testid="sharing-domains-link">
        タグを置くドメインと Cloudflare 経由かの判定は <SectionLink to="domains">ドメインで{verb}</SectionLink>。
      </p>
    </section>
  );
}

/** ID の Cookie の状態(設定ではなく表示)。共有がオンなら、まとまりごとの表 */
function CookieStatus({ site, share, mode }: { site: Site; share: boolean; mode: "A" | "B" }) {
  const uuid = <code>{site.uuidCookieName}</code>;
  const isB = mode === "B";
  if (share && site.cookieGroups.length > 0) {
    // 共有がオンなら Mode B でも HttpOnly にしない(Mode A はもともと JavaScript で書く)
    const why = mode === "B" ? "共有がオンなので、JavaScript から読める形で発行します(共有をオフにすると、今と同じ HttpOnly に戻ります)" : "Mode A ではタグが JavaScript で書くため(今と同じ)";
    return (
      <>
        <div className="card-flush scroll-x">
          <table data-testid="sharing-table">
            <thead>
              <tr>
                <th>まとまり(登録ドメイン)</th>
                <th>含むドメイン</th>
                {isB ? <th>Cloudflare 外のドメイン</th> : null}
                <th>ID の Cookie</th>
              </tr>
            </thead>
            <tbody>
              {site.cookieGroups.map((g) => {
                const { outside, unchecked } = groupDomainChecks(site, g);
                return (
                <tr key={g.domain}>
                  <td>
                    <code>{g.domain}</code>
                  </td>
                  <td>
                    {g.hosts.map((h, i) => (
                      <Fragment key={h}>
                        {i > 0 ? "、" : null}
                        <code>{h}</code>
                      </Fragment>
                    ))}
                  </td>
                  {isB ? <td>{outside.length > 0 ? <Codes values={outside} /> : "なし"}</td> : null}
                  <td>
                    <span className="badge badge-warn">JavaScript から読める</span>
                    <div className="muted">{why}</div>
                    {isB && unchecked.length > 0 ? (
                      <div className="muted">
                        未判定: <Codes values={unchecked} />(保存すると決まります)
                      </div>
                    ) : null}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>UUID Cookie: {site.uuidCookieEnabled ? <>{uuid} を、各まとまりの範囲で発行します</> : "発行しない"}</p>
        <p className="muted">
          まとまりの間では ID は別です(登録ドメイン = サブドメインを付けないドメインが違うと、ブラウザが Cookie を渡さないため)。JavaScript から読めるまとまりでは、ページ上のすべてのスクリプトから ID を読めます。
        </p>
      </>
    );
  }
  if (share) {
    // 共有をオンにしたばかり(未保存)か、共有できるドメインが無い。範囲は保存すると control が計算する
    return <p>共有する範囲が決まると、まとまりごとの状態をここに出します(保存すると決まります)。</p>;
  }
  const uuidLine = <p>UUID Cookie: {site.uuidCookieEnabled ? <>{uuid}(発行したドメインだけ)</> : "発行しない"}</p>;
  if (mode === "B") {
    return (
      <>
        <p>
          <span className="badge badge-ok">HttpOnly(JavaScript から読めない)</span> サブドメインをまたいだ ID の共有がオフなので、ID はドメインごとに別で、HttpOnly のままです。
        </p>
        {/* Cloudflare 外のドメインでは、タグが ID の Cookie を読めないので ID がつながらない。判定は保存済みの結果(outsideDomains) */}
        {site.outsideDomains.length > 0 ? (
          <p data-testid="sharing-outside-warning" style={{ color: "var(--warn)", fontWeight: 600 }}>
            Cloudflare 外のドメイン <Codes values={site.outsideDomains} /> では ID がつながりません(そこで達成した目標は、テストの結果に入りません)。「サブドメインをまたいで ID を共有する」をオンにしてください。
          </p>
        ) : null}
        {uuidLine}
      </>
    );
  }
  return (
    <>
      <p>
        <span className="badge badge-warn">JavaScript から読める</span> ID はドメインごとに別です(共有がオフ)。Mode A では、ID の Cookie はタグが JavaScript で書くので、常に JavaScript から読めます(今と同じ)。
      </p>
      {uuidLine}
    </>
  );
}

/** 作成で衝突を避けるために変えたことの知らせ(作成の直後に 1 回だけ) */
function SharingNotice({ kind, site }: { kind: SharingAdjusted; site: Site }) {
  return (
    <p className="banner-warn" style={{ display: "block" }} role="status" data-testid="sharing-adjusted">
      {kind === "off" ? (
        <>
          同じ導入の別のサイトと、同じ登録ドメインで訪問者 ID の Cookie がぶつかるため、このサイトは ID の共有をオフにして作りました。共有するときは、正本 Cookie 名を変えてから共有をオンにして保存してください
        </>
      ) : (
        <>
          同じ導入の別のサイトと、同じ登録ドメインで訪問者 ID の Cookie がぶつかるため、正本 Cookie 名を <code>{site.visitorCookieName}</code> に変えて作りました(共有はオンのままです)。UUID Cookie
          名もぶつかるときは、同じように変えています(今の名前は上の欄のとおりです)
        </>
      )}
    </p>
  );
}
