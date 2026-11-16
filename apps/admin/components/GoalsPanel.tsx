"use client";
import { useHydrated } from "@/lib/use-hydrated";
import { Fragment, useState } from "react";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, fieldErrors } from "@/lib/client";
import type { AnalyticsSettings, Goal } from "@/lib/types";
import { analyticsValueErrors } from "@/lib/analytics-values";
import { conversionPreview } from "@/lib/datalayer-preview";
import { goalAnalyticsBody, goalNameOf } from "@/lib/goal-analytics";
import { goalSaveNotice } from "@/lib/test-locks";
import { Field } from "./Field";
import { PageMatchField } from "./PageMatchField";
import { DEFAULT_PAGE_MATCH, describePageMatch, type PageMatchValue } from "@/lib/page-match";
import { SubmitButton } from "./SubmitButton";
import { BusyScope, useBusyAction } from "./ui/BusyScope";
import { CardNotice, useBusyNotice } from "./ui/BusyNotice";
import { ErrorBox } from "./ErrorBox";
import { PageHeader } from "./ui/PageHeader";
import { Picker } from "./ui/Picker";
import { AnalyticsBadges, AnalyticsCard, AnalyticsSection, EXPOSED_NOTE, InfoTip } from "./experiment/AnalyticsCard";
import { DataLayerPreview } from "./experiment/DataLayerPreview";
import styles from "./GoalsPanel.module.css";

const GOAL_TYPES = [
  { value: "PAGEVIEW", label: "ページの表示(PAGEVIEW)" },
  { value: "CLICK", label: "クリック(CLICK)" },
  { value: "CUSTOM", label: "コードから送る(CUSTOM)" },
];

/** 目標名の欄の値の問題(保存の前の検査。保存済みと同じ値は見ない。空は「指定なし」なので見ない)。無ければ null */
function goalNameIssue(goalName: string, saved: Goal["analytics"]): string | null {
  return analyticsValueErrors({ overrides: { goalName } }, saved, ["analytics"])[0]?.message ?? null;
}

/** 目標名の入力 + 出力される内容(編集パネルと追加フォームで共通。K14 の注意は編集だけ) */
function GoalAnalyticsFields({
  names,
  goalId,
  goalName,
  note,
  error,
  disabled,
  onChange,
}: {
  names: AnalyticsSettings;
  goalId: string;
  goalName: string;
  /** 目標名の欄の下の注意(編集だけ) */
  note?: string;
  error?: string | null;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const k = names.conversion.keys;
  return (
    <div className={styles.split}>
      <AnalyticsSection
        title="目標名"
        tipLabel="目標名の補足"
        tip={
          <>
            <code>{k.goalName}</code> に出力します。空なら目標 ID{goalId ? `(${goalId})` : " "}を出力します。{EXPOSED_NOTE}
          </>
        }
      >
        <input
          aria-label="目標名"
          aria-invalid={error ? true : undefined}
          value={goalName}
          placeholder={goalId ? `空なら目標 ID(${goalId})を出力` : "空なら目標 ID を出力"}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? (
          <span role="alert" className="field-error">
            {error}
          </span>
        ) : null}
        {note ? <span className={styles.note}>{note}</span> : null}
      </AnalyticsSection>
      <AnalyticsSection output title="出力される内容" tipLabel="出力される内容の補足" tip="この目標を達成したときに dataLayer に送る内容です。キー名はサイト設定(外部計測の名前)の値です">
        <DataLayerPreview extraKey={names.extraKey} lines={conversionPreview(names, { goalId: goalId || "<目標 ID>", goalName })} />
      </AnalyticsSection>
    </div>
  );
}

/** 行の下に開く編集パネル。名前・ページ条件・目標名を下書きに持ち、「保存」で PATCH を 1 回だけ送る(送る内容の決め方は lib/goal-analytics) */
type GoalEditBody = { name: string; config?: Goal["config"]; analytics?: Goal["analytics"] };

