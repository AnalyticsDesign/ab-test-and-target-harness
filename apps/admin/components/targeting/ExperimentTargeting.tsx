"use client";
import { useId } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { useDragAlternatives } from "@/lib/a11y";
import { defaultCond, dslHasHistory, groupText, makeNames, usesHistory } from "@/lib/conditions";
import type { TargetingDraft } from "@/lib/experiment-draft";
import { experimentFormToDsl, reorder, type Cond, type ExperimentForm } from "@/lib/targeting-tree";
import { DragAltHint } from "../DragAltHint";
import { Picker } from "../ui/Picker";
import { ConditionRow, type RowCtx } from "./ConditionRow";
import { DND_ACCESSIBILITY, DraggableRow, DropZone, nestedCollision, useDragSensors } from "./Dnd";
import styles from "./Targeting.module.css";

const END = "end:rows";

/**
 * エクスペリエンスの配信条件(決定 49、設計書 §12): 「次の条件を [すべて満たす / いずれかを満たす] 訪問者に配信」+ 条件の行(1 段)+ 要約 + 保存される JSON。
 * 入れ子や除外はオーディエンスで作る。行はドラッグで並べ替え、アクセシビリティ設定がオンなら ↑↓ でも並べ替えられる。
 * 画面で表せない保存値は JSON を読み取り専用で見せる(保存では送らない。plan ② P16)
 */
export function ExperimentTargeting({ value, onChange, ctx }: { value: TargetingDraft; onChange: (v: TargetingDraft) => void; ctx: Omit<RowCtx, "allowAudience"> }) {
  const dndId = useId();
  const sensors = useDragSensors();
  const alt = useDragAlternatives();
  if (value.kind === "raw")
    return (
      <div className={styles.raw} role="note">
        この配信条件はこの画面で表せません(入れ子や古い書式を含みます)。画面からは変更できないので、API で書き換えてください。ほかの欄は保存できます。
        <pre className={styles.json}>{JSON.stringify(value.json, null, 2)}</pre>
      </div>
    );
  const form = value.form;
  const rowCtx: RowCtx = { ...ctx, allowAudience: true };
  const set = (next: ExperimentForm) => onChange({ kind: "form", form: next });
  const setRows = (rows: Cond[]) => set({ ...form, rows });
  const names = makeNames(ctx.goals, ctx.audiences);
  const history = form.rows.some((r) => usesHistory(r, (id) => dslHasHistory(ctx.audiences.find((a) => a.id === id)?.definition)));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const from = form.rows.findIndex((r) => `node:${r.id}` === active.id);
    const to = over.id === END ? form.rows.length : form.rows.findIndex((r) => `before:${r.id}` === over.id);
    if (from < 0 || to < 0 || from === to) return;
    setRows(reorder(form.rows, from, to));
  };
  const add = (type: "audience" | "path") => setRows([...form.rows, defaultCond(type, { goal: ctx.goals[0]?.id, audience: ctx.audiences[0]?.id })]);
  const dsl = experimentFormToDsl(form);
  return (
    <div>
      <div className={styles.targetingHead}>
        <span className="muted">次の条件を</span>
        <Picker label="条件のつなぎ方" value={form.logic} disabled={ctx.disabled} options={[{ value: "and", label: "すべて満たす" }, { value: "or", label: "いずれかを満たす" }]} onChange={(v) => set({ ...form, logic: v as "and" | "or" })} />
        <span className="muted">訪問者に配信</span>
        {history ? <span className={styles.histTag}>履歴を使う</span> : null}
      </div>
      <DndContext id={dndId} sensors={sensors} collisionDetection={nestedCollision} accessibility={DND_ACCESSIBILITY} onDragEnd={onDragEnd}>
        {form.rows.map((row, i) => (
          <div key={row.id}>
            {i > 0 ? <div className={`${styles.joiner} ${form.logic === "or" ? styles.joinerOr : ""}`}>{form.logic === "and" ? "かつ" : "または"}</div> : null}
            <DraggableRow nodeId={row.id}>
              {(handle) => (
                <ConditionRow
                  cond={row}
                  ctx={rowCtx}
                  handle={ctx.disabled ? undefined : handle}
                  onChange={(c) => setRows(form.rows.map((r) => (r.id === row.id ? c : r)))}
                  onRemove={() => setRows(form.rows.filter((r) => r.id !== row.id))}
                  extra={
                    alt && !ctx.disabled ? (
                      <>
                        <button type="button" className={styles.iconButton} aria-label="上へ" disabled={i === 0} onClick={() => setRows(reorder(form.rows, i, i - 1))}>
                          ↑
                        </button>
                        <button type="button" className={styles.iconButton} aria-label="下へ" disabled={i === form.rows.length - 1} onClick={() => setRows(reorder(form.rows, i, i + 2))}>
                          ↓
                        </button>
                      </>
                    ) : null
                  }
                />
              )}
            </DraggableRow>
          </div>
        ))}
        <DropZone id={END} className={styles.endZone} />
      </DndContext>
      {form.rows.length === 0 ? <p className="muted">条件がありません。このエクスペリエンスは対象 URL のページを開いた全員に配信されます</p> : null}
      {ctx.disabled ? null : (
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn" onClick={() => add("audience")}>
            + オーディエンス
          </button>
          <button type="button" className="btn" onClick={() => add("path")}>
            + 条件
          </button>
          <span className="muted">ページの条件は、対象 URL に一致したページの中をさらに絞るときに使います(両方を満たすときだけ配信)。入れ子や除外が要るときはオーディエンスで作ります</span>
        </div>
      )}
      {ctx.disabled ? null : <DragAltHint />}
      <p className={styles.deliver}>
        <span className="muted">配信する訪問者: </span>
        <span data-testid="targeting-summary">{groupText({ id: "root", kind: "group", logic: form.logic, exclude: false, collapsed: false, children: form.rows }, names, true)}</span>
      </p>
      <details>
        <summary>保存される JSON(エージェント・API と同じ形)</summary>
        <pre className={styles.json} data-testid="targeting-json">{dsl === null ? "null(全員)" : JSON.stringify(dsl, null, 2)}</pre>
      </details>
    </div>
  );
}
