"use client";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { api as call, describeError } from "@/lib/client";
import { useDragAlternatives } from "@/lib/a11y";
import { audienceMatches } from "@/lib/audience-filter";
import { audienceIdCandidate, audienceIdProblem } from "@/lib/audience-id";
import { audienceSaveNotice } from "@/lib/test-locks";
import { COND_META, PAGE_TYPES, VISITOR_TYPES, defaultCond, groupText, makeNames, summarizeDsl, treeProblem } from "@/lib/conditions";
import {
  AUDIENCE_NEST_MAX, audienceTreeFromDsl, cloneFresh, definitionBody, edit, findNode, findParent, insertNode, levelOf, moveNode, nestLevels, newId, toDsl,
  type CondType, type Group,
} from "@/lib/targeting-tree";
import type { Audience, Goal, Site } from "@/lib/types";
import { useConfirm } from "../ConfirmProvider";
import { DragAltHint } from "../DragAltHint";
import { ErrorBox } from "../ErrorBox";
import { PageHeader } from "../ui/PageHeader";
import { SaveBar } from "../ui/SaveBar";
import type { RowCtx } from "../targeting/ConditionRow";
import { DND_ACCESSIBILITY, DraggableChip, nestedCollision, useDragSensors } from "../targeting/Dnd";
import t from "../targeting/Targeting.module.css";
import { GroupView, type BuilderApi } from "./GroupView";
import styles from "./Audience.module.css";
import { navigateApp } from "@/lib/navigate";

type Props = { wid: string; siteId: string; audience: Audience | null; audiences: Audience[]; goals: Goal[]; site: Pick<Site, "retentionDays" | "timezone">; canEdit: boolean };

const newGroup = (): Group => ({ id: newId(), kind: "group", logic: "and", exclude: false, collapsed: false, children: [] });
const LIMIT = `グループの入れ子は、一番外側の中に ${AUDIENCE_NEST_MAX} 段までです。これより深くする操作は取り消しました`;
/** 「既存のオーディエンスから取り込む」に一度に出す件数(B59)。それより多いときは検索で絞ってもらう */
const IMPORT_SHOWN = 10;

/**
 * オーディエンスの作成・編集画面(決定 49、設計書 §12): 左 = 条件の部品(このページ / この訪問者 / 組み立て / 既存のオーディエンスから取り込む)、
 * 中央 = 条件の木、右 = 要約・使用中のエクスペリエンス・保存される JSON、下 = 保存の帯(B58。保存は帯の 1 か所だけ、成功は帯の文字で知らせる)。
 * 部品はドラッグで置き、クリックすると一番外側の末尾に入る(アクセシビリティ設定がオンなら「ここに追加」で選んだグループ)。
 * 取り込みはその時点の定義のコピー(元を変えても連動しない。設計書 §5.5)。知らせはトーストを使わず、押した場所の近くに出す(決まり U3)
 */