function GoalEditPanel({
  goal,
  names,
  fields,
  onSave,
  onCancel,
  onEdit,
}: {
  goal: Goal;
  names: AnalyticsSettings;
  fields: Record<string, string>;
  onSave: (body: GoalEditBody) => void;
  onCancel: () => void;
  /** 欄を変えた(一覧のカードの成功の文を消す) */
  onEdit: () => void;
}) {
  const savedGoalName = goalNameOf(goal.analytics);
  const [name, setName] = useState(goal.name);
  const [goalName, setGoalName] = useState(savedGoalName);
  // 編集を開いた時点を比較の基準にする。一覧だけ更新されても、未編集の古い条件を送り戻さない。
  const [initialPage] = useState(() => goal.type === "PAGEVIEW" ? (goal.config as { page: PageMatchValue }).page : null);
  const [page, setPage] = useState(initialPage);
  const issue = goalNameIssue(goalName, goal.analytics);
  function save() {
    if (issue) return; // 問題のある値は送らない(欄に出ている)
    // 何も変えていなければ送らず閉じる(更新日時を進めない)
    const pageChanged = page !== null && JSON.stringify(page) !== JSON.stringify(initialPage);
    if (name === goal.name && goalName === savedGoalName && !pageChanged) return onCancel();
    onSave({ name, ...(pageChanged ? { config: { ...goal.config, page } } : {}), ...goalAnalyticsBody(goalName, goal.analytics) });
  }
  // 保存の間は一覧のカードの覆い(inert)で押せないので、欄・ボタンを無効にしない
  return (
    <div className={styles.panel}>
      <div className={styles.narrow}>
        <Field label="名前(100 字以内。管理画面の中だけで使います)" error={fields.name}>
          <input
            value={name}
            required
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              onEdit();
            }}
          />
        </Field>
      </div>
      {page !== null ? (
        <Field label="ページ" error={fields["config.page.value"] ?? fields["config.page.op"] ?? fields["config.page.part"] ?? fields["config.page"]}>
          <PageMatchField value={page} onChange={(next) => { setPage(next); onEdit(); }} />
        </Field>
      ) : null}
      <div className={styles.secHead}>
        <h3>外部計測(dataLayer 出力)</h3>
        <AnalyticsBadges count={goalName ? 1 : 0} countTitle="設定した項目の数" />
      </div>
      <GoalAnalyticsFields
        names={names}
        goalId={goal.id}
        goalName={goalName}
        note={`変更して公開すると、その時点から ${names.conversion.keys.goalName} の値が変わります。集計は ${names.conversion.keys.goalId} で行ってください`}
        error={issue ?? fields["analytics.overrides.goalName"]}
        disabled={false}
        onChange={(v) => {
          setGoalName(v);
          onEdit();
        }}
      />
      <div className={styles.foot}>
        <button type="button" className="btn" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="btn btn-primary" onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}

/**
 * 目標の画面(B173 第 2 段 Task 6)。一覧のカード(編集のパネル・削除)と追加のフォームのカードを別々の範囲(BusyScope)で覆う。
 * 別々の範囲なので、一覧の保存の間も追加は押せる。結果の文・欄のエラーも範囲ごとに持つ(追加の失敗を一覧の先頭に出さない)
 */
export function GoalsPanel({ siteId, goals, canEdit, names }: { siteId: string; goals: Goal[]; canEdit: boolean; names: AnalyticsSettings }) {
  const k = names.conversion.keys;
  return (
    <div>
      <PageHeader title="目標" />
      <p className="muted">
        目標はサイト単位です。達成するたびに <code>dataLayer</code> に <code>ab_conversion</code> が送られ、GTM から GA4 に送ると、エクスペリエンスのパターンごとに CV を比べられます。配信条件の「目標を達成した人」にも使えます。
        ページの表示は指定したページの読み込みごと、クリックはセレクタに一致する要素のクリックごとに達成になります(重複は除きません)。
        履歴条件(converted)を使うサイトでは <code>/event</code> にも転送され、訪問者プロフィールに達成回数が記録されます。名前は管理画面の中だけで使い、訪問者には届きません。<code>{k.goalName}</code> に出す名前は外部計測で指定します(指定しなければ目標 ID)
      </p>
      <BusyScope id="goals-list">
        <GoalsList siteId={siteId} goals={goals} canEdit={canEdit} names={names} />
      </BusyScope>
      {canEdit ? (
        <BusyScope id="goal-add">
          <GoalAddForm siteId={siteId} names={names} />
        </BusyScope>
      ) : null}
    </div>
  );
}

