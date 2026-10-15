"use client";
import type { ReactNode } from "react";
import { groupText, type Names } from "@/lib/conditions";
import { AUDIENCE_NEST_MAX, findNode, findParent, moveNode, moveTargets, removeNode, reorder, type Group } from "@/lib/targeting-tree";
import { Picker } from "../ui/Picker";
import { ConditionRow, type RowCtx } from "../targeting/ConditionRow";
import { DraggableRow, DropZone } from "../targeting/Dnd";
import t from "../targeting/Targeting.module.css";
import styles from "./Audience.module.css";

/** 作成画面の木の操作(AudienceBuilder が持つ)。update は複製に当て、入れ子の上限を超えたら取り消して知らせる */
export type BuilderApi = { root: Group; ctx: RowCtx; alt: boolean; target: string; names: Names; setTarget: (id: string) => void; update: (mutate: (copy: Group) => void) => void };
const LOGIC = [
  { value: "and", label: "すべて満たす" },
  { value: "or", label: "いずれかを満たす" },
];

/** アクセシビリティ設定がオンのときの代わりの手段: ↑↓(並べ替え)と「移動先」(グループの間の移動。設計書 §12) */
function A11yControls({ api, id, index, count }: { api: BuilderApi; id: string; index: number; count: number }) {
  if (!api.alt || api.ctx.disabled) return null;
  const targets = moveTargets(api.root, id, (g, level) => (level === 0 ? "一番外側" : `入れ子 ${level}: ${g.children.length > 0 ? groupText(g, api.names).slice(0, 24) : "(空のグループ)"}`));
  const shift = (delta: -1 | 2) =>
    api.update((c) => {
      const p = findParent(c, id)!;
      p.parent.children = reorder(p.parent.children, p.index, p.index + delta);
    });
  return (
    <>
      <button type="button" className={t.iconButton} aria-label="上へ" disabled={index === 0} onClick={() => shift(-1)}>
        ↑
      </button>
      <button type="button" className={t.iconButton} aria-label="下へ" disabled={index === count - 1} onClick={() => shift(2)}>
        ↓
      </button>
      {targets.length > 0 ? (
        <Picker label="移動先" value={null} placeholder="移動先" options={targets.map((x) => ({ value: x.id, label: x.label }))} onChange={(gid) => api.update((c) => moveNode(c, id, gid))} />
      ) : null}
    </>
  );
}

/**
 * グループ(設計書 §12): すべて満たす / いずれかを満たす・除外する・縮める(見出しに要約)・ドラッグで移動・入れ子の段数の表示。
 * 一番外側(depth 0)は除外・縮める・削除・移動を持たない
 */
export function GroupView({ group, depth, api, handle }: { group: Group; depth: number; api: BuilderApi; handle?: ReactNode }) {
  const isRoot = depth === 0;
  const d = api.ctx.disabled;
  const pos = isRoot ? null : findParent(api.root, group.id);
  const set = (mutate: (g: Group) => void) => api.update((c) => mutate(findNode(c, group.id) as Group));
  const isTarget = api.alt && api.target === group.id;
  return (
    <div className={`${styles.group} ${depth % 2 ? styles.odd : ""} ${group.exclude ? styles.excluded : ""} ${isTarget ? styles.isTarget : ""}`} data-testid={isRoot ? "audience-root" : "audience-group"}>
      <div className={styles.groupHead}>
        {isRoot ? null : (
          <button type="button" className={t.iconButton} aria-expanded={!group.collapsed} aria-label={group.collapsed ? "グループを開く" : "グループを縮める"} onClick={() => set((g) => void (g.collapsed = !g.collapsed))}>
            {group.collapsed ? "▸" : "▾"}
          </button>
        )}
        {handle}
        {isRoot ? <strong>次の条件を</strong> : <span className="muted">グループ</span>}
        <Picker label={isRoot ? "一番外側のつなぎ方" : "グループのつなぎ方"} value={group.logic} disabled={d} options={LOGIC} onChange={(v) => set((g) => void (g.logic = v as "and" | "or"))} />
        {isRoot ? <span>訪問者</span> : <span className="muted">入れ子 {depth} / {AUDIENCE_NEST_MAX}</span>}
        {group.copiedFrom ? <span className="muted">「{group.copiedFrom}」から取り込み(コピー)</span> : null}
        {isRoot ? null : (
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={group.exclude} disabled={d} onChange={(e) => set((g) => void (g.exclude = e.target.checked))} />
            除外する
          </label>
        )}
        {group.exclude ? <span className="badge">当てはまる訪問者を除く</span> : null}
        <span style={{ marginLeft: "auto" }} />
        {api.alt && !d && !group.collapsed ? (
          isTarget ? (
            <span className="badge">追加先</span>
          ) : (
            <button type="button" className="btn" onClick={() => api.setTarget(group.id)}>
              ここに追加
            </button>
          )
        ) : null}
        {pos ? <A11yControls api={api} id={group.id} index={pos.index} count={pos.parent.children.length} /> : null}
        {isRoot || d ? null : (
          <button type="button" className={t.iconButton} aria-label="グループを削除" onClick={() => api.update((c) => removeNode(c, group.id))}>
            ×
          </button>
        )}
        {group.collapsed ? <span className={styles.collapsedSummary}>{groupText(group, api.names) || "(条件なし)"}</span> : null}
      </div>
      {group.collapsed ? null : (
        <div className={styles.groupBody}>
          {group.children.map((child, i) => (
            <div key={child.id}>
              {i > 0 ? <div className={`${t.joiner} ${group.logic === "or" ? t.joinerOr : ""}`}>{group.logic === "and" ? "かつ" : "または"}</div> : null}
              <DraggableRow nodeId={child.id}>
                {(h) =>
                  child.kind === "group" ? (
                    <GroupView group={child} depth={depth + 1} api={api} handle={d ? undefined : h} />
                  ) : (
                    <ConditionRow
                      cond={child}
                      ctx={api.ctx}
                      handle={d ? undefined : h}
                      onChange={(nc) =>
                        api.update((c) => {
                          const p = findParent(c, child.id)!;
                          p.parent.children[p.index] = nc;
                        })
                      }
                      onRemove={() => api.update((c) => removeNode(c, child.id))}
                      extra={<A11yControls api={api} id={child.id} index={i} count={group.children.length} />}
                    />
                  )
                }
              </DraggableRow>
            </div>
          ))}
          {/* グループの末尾の置き場所。空のグループでは案内の文の全体を置き場所にする(当たり判定は一番内側を選ぶので、グループの箱より優先される) */}
          <DropZone id={`into:${group.id}`} className={styles.dropEnd}>
            {group.children.length === 0 ? (
              <div className={styles.emptyDrop}>{api.alt ? "左の部品をここへドラッグするか、「ここに追加」を押してから部品をクリック" : "左の部品をここへドラッグ(部品をクリックすると一番外側に入ります)"}</div>
            ) : null}
          </DropZone>
        </div>
      )}
    </div>
  );
}
