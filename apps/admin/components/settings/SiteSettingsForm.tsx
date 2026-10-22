"use client";
import { timeZoneOptions } from "@/lib/time-zones";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError, fieldErrors } from "@/lib/client";
import { budgetFromInput, NEW_PROFILE_BUDGET_HINT, NEW_PROFILE_BUDGET_LABEL } from "@/lib/new-profile-budget";
import { capacityWarning, cspNotice, resultsToggleNotice, splitCode } from "@/lib/results-settings";
import { clearSettingsSection, sectionOfHref, setSectionErrors, setSettingsSection, syncSettingsSection, useSettingsSection } from "@/lib/settings-section";
import type { AnalyticsSettings, Site } from "@/lib/types";
import { useLeaveGuard, type LeaveAttempt } from "../api-keys/useLeaveGuard";
import { Field } from "../Field";
import { ErrorBox } from "../ErrorBox";
import { LocalTime } from "../LocalTime";
import { SubmitButton } from "../SubmitButton";
import { SaveBar } from "../ui/SaveBar";
import { Picker } from "../ui/Picker";
import { Combo } from "../ui/Combo";
import { InstallTag } from "./InstallTag";
import { DangerZone } from "./DangerZone";
import { SECTIONS, fieldKeysFor, firstInvalidSection, sectionOfField, type SectionId } from "./sections";

/** 節の見出し(B31 ⑥)。文字の正は sections.ts の SECTIONS */
const heading = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.heading;

const ANALYTICS_FIELDS: Array<{ path: string; label: string; get: (a: AnalyticsSettings) => string }> = [
  { path: "extraKey", label: "extra の名前空間キー", get: (a) => a.extraKey },
  { path: "exposure.event", label: "露出のイベント名", get: (a) => a.exposure.event },
  { path: "exposure.keys.experimentId", label: "露出: experimentId キー", get: (a) => a.exposure.keys.experimentId! },
  { path: "exposure.keys.experimentName", label: "露出: experimentName キー", get: (a) => a.exposure.keys.experimentName! },
  { path: "exposure.keys.variantId", label: "露出: variantId キー", get: (a) => a.exposure.keys.variantId! },
  { path: "exposure.keys.variantName", label: "露出: variantName キー", get: (a) => a.exposure.keys.variantName! },
  { path: "conversion.event", label: "コンバージョンのイベント名", get: (a) => a.conversion.event },
  { path: "conversion.keys.goalId", label: "コンバージョン: goalId キー", get: (a) => a.conversion.keys.goalId! },
  { path: "conversion.keys.goalName", label: "コンバージョン: goalName キー", get: (a) => a.conversion.keys.goalName! },
];
function setPath(obj: Record<string, unknown>, path: string, value: string) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]!] = value;
}

