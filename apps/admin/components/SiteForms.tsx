"use client";
import { useHydrated } from "@/lib/use-hydrated";
import { useEffect, useState } from "react";
import { api, describeError, fieldErrors } from "@/lib/client";
import type { SiteCreated, UsageSettingsView } from "@/lib/types";
import { sharedFreeLimitNotice } from "@/lib/usage";
import { Field } from "./Field";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";
import { Picker } from "./ui/Picker";
import { navigateDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "./ui/BusyScope";

/** 作成の応答が 30 秒で分からなかったとき */
const CREATE_UNKNOWN = "作成できたか分かりません。再読み込みして確かめてください";

/**
 * 作成の後の遷移先。ふつうはサイトの概要。B139: 作成で衝突を避けるために共有か Cookie 名を変えたときは、
 * サイト設定の訪問者 ID の節へ ?sharing= を付けて移り、共有のカードで何を変えたかを 1 回だけ知らせる(作成の画面には結果の段が無いため)
 */
export function createdHref(workspaceId: string, s: SiteCreated): string {
  const base = `/w/${workspaceId}/sites/${s.id}`;
  if (!s.sharingAdjusted) return base;
  return `${base}/settings?section=identity&sharing=${s.sharingAdjusted.shareSubdomains ? "renamed" : "off"}`;
}

/** 新しいサイト。作成の POST から移った先の画面が開くまで、フォームのカードを覆って押し直せなくする(B173 第 2 段。二重の作成を止める) */
export function SiteCreateForm({ workspaceId, visibleSites }: { workspaceId: string; visibleSites: number }) {
  return (
    <BusyScope id="site-create">
      <SiteCreateFormBody workspaceId={workspaceId} visibleSites={visibleSites} />
    </BusyScope>
  );
}

function SiteCreateFormBody({ workspaceId, visibleSites }: { workspaceId: string; visibleSites: number }) {
  const hydrated = useHydrated();
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [mode, setMode] = useState("A");
  const [consent, setConsent] = useState("implicit");
  // B102: プラン(使用状況の設定)を読む。読めない(403 = 使用状況を見られない人)・失敗は null のまま = 注意を出さない
  const [usageSettings, setUsageSettings] = useState<UsageSettingsView | null>(null);
  useEffect(() => {
    let alive = true;
    api<UsageSettingsView>("GET", "/usage/settings")
      .then((s) => alive && setUsageSettings(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return (
    <form method="post"
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setFields({});
        const fd = new FormData(e.currentTarget);
        // B148: 入力は一覧の 1 行目として送る(https:// や末尾の / は control がそろえる)。足すのは作成後のサイト設定のドメインの節
        const body: Record<string, unknown> = { name: fd.get("name"), domains: [String(fd.get("domain")).trim()], mode: fd.get("mode"), consentMode: fd.get("consentMode") };
        if (fd.get("id")) body.id = fd.get("id");
        const outcome = await run({
          label: "作成中…",
          write: (signal) => api<SiteCreated>("POST", `/workspaces/${workspaceId}/sites`, body, { signal }),
          // クライアント遷移(router.push)は共有 layout(サイドバーの Site 一覧)を描き直さず、
          // router.refresh() を足しても確実には反映されない(このバージョンの Next.js/vinext で実測)ため、全画面の遷移にする。
          // 移った先が開くまで覆いと実行権を保つ(移動の間に押せる状態に戻ると、二度目の作成になるため)
          after: "navigate",
          navigate: (s) => navigateDocument(createdHref(workspaceId, s)),
        });
        if (outcome.kind === "failed") {
          setError(describeError(outcome.error));
          setFields(fieldErrors(outcome.error));
        } else if (outcome.kind === "unknown") setError(CREATE_UNKNOWN);
      }}
    >
      <h2>新しいサイト</h2>
      {sharedFreeLimitNotice(usageSettings, visibleSites) ? (
        <div className="banner-note" data-testid="free-shared-limit-note">
          <span>
            Cloudflare の Free の 1 日の上限(Workers のリクエスト 10 万など)はアカウント全体のもので、この導入のすべてのサイト(と同じアカウントのほかの Worker)が分け合います。あなたが見られるサイトは、いま {visibleSites} 個あります。新しいサイトを足すと、1 サイトあたりの余裕が減ります。
            {/* ホームの使用状況の節は、取得が設定済みのときだけ(システム管理者以外にも)出る(lib/usage.ts の summaryView) */}
            {usageSettings?.configured ? "使用量はホームの「使用状況」で確かめられます。" : ""}
            目安は運用ガイドの「1 日の予算と止まったときの見え方」にあります
          </span>
        </div>
      ) : null}
      <Field label="名前" error={fields.name}>
        <input name="name" required />
      </Field>
      <Field label="タグを置くドメイン(1 つ目)" hint="作成後に、サイト設定のドメインの節で足せます" error={fields["domains.0"] ?? fields.domains}>
        <input name="domain" required placeholder="www.example.com" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="サイト ID(任意)" hint="タグの URL(/s/<サイト ID>.js)になります。既存タグを引き継ぐ場合はその ID を指定します。作成後は変更できません" error={fields.id}>
        <input name="id" pattern="[A-Za-z0-9_\-]{1,64}" placeholder="site_example" />
      </Field>
      <Field label="導入の形" group error={fields.mode}>
        <Picker
          label="導入の形"
          name="mode"
          value={mode}
          options={[
            { value: "A", label: "A: JS Cookie(タグ 1 本)" },
            { value: "B", label: "B: サーバー発行 Cookie(同じゾーンの Workers Route。サイトが Cloudflare 配下のとき)" },
          ]}
          onChange={setMode}
        />
      </Field>
      <Field label="同意の扱い" group hint="EU など、訪問者の同意が必要なサイトでは「訪問者が同意するまで動かさない」を選びます(同意の受け渡しはサイト導入ガイドの 7 節)" error={fields.consentMode}>
        <Picker
          label="同意の扱い"
          name="consentMode"
          value={consent}
          options={[
            { value: "implicit", label: "同意を待たずに動かす(既定。同意管理ツールを使っていないサイト向け)" },
            { value: "required", label: "訪問者が同意するまで動かさない(同意管理ツールから同意が届くまで、割り当ても計測もしない)" },
          ]}
          onChange={setConsent}
        />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy} disabled={!hydrated}>作成</SubmitButton>
    </form>
  );
}
