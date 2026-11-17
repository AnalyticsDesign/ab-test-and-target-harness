"use client";
import { Fragment, type ReactNode } from "react";
import type { DomainChecks, Site } from "@/lib/types";
import { Field } from "../Field";
import { Picker } from "../ui/Picker";
import { SectionLink } from "./SectionLink";
import { SECTIONS } from "./sections";
import {
  DERIVED_LABELS,
  LABEL_DEV,
  LABEL_PENDING,
  MAX_DOMAINS,
  NOTE_ROUTE,
  checkOf,
  domainsChanged,
  edgeLost,
  normalizeDomain,
  previewNormalized,
  savedRowOf,
  verdictLabel,
} from "./domains-view";
import styles from "./DomainsSection.module.css";

const HEADING = SECTIONS.find((s) => s.id === "domains")!.heading;
const VERDICT_NAME = { edge: "Cloudflare 経由", outside: "Cloudflare 外", unknown: "確かめられませんでした", dev: "開発用" } as const;
const TONE_CLASS = { ok: "badge badge-ok", warn: "badge badge-warn", gray: "badge" } as const;

/** コードの並び(a・b・c) */
function Codes({ values }: { values: string[] }) {
  return (
    <>
      {values.map((v, i) => (
        <Fragment key={v}>
          {i > 0 ? "・" : null}
          <code>{v}</code>
        </Fragment>
      ))}
    </>
  );
}

/** Route の設置手順へのリンク(同じ節の中) */
const RouteLink = ({ children }: { children: ReactNode }) => <a href="#route-steps">{children}</a>;

/**
 * サイト設定の「ドメイン」の節(B148)。導入の形・タグを置くドメインの一覧・この一覧から決まる値・Route の設置手順(Mode B)・Cloudflare 外のドメインの説明(Mode B)。
 * 一覧の行は SiteSettingsForm の state(rows)。行の入力欄の name は `domains.<n>`(control の 422 のキーと同じ)で、change は form に上がって
 * 未保存の印とその行のエラーを消す。行を足す・消すは change が起きないので onListEdited で知らせる。
 * 札と「この一覧から決まる値」は保存済みの値(site)から出す(判定は保存のときに control がする)。domainChecks は直前の保存の結果
 */