/** spec §5.4 / §10.9: Identity と Analytics 命名設定を 1 画面に集約(ADMIN 以上) */
export function SiteSettingsForm({
  site,
  canAdmin,
  canDelete,
  tagOrigin,
  initialSection,
  resultsStore,
  edgeOrigin,
  runningTests,
  runningRecordedTests,
}: {
  site: Site;
  canAdmin: boolean;
  canDelete: boolean;
  tagOrigin: string | null;
  initialSection: SectionId;
  /** 計測用のデータベース(wtt-results)がこの導入にあるか(無いと結果の記録を有効にできない) */
  resultsStore: boolean;
  edgeOrigin: string | null;
  /** 切り替えの確認に使う件数(エクスペリエンスの一覧から数える) */
  runningTests: number;
  runningRecordedTests: number;
}) {
  const router = useRouter();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  // 開いている節は lib/settings-section の store で、サイドバーと共有する(B60)。約束は store の説明のとおり:
  // mount と initialSection が変わったときだけ store に入れ、unmount で空に戻す。ふつうの再描画では入れ直さない
  // (保存の後の router.refresh などで入れ直すと、利用者が切り替えた節が元に戻るため)。
  // この mount で入れる前は initialSection を表示する: 別のサイト設定の画面からのクライアント遷移では、前のフォームが store を
  // 空に戻す(unmount のコミット)より先にこのフォームの最初の描画が走り、store に前の画面の節が残っていることがあるため
  const stored = useSettingsSection(initialSection);
  const synced = useRef(false);
  const section = synced.current ? stored : initialSection;
  useLayoutEffect(() => {
    syncSettingsSection(initialSection);
    synced.current = true;
  }, [initialSection]);
  useLayoutEffect(
    () => () => {
      clearSettingsSection();
      setSectionErrors([]);
    },
    [],
  );
  // 節を切り替えたことがあるか。節の「入ってくる」動き(.enter)は切替の後だけ付ける(初回表示は外側の PageEnter が動くので重ねない)。
  // 切り替えはこのフォームの外(サイドバー・戻る / 進む)からも来るので、前に描いた節を覚えて、変わったときに立てる
  const [switched, setSwitched] = useState(false);
  const drawn = useRef(section);
  useLayoutEffect(() => {
    if (drawn.current === section) return;
    drawn.current = section;
    setSwitched(true);
  }, [section]);
  const inForm = SECTIONS.find((s) => s.id === section)!.inForm;
  const [mode, setMode] = useState(site.mode);
  const [consent, setConsent] = useState(site.consentMode);
  const [tz, setTz] = useState(site.timezone);
  // 無効のスイッチは disabled の入力として送られない(FormData に載らない)ので、値は state で持つ
  const [resultsOn, setResultsOn] = useState(site.resultsEnabled);
  // D9 ③(plan ③ K18): 計測用のデータベースの使用量が 80% 以上なら警告、95% 以上なら記録を止めている知らせ(測る前は出さない)
  const capacity = capacityWarning(site.resultsCapacity);
  const [idSourceKind, setIdSourceKind] = useState<"ab" | "cookie">(site.idSource === "ab" ? "ab" : "cookie");
  const lines = (v: string) => String(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // Analytics のフィールド error は control 側の 422 コードによって key の形が違う(どちらも path は配列):
  // strictObject 全体の validation_failed なら ["analytics","exposure","event"] → "analytics.exposure.event"、
  // invalid_analytics(applySitePatch が AnalyticsSettingsSchema だけを検証したもの)は
  // ["exposure","event"] → "analytics" プレフィックス無しの "exposure.event"。両方を引けるようにする
  const analyticsError = (path: string) => fields[`analytics.${path}`] ?? fields[path];
  const errorSections = new Set(Object.keys(fields).map(sectionOfField));
  // エラーのある節をサイドバーと共有する(B60)。中身が変わったときだけ書く(store が同じ中身なら知らせない)
  const errorKey = [...errorSections].sort().join(",");
  useEffect(() => {
    setSectionErrors(errorKey ? (errorKey.split(",") as SectionId[]) : []);
  }, [errorKey]);
  // B31 ④: 利用者が変えた欄のエラーだけを消す(印も次の保存まで残らない)。name と 422 のキーの対応は fieldKeysFor
  const clearField = (name: string) => {
    if (!name) return; // Combo の検索の欄のように name の無い入力の change も form に届く
    const hit = fieldKeysFor(name);
    setFields((f) => {
      const keys = Object.keys(f).filter(hit);
      if (keys.length === 0) return f;
      const next = { ...f };
      for (const k of keys) delete next[k];
      return next;
    });
  };
  // 未保存の変更があれば、画面の中の移動と再読み込み・タブを閉じるを確認する(ExperimentEditor の評価計画と同じ作り)。
  // 同じサイト設定の画面の節のリンク(サイドバー)は確認せず節だけを切り替える(入力はフォームに残る)。
  // useLeaveGuard は渡した関数を ref に入れて最新のものを呼ぶので、毎回作ってよい
  async function onLeave(a: LeaveAttempt) {
    if (a.kind === "href") {
      const target = sectionOfHref(a.href, window.location.pathname);
      if (target !== null) {
        setSettingsSection(target);
        return;
      }
    }
    if (!(await ask({ title: "サイト設定の変更を保存していません", body: "移動すると、入力した値は失われます", confirmLabel: "保存せずに移動", tone: "danger" }))) {
      if (a.kind === "logout") a.form.closest("details")?.removeAttribute("open");
      return;
    }
    bypass();
    if (a.kind === "href") router.push(a.href);
    else a.form.requestSubmit();
  }
  const { bypass } = useLeaveGuard(dirty, (a) => void onLeave(a));
  const invalidNames = useRef<string[]>([]);
  function onInvalid(e: React.FormEvent<HTMLFormElement>) {
    const name = (e.target as HTMLInputElement).name;
    if (!name) return;
    if (invalidNames.current.length === 0) {
      // 同じ送信で飛ぶ invalid は同期的に続けて来る。出そろってから 1 回だけ節を開く
      queueMicrotask(() => {
        setSettingsSection(firstInvalidSection(invalidNames.current));
        invalidNames.current = [];
      });
    }
    invalidNames.current.push(name);
  }
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const visitorCookieName = String(fd.get("visitorCookieName"));
    // fd は確認の前に読んでおく(await の後は e.currentTarget が null になる)
    if (
      visitorCookieName !== site.visitorCookieName &&
      !(await ask({
        title: "正本 Cookie 名を変えますか?",
        body: "全訪問者の ID が再発行され、割当がリセットされます(旧 Cookie は保持期限まで削除対象として記録されます)",
        confirmLabel: "変更して保存",
      }))
    )
      return;
    // 結果の記録を切り替えるとき、実行中 / 記録中のテストがあれば影響を確認する(キャンセルなら保存しない)
    const resultsChanged = resultsOn !== site.resultsEnabled;
    const toggleNotice = resultsChanged ? resultsToggleNotice({ enabling: resultsOn, runningTests, runningRecordedTests }) : null;
    if (toggleNotice !== null && !(await ask(resultsOn ? { title: "結果の記録を有効にしますか?", body: toggleNotice, confirmLabel: "有効にして保存" } : { title: "結果の記録を止めますか?", body: toggleNotice, confirmLabel: "止めて保存", tone: "danger" }))) return;
    const analytics: Record<string, unknown> = {};
    analytics.dataLayerName = String(fd.get("analytics.dataLayerName"));
    for (const f of ANALYTICS_FIELDS) setPath(analytics, f.path, String(fd.get(`analytics.${f.path}`)));
    const body: Record<string, unknown> = {
      name: fd.get("name"),
      domain: fd.get("domain"),
      mode: fd.get("mode"),
      idSource: idSourceKind === "ab" ? "ab" : `cookie:${String(fd.get("byoidCookie")).trim()}`,
      allowedOrigins: lines(String(fd.get("allowedOrigins"))),
      hosts: lines(String(fd.get("hosts"))).map((h) => h.toLowerCase()),
      consentMode: fd.get("consentMode"),
      retentionDays: Number(fd.get("retentionDays")),
      forgetOnRevoke: fd.get("forgetOnRevoke") === "on",
      resultsEnabled: resultsOn,
      resultsRetentionDays: Number(fd.get("resultsRetentionDays")),
      timezone: fd.get("timezone"),
      decisionTimeoutMs: Number(fd.get("decisionTimeoutMs")),
      // 空欄 = null で、使用状況の設定のプランの既定に戻す
      newProfileBudgetPerDay: budgetFromInput(fd.get("newProfileBudgetPerDay")),
      visitorCookieName,
      uuidCookieEnabled: fd.get("uuidCookieEnabled") === "on",
      uuidCookieName: fd.get("uuidCookieName"),
      analytics,
      // Plan 10 B1: 外部 ID 2 項目(決定 34。資格情報ではない)。空欄 = null で解除
      ga4PropertyId: String(fd.get("ga4PropertyId") ?? "").trim() || null,
      bigqueryDataset: String(fd.get("bigqueryDataset") ?? "").trim() || null,
    };
    setBusy(true);
    setError(null);
    setFields({});
    setSaved(false);
    try {
      await api("PATCH", `/sites/${site.id}`, body);
      setSaved(true);
      setDirty(false);
      router.refresh();
    } catch (err) {
      setError(describeError(err));
      const fe = fieldErrors(err);
      setFields(fe);
      const first = Object.keys(fe)[0];
      if (first) setSettingsSection(sectionOfField(first));
    } finally {
      setBusy(false);
    }
  }
  const ro = !canAdmin || busy;
  return (
    <div>
      {!canAdmin ? <p className="banner-warn">サイト設定の変更は管理者以上が行います(閲覧のみ)</p> : null}
      {/* 節の切り替えは左の設定のメニュー(SettingsSidebar)の「サイト設定」の項目。入力エラーのある節の印もそちらに付く */}
      <form id="site-settings-form" onSubmit={onSubmit} onInvalid={onInvalid}
        onChange={(e) => {
          setDirty(true);
          // change は変えた欄から form へ上がってくる(型は form の change だが、target は欄)
          const name = (e.target as EventTarget as { name?: unknown }).name;
          if (typeof name === "string") clearField(name);
        }}
      >
        {/* 節は hidden で隠すだけ(unmount しない = 入力を保つ)。hidden が外れて display が戻るときに .enter の動きが再生される(切替の後だけ) */}
        <section className={switched ? "card enter" : "card"} hidden={section !== "general"}>
          <h2>{heading("general")}</h2>
          <Field label="名前" error={fields.name}>
            <input name="name" defaultValue={site.name} disabled={ro} required />
          </Field>
          <Field label="ドメイン" error={fields.domain}>
            <input name="domain" defaultValue={site.domain} disabled={ro} required />
          </Field>
          <Field label="受け付けるサイトのアドレス(Origin。1 行に 1 つ。https://host[:port] の形)" hint="Mode A の判定(/decision)・イベント(/event)はここに一致する Origin だけ受け付けます。空だと全拒否(403)" error={fields.allowedOrigins}>
            <textarea name="allowedOrigins" defaultValue={site.allowedOrigins.join("\n")} disabled={ro} />
          </Field>
          <Field label="同意の扱い" group error={fields.consentMode}>
            <Picker
              label="同意の扱い"
              name="consentMode"
              value={consent}
              disabled={ro}
              options={[
                { value: "implicit", label: "同意を待たずに動かす(既定。同意管理ツールを使っていないサイト向け)" },
                { value: "required", label: "訪問者が同意するまで動かさない(同意管理ツールから同意が届くまで、割り当ても計測もしない)" },
              ]}
              onChange={(v) => {
                setConsent(v as Site["consentMode"]);
                setDirty(true); // hidden input の値の変更は form の change イベントを起こさない
                clearField("consentMode"); // 同じ理由で、エラーもここで消す
              }}
            />
          </Field>
          <Field label="タイムゾーン" group hint="曜日・時間帯の条件をこのタイムゾーンの時刻で判定します(訪問者の端末のタイムゾーンは使いません)。変更は次の公開で反映されます" error={fields.timezone}>
            <Combo
              label="タイムゾーン"
              name="timezone"
              value={tz}
              disabled={ro}
              placeholder="タイムゾーンを検索"
              items={timeZoneOptions(site.timezone).map((v) => ({ value: v, label: v }))}
              onChange={(v) => {
                setTz(v);
                setDirty(true);
                clearField("timezone");
              }}
            />
          </Field>
          <Field label="retentionDays(訪問者プロフィールと旧 Cookie 名の保持日数)" hint="最終訪問からこの日数で訪問者プロフィールを自動削除します。変更は次に訪問した訪問者から効きます(休眠中のプロフィールは変更前の日数で消えます)。" error={fields.retentionDays}>
            <input name="retentionDays" type="number" min={1} max={3650} defaultValue={site.retentionDays} disabled={ro} />
          </Field>
          <Field label="撤回時に訪問者プロフィールを削除(forgetOnRevoke)" hint="訪問者が同意を撤回(AB.consent(false))したとき、サーバー側の履歴(目標の達成・閲覧回数・保存済み割当)を即時に削除します。オフにすると retentionDays まで保持され、誤って拒否した訪問者の履歴は失われません — ただし Mode C(BYOID)では再許可時に撤回前の履歴へ再接続します。Mode B(サーバー発行 Cookie)では訪問者プロフィールの削除には効きません — 撤回は Cookie の削除だけで、訪問者プロフィールは retentionDays で消えます。結果を記録するサイトでは、その訪問者の結果の記録も削除します(Mode B を含む)。削除は best-effort です — 通信断や DO 障害で forget が届かなかった場合も retentionDays で消えます" error={fields.forgetOnRevoke}>
            <label>
              <input name="forgetOnRevoke" type="checkbox" defaultChecked={site.forgetOnRevoke} disabled={ro} /> 有効にする(既定)
            </label>
          </Field>
          <Field label="decisionTimeoutMs(300〜3000)" error={fields.decisionTimeoutMs}>
            <input name="decisionTimeoutMs" type="number" min={300} max={3000} defaultValue={site.decisionTimeoutMs} disabled={ro} />
          </Field>
          <Field label={NEW_PROFILE_BUDGET_LABEL} hint={NEW_PROFILE_BUDGET_HINT} error={fields.newProfileBudgetPerDay}>
            <input name="newProfileBudgetPerDay" type="number" min={1} max={100000000} step={1} defaultValue={site.newProfileBudgetPerDay ?? ""} placeholder="空欄 = プランの既定" disabled={ro} />
          </Field>
          <h3>結果を記録する</h3>
          <p className="muted">テストの参加者と目標の達成を、この導入のデータベースに記録します。記録するのは、有効にした後に開始したテストだけです</p>
          <Field
            label="結果を記録する"
            hint={resultsStore ? undefined : "計測用のデータベースが導入されていません。導入ガイドの手順で作ってください"}
            error={fields.resultsEnabled}
          >
            {/* 計測用のデータベースが無い導入では有効にできない(すでに有効なら止められる)。値は state で持つ(送信時に FormData から読まない) */}
            <label>
              <input
                name="resultsEnabled"
                type="checkbox"
                checked={resultsOn}
                onChange={(e) => setResultsOn(e.target.checked)}
                disabled={ro || (!resultsStore && !resultsOn)}
              />{" "}
              有効にする
            </label>
          </Field>
          {resultsOn ? (
            <p className="banner-warn" style={{ display: "block" }} data-testid="results-csp-notice">
              {/* 導入の形は保存前の選択(訪問者 ID の節)に合わせる。バッククォートの部分は <code> で出す */}
              {splitCode(cspNotice({ mode, edgeOrigin, tagOrigin, siteDomain: site.domain })).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
            </p>
          ) : null}
          {capacity ? (
            <p className={capacity.level === "stopped" ? "error-box" : "banner-warn"} style={{ display: "block" }} role="status" data-testid="results-capacity-warning" data-level={capacity.level}>
              {capacity.text}
              {site.resultsCapacity ? (
                <>
                  (<LocalTime at={site.resultsCapacity.measuredAt} kind="deadline" timeZone={site.timezone} /> に測定)
                </>
              ) : null}
            </p>
          ) : null}
          <Field label="参加者ごとの記録を残す日数(7〜365 日)" error={fields.resultsRetentionDays}>
            <input name="resultsRetentionDays" type="number" min={7} max={365} defaultValue={site.resultsRetentionDays} disabled={ro} required />
          </Field>
        </section>
        <section className={switched ? "card enter" : "card"} hidden={section !== "identity"}>
          <h2>{heading("identity")}</h2>
          <Field label="導入の形" group error={fields.mode}>
            <Picker
              label="導入の形"
              name="mode"
              value={mode}
              disabled={ro}
              options={[
                { value: "A", label: "A: JS Cookie" },
                { value: "B", label: "B: サーバー発行 Cookie(同じゾーンの Workers Route)" },
              ]}
              onChange={(v) => {
                setMode(v as "A" | "B");
                setDirty(true);
                clearField("mode");
              }}
            />
          </Field>
          {mode === "B" ? (
            <div className="banner-warn" style={{ display: "block" }}>
              <p>
                <strong>Mode B(サーバー発行 Cookie)の設置手順</strong>(インフラ作業。管理画面は設定値の保持までです)
              </p>
              <ol>
                <li>
                  対象ゾーンに Workers Route <code>&lt;hosts の各ホスト&gt;/__ab/*</code> → <code>wtt-edge</code> を追加する
                </li>
                <li>下の hosts に対象ホスト名を 1 行ずつ書く(小文字。IDN は punycode)</li>
                <li>
                  保存後、<code>curl -si -X POST https://&lt;host&gt;/__ab/decision -H 'content-type: application/json' -d '{"{"}"v":1,"url":"https://&lt;host&gt;/","referrer":"","device":"desktop"{"}"}'</code> で{" "}
                  <code>Set-Cookie</code> が返ることを確認する
                </li>
              </ol>
              <Field label="hosts(1 行 1 ホスト名)" error={fields.hosts}>
                <textarea name="hosts" defaultValue={site.hosts.join("\n")} disabled={ro} />
              </Field>
            </div>
          ) : (
            <input type="hidden" name="hosts" value="" />
          )}
          <Field label="訪問者 ID の取得元" group error={fields.idSource}>
            <Picker
              label="訪問者 ID の取得元"
              value={idSourceKind}
              disabled={ro || mode === "B"}
              options={[
                { value: "ab", label: "ab: ツールが発行する匿名 ID(Mode A)" },
                { value: "cookie", label: "cookie: サイトの既存 Cookie を流用(Mode C / BYOID)" },
              ]}
              onChange={(v) => {
                setIdSourceKind(v as "ab" | "cookie");
                setDirty(true);
                clearField("idSource"); // この Picker は name を持たない(送る値は送信時に組み立てる)ので、エラーのキーで消す
              }}
            />
          </Field>
          {idSourceKind === "cookie" ? (
            <>
              <Field
                label="参照する Cookie 名"
                hint="値は SHA-256(site_salt + 値) にハッシュしてから送られます。メールアドレス等の低エントロピー値は逆引きされ得るため使わないでください"
                error={fields.idSource}
              >
                <input name="byoidCookie" defaultValue={site.idSource.startsWith("cookie:") ? site.idSource.slice(7) : ""} disabled={ro} required />
              </Field>
              <p className="banner-warn" style={{ display: "block" }}>
                <strong>Mode C では同意の撤回で訪問者 ID は切れません。</strong> ツールが削除できるのは自分が発行した Cookie だけで、参照先の Cookie はサイトの資産です。再許可時には同じ派生 ID
                に戻ります。撤回で確実に訪問者 ID を切りたい場合は Mode A を使ってください
              </p>
            </>
          ) : (
            <input type="hidden" name="byoidCookie" value="" />
          )}
          <Field
            label="正本 Cookie 名"
            hint="変更すると全訪問者の ID が再発行され、割当がリセットされます。旧名は retentionDays の間、削除対象として記録され、その間は再利用できません"
            error={fields.visitorCookieName}
          >
            <input name="visitorCookieName" defaultValue={site.visitorCookieName} disabled={ro} required />
          </Field>
          <Field label="UUID Cookie(外部ツール連携用の別名。出力専用)" hint="訪問者 ID から導出した UUID(元の ID には戻せません)。BYOID の訪問者にも出します" error={fields.uuidCookieEnabled}>
            <span className="row">
              <input name="uuidCookieEnabled" type="checkbox" defaultChecked={site.uuidCookieEnabled} disabled={ro} /> 有効にする
            </span>
          </Field>
          <Field label="UUID Cookie 名" error={fields.uuidCookieName}>
            <input name="uuidCookieName" defaultValue={site.uuidCookieName} disabled={ro} required />
          </Field>
          {site.previousCookieNames.length > 0 ? (
            <p className="muted">
              削除対象の旧 Cookie 名:{" "}
              {site.previousCookieNames.map((p, i) => (
                <span key={p.name}>
                  {i > 0 ? ", " : null}
                  {p.name}(〜<LocalTime at={p.until * 1000} kind="date" />)
                </span>
              ))}
            </p>
          ) : null}
        </section>
        <section className={switched ? "card enter" : "card"} hidden={section !== "naming"}>
          <h2>{heading("naming")}</h2>
          <Field
            label="dataLayer の変数名"
            hint="タグが計測イベントを入れる配列の名前。GTM のスニペットで dataLayer の名前を変えている場合だけ、同じ名前にします(スニペットの 4 番目の引数で、既定は 'dataLayer'。gtm.js の URL の l= の値)。英字・_・$ で始まり、英数字と _ と $ だけの 64 字以内"
            error={analyticsError("dataLayerName")}
          >
            <input name="analytics.dataLayerName" defaultValue={site.analytics.dataLayerName ?? "dataLayer"} disabled={ro} required pattern="[A-Za-z_$][A-Za-z0-9_$]{0,63}" />
          </Field>
          <p className="muted">
            GA4 の規則: 英字始まり・英数字と _ のみ・40 字以内。_ / firebase_ / ga_ / google_ / gtag. 始まりと GA4 の予約イベント名は不可。7 つのキー名は互いに重複せず、露出と
            コンバージョンのイベント名は異なる必要があります。既定のまま使えます
          </p>
          {ANALYTICS_FIELDS.map((f) => (
            <Field key={f.path} label={f.label} error={analyticsError(f.path)}>
              <input name={`analytics.${f.path}`} defaultValue={f.get(site.analytics)} disabled={ro} required pattern="[A-Za-z][A-Za-z0-9_]{0,39}" />
            </Field>
          ))}
        </section>
        <section className={switched ? "card enter" : "card"} hidden={section !== "external"}>
          <h2>{heading("external")}</h2>
          <p className="muted">
            分析レシピ(`GET …/analytics-recipe`、分析ガイド 3 節)がこの 2 つを埋めて返します。資格情報ではありません。空 = 未設定(レシピはプレースホルダのまま返ります)
          </p>
          <Field label="ga4PropertyId(数値の GA4 プロパティ ID。G- で始まる測定 ID ではありません)" error={fields.ga4PropertyId}>
            <input name="ga4PropertyId" defaultValue={site.ga4PropertyId ?? ""} disabled={ro} pattern="\d{1,20}" placeholder="123456789" />
          </Field>
          <Field label="bigqueryDataset(<GCP プロジェクト ID>.<データセット名>)" error={fields.bigqueryDataset}>
            <input name="bigqueryDataset" defaultValue={site.bigqueryDataset ?? ""} disabled={ro} placeholder="my-project.analytics_123456789" />
          </Field>
        </section>
        {/* A10: 保存の結果はフォームに入る節でだけ出す(導入タグ・危険な操作は保存と関係がない) */}
        {inForm ? <ErrorBox message={error} /> : null}
        {inForm && saved ? <p className="banner-warn">保存しました。訪問者 ID と外部計測の名札は、設置タグの配信ファイルを作り直して反映します(公開は不要。訪問者のブラウザには 1 分ほどで届きます)</p> : null}
      </form>
      {section === "tag" ? (
        <div className={switched ? "enter" : undefined}>
          <InstallTag site={site} tagOrigin={tagOrigin} canAdmin={canAdmin} />
        </div>
      ) : null}
      {section === "danger" ? (
        <div className={switched ? "enter" : undefined}>
          <DangerZone site={site} canDelete={canDelete} />
        </div>
      ) : null}
      {/* A10: 保存の帯はフォームに入る節でだけ出す。未保存の入力は節を移っても残り、離脱の確認が守る */}
      {canAdmin && inForm ? (
        <SaveBar dirty={dirty}>
          <SubmitButton busy={busy} form="site-settings-form">保存</SubmitButton>
        </SaveBar>
      ) : null}
    </div>
  );
}