export function AudienceBuilder({ wid, siteId, audience, audiences, goals, site, canEdit }: Props) {
  const router = useRouter();
  const ask = useConfirm();
  const alt = useDragAlternatives();
  const sensors = useDragSensors();
  const dndId = useId();
  // 保存値は unknown のまま渡す。core の検査を通らない値・変換できない値は null(= 読み取り専用。plan ② P16)
  const initial = audienceTreeFromDsl(audience ? audience.definition : null);
  const raw = initial === null; // 画面で表せない定義(plan ② P16)。名前とメモだけ保存できる
  const [root, setRoot] = useState<Group>(() => initial ?? audienceTreeFromDsl(null)!);
  const [name, setName] = useState(audience?.name ?? "");
  const [description, setDescription] = useState(audience?.description ?? "");
  const [manualId, setManualId] = useState<string | null>(null);
  const [randomPart] = useState(() => Math.random().toString(36).slice(2, 8));
  const [targetId, setTargetId] = useState(root.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 知らせ(B58): 取り込みの完了は取り込みの節に、木を変えられなかった理由は条件の木の上に、保存の成功は保存の帯に出す。
  // seq は同じ文が続いたときも読み上げ直すため(要素を作り直す key に使う)
  const [importNotice, setImportNotice] = useState<{ text: string; seq: number } | null>(null);
  const [treeError, setTreeError] = useState<{ text: string; seq: number } | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [importQuery, setImportQuery] = useState("");
  // 保存済みの値(B58)。最初は props、保存の後は PATCH の応答(control が正規化した値)。refresh を待たずに未保存の判定と破棄の戻り先になる
  const [saved, setSaved] = useState(() => ({ name: audience?.name ?? "", description: audience?.description ?? "", definition: audience ? audience.definition : null }));

  const taken = audiences.map((a) => a.id);
  // 新規の ID は名前から候補を作る(手で直したら追わない)。名前が空の間は出さない(サーバーとブラウザで乱数が食い違わないように)
  const id = audience ? audience.id : (manualId ?? (name.trim() ? audienceIdCandidate(name, taken, () => randomPart) : ""));
  const target = findNode(root, targetId)?.kind === "group" ? targetId : root.id;
  const clickTarget = alt ? target : root.id;
  const ctx: RowCtx = { goals, goalsHref: `/w/${wid}/sites/${siteId}/goals`, audiences, retentionDays: site.retentionDays, timezone: site.timezone, allowAudience: false, disabled: !canEdit || busy };
  const names = makeNames(goals, audiences);
  // 未保存の変更(B58): 保存済みの値(saved)と今の値を、保存される形(名前・メモ・DSL。新規の画面では手で直した ID も)で比べる。
  // 保存済みの側も同じ変換(audienceTreeFromDsl → toDsl)を通すので、触っていなければ一致する(開閉・ノードの id は DSL に出ない)
  const dslOf = (tree: Group | null) => (raw || tree === null ? null : toDsl(tree));
  const savedKey = JSON.stringify([saved.name, saved.description, dslOf(audienceTreeFromDsl(saved.definition) ?? audienceTreeFromDsl(null)), null]);
  const draftKey = JSON.stringify([name, description, dslOf(root), audience ? null : manualId]);
  const dirty = savedKey !== draftKey;
  const seqRef = useRef(0);
  const seq = () => (seqRef.current += 1);
  const showTreeError = (text: string) => setTreeError({ text, seq: seq() });
  // 何かを変えたら、前の保存の成功と取り込みの知らせは消す(古い知らせを残さない)
  const touched = () => {
    setSavedMessage(null);
    setImportNotice(null);
  };
  const update = (mutate: (copy: Group) => void): boolean => {
    const next = edit(root, mutate);
    if (next === null) {
      showTreeError(LIMIT);
      return false;
    }
    setTreeError(null);
    // グループの開閉のように保存される中身が変わらない操作では、知らせを消さない
    if (JSON.stringify(dslOf(next)) !== JSON.stringify(dslOf(root))) touched();
    setRoot(next);
    return true;
  };
  const builder: BuilderApi = { root, ctx, alt, target, names, setTarget: setTargetId, update: (m) => void update(m) };

  const addAt = (kind: string, groupId: string, index?: number) =>
    update((c) => insertNode(c, groupId, kind === "group" ? newGroup() : defaultCond(kind as CondType, { goal: goals[0]?.id }), index));
  const importAt = (audId: string, groupId: string, index?: number) => {
    const a = audiences.find((x) => x.id === audId);
    const tree = a ? audienceTreeFromDsl(a.definition) : null;
    if (!a || !tree) return;
    const copy = { ...(cloneFresh(tree) as Group), copiedFrom: a.name };
    const next = edit(root, (c) => insertNode(c, groupId, copy, index));
    if (next === null) return showTreeError(`「${a.name}」を取り込むと、グループの入れ子が上限の ${AUDIENCE_NEST_MAX} 段を超えます。浅い位置(一番外側など)に取り込んでください`);
    setTreeError(null);
    touched();
    setRoot(next);
    setImportNotice({ text: `「${a.name}」の条件をコピーして取り込みました。元のオーディエンスを後で変えても、ここには反映されません`, seq: seq() });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || ctx.disabled) return;
    const a = String(active.id);
    const o = String(over.id);
    let place: { group: string; index?: number } | null = null;
    if (o.startsWith("into:")) place = { group: o.slice(5) };
    else if (o.startsWith("before:")) {
      const p = findParent(root, o.slice(7));
      if (p) place = { group: p.parent.id, index: p.index };
    }
    if (!place) return;
    if (a.startsWith("rail:")) addAt(a.slice(5), place.group, place.index);
    else if (a.startsWith("aud:")) importAt(a.slice(4), place.group, place.index);
    else if (a.startsWith("node:")) update((c) => moveNode(c, a.slice(5), place!.group, place!.index));
  };

  // D9 ③(設計書 §5.5): 実行中・一時停止中のエクスペリエンスが使っていれば、件数を添えて確認する(テストでは結果に記録される)
  const saveNotice = audienceSaveNotice(audience?.usedBy ?? []);
  // 破棄(B58): 保存済みの値に戻す(新規なら空に戻し、手で直した ID も戻す)
  function discard() {
    const fresh = audienceTreeFromDsl(saved.definition) ?? audienceTreeFromDsl(null)!;
    setRoot(fresh);
    setTargetId(fresh.id);
    setName(saved.name);
    setDescription(saved.description);
    setManualId(null);
    setError(null);
    setTreeError(null);
    touched();
  }
  async function save() {
    setError(null);
    const definition = raw ? undefined : toDsl(root);
    if (!name.trim()) return setError("名前を入力してください");
    const idProblem = audience ? null : audienceIdProblem(id); // 新規作成の画面と重なる ID(plan ② P19)
    if (idProblem) return setError(idProblem);
    if (!raw && definition === null) return setError("条件を 1 つ以上入れてください");
    const problem = raw ? null : treeProblem(root.children, site.retentionDays);
    if (problem) return setError(problem);
    // 実行中・一時停止中のエクスペリエンスが参照しているときは確認を挟む(設計書 §5.3、D9 ③ の §5.5)。確認のモーダル(決まり 2.5。取り消せる操作なので主ボタンの色)
    if (audience && saveNotice !== null && !(await ask({ title: "オーディエンスを保存しますか?", body: saveNotice, confirmLabel: "保存する", tone: "primary" }))) return;
    setBusy(true);
    try {
      if (audience) {
        const updated = await call<Audience>("PATCH", `/sites/${siteId}/audiences/${audience.id}`, { name, description, ...definitionBody(raw ? null : root) }); // raw なら definition を送らない
        // 応答(control が正規化した値。ホストの小文字・パスの percent-encoding など)を保存済みの値にし、画面の値もそれにそろえる。
        // props(refresh)を待たずに「未保存の変更あり」が消え、正規化で値が変わっても未保存のまま残らない
        setSaved({ name: updated.name, description: updated.description ?? "", definition: updated.definition });
        setName(updated.name);
        setDescription(updated.description ?? "");
        const tree = raw ? null : audienceTreeFromDsl(updated.definition);
        if (tree) {
          setRoot(tree);
          setTargetId(tree.id);
        }
        setSavedMessage("保存しました。次の公開で反映されます");
        router.refresh(); // 使っているエクスペリエンスの一覧などを読み直す
      } else {
        await call("POST", `/sites/${siteId}/audiences`, { id, name, description, definition });
        navigateApp(router, `/w/${wid}/sites/${siteId}/audiences/${id}`);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const groupDisabled = levelOf(root, clickTarget) >= AUDIENCE_NEST_MAX;
  const copyable = audiences.filter((a) => a.id !== audience?.id && audienceTreeFromDsl(a.definition) !== null);
  // B59: 取り込みの一覧は、一覧の画面と同じ規則で絞り込み、出すのは先頭の IMPORT_SHOWN 件まで(件数が多くても左の列が伸び続けないように)。
  // スクロールの枠に入れないのは、チップがドラッグ中に元の場所のボタンのまま動くため(枠の外で切り取られて見えなくなる)
  const importable = copyable.filter((a) => audienceMatches(a, summarizeDsl(a.definition, names), importQuery));
  const importShown = importable.slice(0, IMPORT_SHOWN);
  const chip = (type: CondType) => (
    <DraggableChip key={type} id={`rail:${type}`} className={styles.chip} disabled={ctx.disabled} onClick={() => addAt(type, clickTarget)}>
      <span className={styles.glyph} aria-hidden="true">
        {COND_META[type].glyph}
      </span>
      {COND_META[type].label}
    </DraggableChip>
  );
  const nest = Math.max(0, nestLevels(root) - 1);
  const dsl = raw ? audience?.definition : toDsl(root);
  return (
    <div>
      <PageHeader title={name || "新しいオーディエンス"} meta={id ? <span className="mono">ID {id}</span> : undefined} />
      <ErrorBox message={error} />
      <DndContext id={dndId} sensors={sensors} collisionDetection={nestedCollision} accessibility={DND_ACCESSIBILITY} onDragEnd={onDragEnd}>
        <div className={styles.builder}>
          <aside className={styles.rail} aria-label="条件の部品">
            <div className={styles.railGroup}>
              <h3>このページ(今回の表示)</h3>
              {PAGE_TYPES.map(chip)}
            </div>
            <div className={styles.railGroup}>
              <h3>この訪問者(これまで)</h3>
              <p className={styles.railNote}>閲覧したページと目標は訪問者の履歴を使います(使うと表示のたびにサーバーへ問い合わせます)。初回の訪問からの経過は訪問者 ID から判定するので、履歴を使いません</p>
              {VISITOR_TYPES.map(chip)}
            </div>
            <div className={styles.railGroup}>
              <h3>組み立て</h3>
              {/* 上限の段に追加先があるときは disabled(クリックしても何もしない。理由は title と上の警告で伝える) */}
              <DraggableChip
                id="rail:group"
                className={styles.chip}
                disabled={ctx.disabled || groupDisabled}
                title={groupDisabled ? "追加先が上限の段にあるため、ここにはグループを置けません" : undefined}
                onClick={() => addAt("group", clickTarget)}
              >
                <span className={styles.glyph} aria-hidden="true">
                  ▣
                </span>
                グループ <span className="badge">入れ子 {AUDIENCE_NEST_MAX} 段まで</span>
              </DraggableChip>
            </div>
            <div className={styles.railGroup}>
              <h3>既存のオーディエンスから取り込む</h3>
              <p className={styles.railNote}>その時点の条件をグループとしてコピーします。元のオーディエンスとは連動しません</p>
              {copyable.length > 0 ? (
                <input
                  type="search"
                  className={styles.importSearch}
                  aria-label="取り込むオーディエンスを絞り込む"
                  placeholder="名前・ID・条件で絞り込み"
                  value={importQuery}
                  onChange={(e) => setImportQuery(e.target.value)}
                />
              ) : null}
              <div>
                {importShown.map((a) => (
                  <DraggableChip key={a.id} id={`aud:${a.id}`} className={styles.chip} disabled={ctx.disabled} onClick={() => importAt(a.id, clickTarget)}>
                    <span className={styles.glyph} aria-hidden="true">
                      ◍
                    </span>
                    <span>
                      {a.name}
                      <small>{summarizeDsl(a.definition, names)}</small>
                    </span>
                  </DraggableChip>
                ))}
              </div>
              {copyable.length === 0 ? <p className={styles.railNote}>取り込めるオーディエンスはありません</p> : null}
              {copyable.length > 0 && importable.length === 0 ? <p className={styles.railNote}>この条件に一致するオーディエンスはありません</p> : null}
              {importable.length > IMPORT_SHOWN ? (
                <p className={styles.railNote} data-testid="import-more">
                  ほか {importable.length - IMPORT_SHOWN} 件。検索で絞り込んでください
                </p>
              ) : null}
              {/* 取り込んだことの知らせ(B58)。読み上げのため、領域は最初から置いておく。同じ文が続いても読み直すよう、知らせごとに中身を作り直す */}
              <p className={styles.importNotice} role="status">
                {importNotice ? <span key={importNotice.seq}>{importNotice.text}</span> : null}
              </p>
            </div>
          </aside>
          <section className={styles.canvas} aria-label="条件">
            <div className={`card ${styles.meta}`}>
              <label>
                名前
                <input
                  value={name}
                  maxLength={100}
                  disabled={ctx.disabled}
                  onChange={(e) => {
                    touched();
                    setName(e.target.value);
                  }}
                />
              </label>
              <label>
                ID{audience ? "(作成後は変えられません)" : ""}
                <input value={id} disabled={!!audience || ctx.disabled} pattern="[a-z0-9][a-z0-9_\-]{0,63}" onChange={(e) => setManualId(e.target.value)} />
              </label>
              <label style={{ gridColumn: "1 / -1" }}>
                メモ(任意)
                <input
                  value={description}
                  maxLength={500}
                  disabled={ctx.disabled}
                  onChange={(e) => {
                    touched();
                    setDescription(e.target.value);
                  }}
                />
              </label>
            </div>
            {raw ? (
              <div className={t.raw} role="note">
                この条件はこの画面で表せません(古い書式などを含みます)。画面からは条件を変更できないので、API で書き換えてください。名前とメモは保存できます。
                <pre className={t.json}>{JSON.stringify(audience?.definition, null, 2)}</pre>
              </div>
            ) : (
              <>
                {nest >= AUDIENCE_NEST_MAX ? <div className={styles.limitAlert} role="status">グループの入れ子が上限の {AUDIENCE_NEST_MAX} 段に達しています。これより深いグループは置けません</div> : null}
                {/* 木を変えられなかった理由(入れ子の上限を超える操作・取り込み)。次に変えられたら消える(B58。トーストの代わり) */}
                {treeError ? (
                  <div key={treeError.seq} className={styles.limitAlert} role="alert">
                    {treeError.text}
                  </div>
                ) : null}
                <GroupView group={root} depth={0} api={builder} />
                {canEdit ? <DragAltHint /> : null}
              </>
            )}
          </section>
          <aside className={styles.panel} aria-label="要約">
            <div className="card">
              <h3>このオーディエンスに含まれる訪問者</h3>
              <p className={styles.summary} data-testid="audience-summary">
                {raw ? summarizeDsl(audience?.definition, names) : groupText(root, names, true)}
              </p>
              <p className="muted">グループの入れ子 {nest} / {AUDIENCE_NEST_MAX} 段</p>
            </div>
            <div className="card">
              <h3>このオーディエンスを使っているエクスペリエンス</h3>
              {audience && audience.usedBy.length > 0 ? (
                <ul className={styles.usage}>
                  {audience.usedBy.map((u) => (
                    <li key={u.id}>
                      <span>{u.name}</span>
                      <span className="badge">{u.status === "running" ? "実行中" : u.status === "paused" ? "一時停止" : u.status === "archived" ? "終了" : "下書き"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">まだ使われていません</p>
              )}
              <p className="muted">編集は次の公開で反映されます</p>
            </div>
            {canEdit ? null : <p className="muted">作成と編集は編集者以上が行います</p>}
            <details className="card">
              <summary>保存される JSON(エージェント・API と同じ形)</summary>
              <pre className={t.json} data-testid="audience-json">{dsl === null || dsl === undefined ? "(条件なし)" : JSON.stringify(dsl, null, 2)}</pre>
            </details>
          </aside>
        </div>
      </DndContext>
      {/* 保存は下の帯の 1 か所だけ(決まり U2)。成功は帯の左の文字で知らせる(5.3) */}
      {canEdit ? (
        <SaveBar dirty={dirty} message={savedMessage}>
          <button type="button" className="btn" disabled={busy || !dirty} onClick={discard}>
            破棄
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </SaveBar>
      ) : null}
    </div>
  );
}