export function DomainsSection({
  site,
  mode,
  rows,
  fields,
  disabled,
  canAdmin,
  domainChecks,
  className,
  hidden,
  onModeChange,
  onRowsChange,
  onListEdited,
}: {
  site: Site;
  mode: "A" | "B";
  rows: string[];
  fields: Record<string, string>;
  disabled: boolean;
  canAdmin: boolean;
  domainChecks: DomainChecks;
  className: string;
  hidden: boolean;
  onModeChange: (mode: "A" | "B") => void;
  onRowsChange: (rows: string[]) => void;
  /** 行を足した・消した(未保存の印を立て、一覧のエラーを消す。行の番号がずれるため) */
  onListEdited: () => void;
}) {
  const isB = mode === "B";
  // 保存済みの判定が使えるのは、保存済みのサイトも Mode B のとき(Mode A の間の判定は使わない)
  const verdictsUsable = site.mode === "B";
  const verb = canAdmin ? "変える" : "見る";
  const lost = edgeLost(domainChecks);
  const unsaved = mode !== site.mode || domainsChanged(rows, site.domains);
  const listError = fields.domains;

  function badge(raw: string): { label: string; note: string | null; tone: "ok" | "warn" | "gray" } {
    const n = normalizeDomain(raw);
    if (n.ok && n.dev) return { label: LABEL_DEV, note: null, tone: "gray" };
    const saved = verdictsUsable && n.ok ? savedRowOf(raw, site.domains) : null;
    if (!saved) return { label: LABEL_PENDING, note: null, tone: "gray" };
    return verdictLabel(saved, mode, checkOf(saved.value, domainChecks));
  }

  return (
    <section className={className} hidden={hidden} data-testid="domains-section">
      <h2>{HEADING}</h2>
      {lost.length > 0 ? (
        <p className="banner-warn" style={{ display: "block" }} role="status" data-testid="domains-edge-lost">
          この保存で、次のドメインが Cloudflare 経由ではなくなりました:{" "}
          {lost.map((c, i) => (
            <Fragment key={c.domain}>
              {i > 0 ? "・" : null}
              <code>{c.domain}</code>(今の判定: {VERDICT_NAME[c.to]})
            </Fragment>
          ))}
          。このドメインでは、ID の扱いが Mode A と同じになります(Safari では ID が弱くなります)。Route を外していないかを確かめ、Route を足し直したらもう一度保存してください(
          <RouteLink>Route の設置手順</RouteLink>)
        </p>
      ) : null}
      {isB && site.mode === "B" && site.edgeDomains.length === 0 ? (
        <p className="banner-warn" style={{ display: "block" }} role="status" data-testid="domains-no-edge">
          Cloudflare 経由のドメインが無いので、どのドメインも Mode A と同じ動きになります(Safari では ID が弱くなります)。Route を足してから保存すると Cloudflare 経由になります(
          <RouteLink>Route の設置手順</RouteLink>)
        </p>
      ) : null}
      <Field label="導入の形" group hint="Mode B のときだけ、下の一覧に Cloudflare 経由かの判定の札と、Route の設置手順・Cloudflare 外のドメインの説明が出ます" error={fields.mode}>
        <Picker
          label="導入の形"
          name="mode"
          value={mode}
          disabled={disabled}
          options={[
            { value: "A", label: "A: JS Cookie" },
            { value: "B", label: "B: サーバー発行 Cookie(同じゾーンの Workers Route)" },
          ]}
          onChange={(v) => onModeChange(v as "A" | "B")}
        />
      </Field>
      <div className="field" style={{ marginBottom: 4 }}>
        <span className="field-label">タグを置くドメイン(1 行に 1 つ)</span>
        <span className="field-hint">
          www.example.com の形で 1 行に 1 つ(https:// と末尾の /、既定のポートの :443 は保存のときに取り除きます)。1 行目が代表のドメインです。開発用の http://localhost:8080 などは、その形のまま使えます。日本語ドメインは
          punycode(xn--)で書きます。{MAX_DOMAINS} 件まで
          {isB ? "。保存のとき、各ドメインで edge が応答するかを確かめ、「Cloudflare 経由」か「Cloudflare 外」(Cloudflare を通らないドメイン)かを決めます" : ""}
        </span>
      </div>
      {/* 列の見出し(行と同じ列。狭い幅では隠す) */}
      <div className={`${styles.main} ${styles.head} ${isB ? "" : styles.noCheck}`} aria-hidden="true">
        <span className={styles.no}>#</span>
        <span className={styles.input}>ドメイン</span>
        <span className={styles.rep} />
        {isB ? <span className={styles.check}>Cloudflare 経由か(保存のときに確かめます)</span> : null}
        <span className={styles.del} />
      </div>
      <div className={styles.rows}>
        {rows.map((raw, i) => {
          const preview = previewNormalized(raw);
          const n = normalizeDomain(raw);
          const b = isB && raw.trim() !== "" ? badge(raw) : null;
          return (
            <div className={styles.row} key={i}>
              <div className={`${styles.main} ${isB ? "" : styles.noCheck}`}>
                <span className={styles.no}>{i + 1}</span>
                <span className={styles.input}>
                  <input
                    name={`domains.${i}`}
                    aria-label={`${i + 1} 行目のドメイン`}
                    value={raw}
                    placeholder="www.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(e) => onRowsChange(rows.map((r, j) => (j === i ? e.target.value : r)))}
                  />
                </span>
                <span className={styles.rep}>{i === 0 ? <span className={`badge ${styles.badgeRep}`} title="一覧の表示とプレビューの URL に使うドメイン">代表</span> : null}</span>
                {b ? (
                  <span className={styles.check} data-testid="domain-verdict">
                    <span className={TONE_CLASS[b.tone]}>{b.label}</span>
                    {b.note ? (
                      <span className={styles.badgeNote}>
                        {b.note}
                        {b.note === NOTE_ROUTE ? (
                          <>
                            (<RouteLink>手順</RouteLink>)
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {canAdmin ? (
                  <button
                    type="button"
                    className={`btn btn-sm btn-ghost ${styles.del}`}
                    aria-label={`${i + 1} 行目を削除`}
                    disabled={disabled}
                    onClick={() => {
                      onRowsChange(rows.filter((_, j) => j !== i));
                      onListEdited();
                    }}
                  >
                    削除
                  </button>
                ) : null}
              </div>
              <div className={styles.notes}>
                {preview ? (
                  <span>
                    保存すると <code>{preview}</code> になります
                  </span>
                ) : null}
                {n.ok && n.dev ? (
                  <span>
                    開発用の形(http・ポート付き)として、この形のまま使います
                    {isB ? "。Cloudflare 経由かは確かめません(Workers Route は http・ポート付きのアドレスに置けないため)" : ""}
                  </span>
                ) : null}
              </div>
              {fields[`domains.${i}`] ? (
                <div className={styles.err}>
                  <span role="alert" className="field-error">
                    {fields[`domains.${i}`]}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className={styles.foot}>
        {listError ? (
          <span role="alert" className="field-error">
            {listError}
          </span>
        ) : null}
        {canAdmin ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={disabled || rows.length >= MAX_DOMAINS}
              onClick={() => {
                onRowsChange([...rows, ""]);
                onListEdited();
              }}
            >
              ドメインを足す
            </button>
            <span className="muted">{rows.length >= MAX_DOMAINS ? `${MAX_DOMAINS} 件までです` : `${rows.length} / ${MAX_DOMAINS} 件`}</span>
          </>
        ) : null}
      </div>
      <div className={styles.derived} data-testid="domains-derived">
        <div className={styles.derivedHead}>この一覧から決まる値(保存のときに決まります。ここでは変えられません)</div>
        <dl>
          <dt>{DERIVED_LABELS.rep}</dt>
          <dd>{site.domain ? <><code>{site.domain}</code>(1 行目。一覧の表示とプレビューの URL)</> : "—"}</dd>
          <dt>{DERIVED_LABELS.origins}</dt>
          <dd>{site.allowedOrigins.length > 0 ? <Codes values={site.allowedOrigins} /> : "—"}</dd>
          {isB ? (
            site.mode === "B" ? (
              <>
                <dt>{DERIVED_LABELS.edge}</dt>
                <dd>{site.edgeDomains.length > 0 ? <Codes values={site.edgeDomains} /> : "なし(どのドメインも Mode A と同じ動き)"}</dd>
                <dt>{DERIVED_LABELS.outside}</dt>
                <dd>{site.outsideDomains.length > 0 ? <Codes values={site.outsideDomains} /> : "なし"}</dd>
                {site.uncheckedDomains.length > 0 ? (
                  <>
                    <dt>{DERIVED_LABELS.unchecked}</dt>
                    <dd>
                      <Codes values={site.uncheckedDomains} />
                      (Cloudflare 外として動きます。もう一度保存すると確かめ直します)
                    </dd>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <dt>{DERIVED_LABELS.edge}</dt>
                <dd>保存すると決まります</dd>
              </>
            )
          ) : null}
          <dt>{DERIVED_LABELS.groups}</dt>
          <dd>
            {!site.shareSubdomains
              ? "共有しない(ドメインごと)"
              : site.cookieGroups.length > 0
                ? site.cookieGroups.map((g, i) => (
                    <Fragment key={g.domain}>
                      {i > 0 ? <br /> : null}
                      <code>{g.domain}</code>: {`${g.hosts.join("・")}${g.hosts.length > 1 ? " で共有" : " だけ"}`}
                    </Fragment>
                  ))
                : "—(共有できるドメインがありません)"}
            <br />
            <span className="muted">
              登録ドメイン = サブドメインを付けないドメイン。共有のオン・オフは <SectionLink to="identity">訪問者 ID で{verb}</SectionLink>
            </span>
          </dd>
        </dl>
        {unsaved ? <p className="muted" style={{ margin: "6px 0 0" }}>保存済みの値です。入力中の一覧と導入の形は、保存すると反映されます。</p> : null}
      </div>
      {isB ? (
        <>
          <div className="banner-warn" style={{ display: "block" }} id="route-steps" data-testid="route-steps">
            <p>
              <strong>Mode B(サーバー発行 Cookie)の設置手順</strong>(インフラ作業。管理画面は設定値の保持までです)
            </p>
            <ol>
              <li>
                対象ゾーンの Workers Route <code>&lt;ドメイン&gt;/__ab/*</code> → <code>wtt-edge</code> を、タグを置くドメインごとに、<code>apps/edge/wrangler.jsonc</code> の <code>routes</code> に足して edge をデプロイする(デプロイガイド
                6.7)。Cloudflare のダッシュボードだけで足した Route は、次の edge のデプロイで設定ファイルの内容に置き換わり、消える。設定ファイルの Route は <code>*.example.com/__ab/*</code> のようなワイルドカード 1 本でまとめてもよい(apex の <code>example.com</code> は含まないので、apex にも置くなら <code>example.com/__ab/*</code> を別に足す)。この画面の一覧には、ワイルドカードではなくドメインを 1 つずつ書く
              </li>
              <li>Route を足したら、この画面で保存する。保存のときに各ドメインを確かめ、行の右の札が「Cloudflare 経由」になる</li>
              <li>
                保存後、<code className={styles.cmd}>curl -si -X POST https://&lt;host&gt;/__ab/decision -H 'content-type: application/json' -d '{"{"}"v":1,"url":"https://&lt;host&gt;/","referrer":"","device":"desktop"{"}"}'</code> で{" "}
                <code>Set-Cookie</code> が返ることを確認する
              </li>
            </ol>
          </div>
          <h3>Cloudflare 外のドメイン</h3>
          <p className="muted">
            Cloudflare 外のドメインは、タグを置くドメインのうち、保存のときの判定で「Cloudflare 外」になったドメイン(Cloudflare を通らないドメイン)です。Cloudflare 外のドメインでは、タグが ID の Cookie を
            JavaScript で読み、edge の <code>/v1/</code> に送ります(Mode A と同じ動き)。共有がオフだと、Cloudflare 外のドメインでは ID の Cookie を読めないので、ID がつながりません。
          </p>
          <p className="muted">
            Cloudflare 外のドメインに来た訪問者に ID の Cookie が無ければ、タグが JavaScript で発行します(共有する範囲付き)。JavaScript で発行した ID には印の Cookie を付け、Cloudflare 外のドメインではその ID
            だけを書き直して期限を延ばします。その訪問者が Cloudflare を通るドメインに来ると、edge がサーバーから発行し直して印を消し、それからは Cloudflare 外のドメインで書き直しません。
          </p>
          <p className="muted">Safari では、Cloudflare 外のドメインだけに来る訪問者の ID は Mode A と同じ扱いです(7 日間操作が無いと消えます)。</p>
        </>
      ) : null}
    </section>
  );
}