/** 一覧のカード。保存・削除の結果はカードの先頭に 1 行で出す(消えた行の中には出さない) */
function GoalsList({ siteId, goals, canEdit, names }: { siteId: string; goals: Goal[]; canEdit: boolean; names: AnalyticsSettings }) {
  // 確認は範囲の中で開く(確認の持ち主をこの範囲にする)
  const ask = useConfirm();
  const { run } = useBusyAction();
  const { notice, show, clear, clearStatus } = useBusyNotice();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null); // 編集パネルを開いている目標

  async function remove(g: Goal) {
    clear();
    const outcome = await run({
      label: "削除中…",
      // 押した瞬間に消えるので確認する(B45)。配信条件などから参照されている目標は control が 409 で断る
      confirm: () => ask({ title: `目標「${g.name}」を削除しますか?`, body: "元に戻せません", confirmLabel: "削除する" }),
      write: (signal) => api("DELETE", `/sites/${siteId}/goals/${g.id}`, undefined, { signal }),
      after: "refresh",
    });
    show(outcome, "削除しました");
  }

  async function save(g: Goal, body: GoalEditBody) {
    clear();
    setFields({});
    // D9 ③(設計書 §5.5、B77 の K14): 実行中・一時停止中のテストが使っている目標は、件数を添えて確認する(目標名の変更も対象)
    const lockNotice = goalSaveNotice(g.runningTests ?? []);
    const outcome = await run({
      label: "保存中…",
      confirm: lockNotice ? () => ask({ title: `目標「${g.name}」を保存しますか?`, body: lockNotice, confirmLabel: "保存する", tone: "primary" }) : undefined,
      // 名前・ページ条件・外部計測を 1 回の PATCH で送る
      write: (signal) => api("PATCH", `/sites/${siteId}/goals/${g.id}`, body, { signal }),
      after: "refresh",
    });
    // 成功したら(読み直しを待ち切れなかったときも、書き込みは通っている)パネルを閉じる。失敗なら開いたまま欄にエラーを出す
    if (outcome.kind === "saved") setOpenId(null);
    else if (outcome.kind === "failed") setFields(fieldErrors(outcome.error));
    show(outcome, "保存しました");
  }

  return (
    <div className="card-flush has-menu" data-testid="goals-list">
      <CardNotice notice={notice} />
      <table className={styles.table}>
        <thead>
          <tr>
            <th>ID</th>
            <th>名前</th>
            <th>種類</th>
            <th>設定</th>
            <th>外部計測</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {goals.map((g) => {
            const isOpen = canEdit && openId === g.id;
            const goalName = goalNameOf(g.analytics);
            return (
              <Fragment key={g.id}>
                <tr className={isOpen ? styles.open : undefined}>
                  <td>
                    <code>{g.id}</code>
                  </td>
                  <td>{g.name}</td>
                  <td>{GOAL_TYPES.find((t) => t.value === g.type)?.label ?? g.type}</td>
                  <td>{g.type === "PAGEVIEW" ? describePageMatch((g.config as { page: PageMatchValue }).page) : <code>{JSON.stringify(g.config)}</code>}</td>
                  <td>
                    {goalName ? (
                      // 長い名前は 220px で切り、全文は title(K15)
                      <span className={`badge ${styles.nameBadge}`} title={`目標名: ${goalName}`} data-testid="goal-name-badge">
                        目標名 {goalName}
                      </span>
                    ) : (
                      <span className={styles.none}>指定なし(ID を出力)</span>
                    )}
                  </td>
                  <td>
                    {canEdit ? (
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={isOpen ? `btn ${styles.on}` : "btn"}
                          aria-expanded={isOpen}
                          onClick={() => {
                            setFields({});
                            setOpenId(isOpen ? null : g.id);
                          }}
                        >
                          {isOpen ? "編集 ▴" : "編集 ▾"}
                        </button>
                        <button className="btn" onClick={() => void remove(g)}>
                          削除
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
                {isOpen ? (
                  <tr className={styles.open}>
                    <td className={styles.panelCell} colSpan={6}>
                      <GoalEditPanel goal={g} names={names} fields={fields} onCancel={() => setOpenId(null)} onEdit={clearStatus} onSave={(body) => void save(g, body)} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 追加のフォームのカード。結果は追加のボタンの横(失敗はボタンのすぐ上)に出す */
function GoalAddForm({ siteId, names }: { siteId: string; names: AnalyticsSettings }) {
  const hydrated = useHydrated();
  const { run } = useBusyAction();
  const { notice, show, clear, clearStatus } = useBusyNotice();
  const [type, setType] = useState<Goal["type"]>("PAGEVIEW");
  const [goalId, setGoalId] = useState(""); // CUSTOM の送り方の例に入れる
  const [page, setPage] = useState<PageMatchValue>(DEFAULT_PAGE_MATCH);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [addGoalName, setAddGoalName] = useState("");
  const [addOpen, setAddOpen] = useState(false); // 追加フォームの外部計測(畳んだ状態から開く)
  const k = names.conversion.keys;
  const addIssue = goalNameIssue(addGoalName, null);

  async function add(form: HTMLFormElement) {
    const fd = new FormData(form);
    const config = type === "PAGEVIEW" ? { page } : type === "CLICK" ? { selector: fd.get("selector") } : {};
    clear();
    setFields({});
    if (addIssue) return setAddOpen(true); // 目標名に問題があれば送らない(欄にエラーが出ている。畳んでいたら開く)
    const body = { id: fd.get("id"), name: fd.get("name"), type, config, ...goalAnalyticsBody(addGoalName, null) };
    const outcome = await run({
      label: "追加中…",
      write: (signal) => api("POST", `/sites/${siteId}/goals`, body, { signal }),
      // 入力は書き込みの成功の直後に空へ戻す(読み直しを待ち切れなかったときも、追加は通っている)
      onWritten: () => {
        form.reset();
        setGoalId("");
        setPage(DEFAULT_PAGE_MATCH);
        setAddGoalName("");
      },
      after: "refresh",
    });
    if (outcome.kind === "failed") setFields(fieldErrors(outcome.error));
    show(outcome, "追加しました");
  }

  return (
    <form method="post"
      className="card"
      data-testid="goal-add"
      onChange={clearStatus}
      onKeyDown={(e) => {
        // ページの値を入力した直後の Enter では追加しない。一致の仕方へは標準の Tab で進む。
        // Picker 自身の Enter と、日本語入力の確定には干渉しない。
        if (e.key === "Enter" && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement && e.target.name === "value") e.preventDefault();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void add(e.currentTarget);
      }}
    >
      <h2>追加</h2>
      <div className={`field ${styles.narrow}`}>
        {/* ⓘ は label の外に置く(label の中のボタンは入力欄への紐づけを奪う) */}
        <span className={styles.labelRow}>
          <label htmlFor="goal-add-id" className="field-label">
            ID(スラッグ)
          </label>
          <InfoTip label="ID の補足">
            作成後は変えられません。<code>{k.goalId}</code> に出力します。{EXPOSED_NOTE}
          </InfoTip>
        </span>
        <input id="goal-add-id" name="id" required pattern="[a-z0-9][a-z0-9_\-]{0,63}" placeholder="g_purchase" onChange={(e) => setGoalId(e.target.value)} />
        {fields.id ? (
          <span role="alert" className="field-error">
            {fields.id}
          </span>
        ) : null}
      </div>
      <div className={styles.narrow}>
        <Field label="名前(100 字以内。管理画面の中だけで使います)" error={fields.name}>
          <input name="name" required maxLength={100} />
        </Field>
      </div>
      <Field label="種類" group error={fields.type}>
        {/* Picker・PageMatchField はボタンで値を変えるので、フォームの onChange に届かない。各部品の変更でも成功の文を消す(最終レビュー M2) */}
        <Picker
          label="種類"
          value={type}
          options={GOAL_TYPES}
          onChange={(v) => {
            setType(v as Goal["type"]);
            clearStatus();
          }}
        />
      </Field>
      {type === "PAGEVIEW" ? (
        <Field label="ページ" error={fields["config.page.value"] ?? fields["config.page.op"] ?? fields["config.page.part"]}>
          <PageMatchField
            value={page}
            onChange={(v) => {
              setPage(v);
              clearStatus();
            }}
          />
        </Field>
      ) : null}
      {type === "CUSTOM" ? (
        <p className="muted" data-testid="custom-goal-hint">
          ページの表示やクリックでは捉えられない達成(フォームの送信の成功・動画の再生完了など)に使います。ツールは自動では検知しません。達成した瞬間に、サイトのコードか GTM のカスタム HTML のタグで{" "}
          <code>window.AB &amp;&amp; window.AB.track(&quot;{goalId || "<この目標の ID>"}&quot;)</code> を実行してください
        </p>
      ) : null}
      {type === "CLICK" ? (
        <Field label="セレクタ" error={fields["config.selector"]}>
          <input name="selector" required placeholder="a.cta" />
        </Field>
      ) : null}
      <AnalyticsCard
        bare
        title="外部計測(dataLayer 出力)"
        badge={<AnalyticsBadges count={addGoalName ? 1 : 0} countTitle="設定した項目の数" />}
        open={addOpen}
        onOpenChange={setAddOpen}
      >
        <GoalAnalyticsFields
          names={names}
          goalId={goalId}
          goalName={addGoalName}
          error={addIssue ?? fields["analytics.overrides.goalName"]}
          disabled={false}
          onChange={(v) => {
            setAddGoalName(v);
            clearStatus();
          }}
        />
      </AnalyticsCard>
      {/* 失敗はボタンのすぐ上、成功はボタンの横 */}
      <ErrorBox message={notice.error} />
      <div className="row" data-testid="goal-add-actions">
        <SubmitButton busy={false} disabled={!hydrated}>追加</SubmitButton>
        {notice.status ? <span role="status">{notice.status}</span> : null}
      </div>
    </form>
  );
}
