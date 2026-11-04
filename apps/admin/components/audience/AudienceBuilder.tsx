"use client";
import { useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { api as call, describeError } from "@/lib/client";
import { useDragAlternatives } from "@/lib/a11y";
import { audienceMatches } from "@/lib/audience-filter";
import { audienceIdCandidate, audienceIdProblem } from "@/lib/audience-id";
import {
  audienceDiscardTarget, audienceDraftOf, audienceInputDraft, audiencePatchBody, audienceServerKey, isAudienceDirty, reconcileAudienceUpdate, type AudienceDraft, type SavedAudience,
} from "@/lib/audience-draft";
import { audienceSaveNotice } from "@/lib/test-locks";
import { COND_META, PAGE_TYPES, VISITOR_TYPES, defaultCond, groupText, makeNames, summarizeDsl, treeProblem } from "@/lib/conditions";
import {
  AUDIENCE_NEST_MAX, audienceTreeFromDsl, cloneFresh, edit, findNode, findParent, insertNode, levelOf, moveNode, nestLevels, newId, toDsl,
  type CondType, type Group,
} from "@/lib/targeting-tree";
import type { Audience, Goal, Site } from "@/lib/types";
import { useConfirm } from "../ConfirmProvider";
import { DragAltHint } from "../DragAltHint";
import { ErrorBox } from "../ErrorBox";
import { BusyScope, useBusyAction } from "../ui/BusyScope";
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

/** 保存の結果の文(エクスペリエンスの保存と同じ文言。B173 第 1 段) */
const SAVED = "保存しました。次の公開で反映されます";
const REFRESH_TIMEOUT = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";
const WRITE_UNKNOWN = "保存できたか分かりません。再読み込みして確かめてください";
const CREATE_UNKNOWN = "作成できたか分かりません。再読み込みして確かめてください";
const SERVER_UPDATED = "この画面を開いた後に、内容が更新されました";

/** 新規の画面のサーバーの値(空の新規の木) */
const EMPTY: Pick<Audience, "name" | "description" | "definition"> = { name: "", description: "", definition: null };

/** 画面で表せない定義(raw)の下書き。条件は画面で変えられないので、作ったときの鍵と表示する定義を持つ */
type RawDraft = { definitionKey: string; definition: unknown } | null;

/**
 * 下書きの値(名前・メモ・条件の木・手で直した ID)と基準(base)・最後に届いたサーバーの値(server)。外枠が持ち、本体に渡す。
 * B173 第 2 段(S2-1): エクスペリエンスの外枠と同じく、新しいサーバーの値が届いたら reconcileAudienceUpdate で、
 * 未保存の変更が無ければ入れ替え、あれば下書きを残して注記を出す
 */
type AudienceForm = {
  base: AudienceDraft;
  draft: AudienceDraft;
  dirty: boolean;
  notice: boolean;
  root: Group;
  setRoot: Dispatch<SetStateAction<Group>>;
  targetId: string;
  setTargetId: (id: string) => void;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  manualId: string | null;
  setManualId: (v: string | null) => void;
  raw: RawDraft;
  /**
   * 破棄: 最後に確かめた保存済みの値へ戻す。自分の保存の後に新しいサーバーの値が届いていなければ保存の応答、届いていればその値
   * (新規なら空に戻し、手で直した ID も戻す)
   */
  discard: () => void;
  /** 自分の保存の書き込みが成功した直後(読み直しの前): 応答(control が正規化した値)を基準と下書きにし、注記を消す */
  acceptSaved: (updated: Audience) => void;
};

function useAudienceForm(audience: Audience | null): AudienceForm {
  const serverValue = audience ?? EMPTY;
  const server = useMemo(() => audienceDraftOf(audience ?? EMPTY), [audience]);
  const serverKey = audience ? audienceServerKey(audience) : "new";
  // 保存値は unknown のまま渡す。core の検査を通らない値・変換できない値は null(= 読み取り専用。plan ② P16)
  const treeOf = (definition: unknown) => audienceTreeFromDsl(definition);
  const [base, setBase] = useState<AudienceDraft>(server);
  const [root, setRoot] = useState<Group>(() => treeOf(serverValue.definition) ?? audienceTreeFromDsl(null)!);
  const [targetId, setTargetId] = useState(root.id);
  const [name, setName] = useState(serverValue.name);
  const [description, setDescription] = useState(serverValue.description ?? "");
  const [manualId, setManualId] = useState<string | null>(null);
  const [raw, setRaw] = useState<RawDraft>(() => (server.editable ? null : { definitionKey: server.definitionKey, definition: serverValue.definition }));
  const [notice, setNotice] = useState(false);
  // 自分の保存の応答と、そのときの props の鍵(読み直しが時間切れで props が古いままでも、破棄で保存前の値へ戻さないため。最終レビュー I3)
  const [saved, setSaved] = useState<SavedAudience>(null);
  const draft = audienceInputDraft({ name, description, manualId, tree: root, raw });
  const dirty = isAudienceDirty(base, draft);

  /** 下書きの入力をその値にする(木は作り直すのでノードの id が変わる。追加先も根に戻す)。返り値はその値の下書き */
  const fill = (a: Pick<Audience, "name" | "description" | "definition">): AudienceDraft => {
    const d = audienceDraftOf(a);
    const tree = treeOf(a.definition) ?? audienceTreeFromDsl(null)!;
    setRoot(tree);
    setTargetId(tree.id);
    setName(a.name);
    setDescription(a.description ?? "");
    setManualId(null);
    setRaw(d.editable ? null : { definitionKey: d.definitionKey, definition: a.definition });
    return d;
  };

  const [serverSeen, setServerSeen] = useState(serverKey);
  if (serverSeen !== serverKey) {
    // 描画中の state の調整(前の値を覚えて比べる。エクスペリエンスの serverSeen と同じ形)。自分の保存では、書き込みの成功の直後(読み直しの前)に
    // 基準と下書きを応答の値にしてあるので、ここで未保存の変更が無いと判断され、届いた値(ほかの人が変えた欄も含む)がそのまま入る。
    // ここでは知らせ(保存の成功・取り込み)を消さない(消すと、直後の「保存しました」が消える)
    setServerSeen(serverKey);
    const next = reconcileAudienceUpdate({ base, draft, server });
    setBase(next.base);
    if (next.draft === server) fill(serverValue);
    // 注記を消すのは、未保存の変更が無いときの入れ替え・自分の保存の成功・破棄だけ
    setNotice((n) => (next.notice ? true : dirty ? n : false));
  }

  return {
    base, draft, dirty, notice, root, setRoot, targetId, setTargetId, name, setName, description, setDescription, manualId, setManualId, raw,
    discard: () => {
      setBase(fill(audienceDiscardTarget({ server: serverValue, serverKey, saved })));
      setNotice(false);
    },
    acceptSaved: (updated) => {
      setBase(fill(updated));
      setSaved({ serverKey, value: updated });
      setNotice(false);
    },
  };
}

/**
 * オーディエンスの作成・編集画面(決定 49、設計書 §12): 左 = 条件の部品(このページ / この訪問者 / 組み立て / 既存のオーディエンスから取り込む)、
 * 中央 = 条件の木、右 = 要約・使用中のエクスペリエンス・保存される JSON、下 = 保存の帯(B58。保存は帯の 1 か所だけ、成功は帯の文字で知らせる)。
 * 部品はドラッグで置き、クリックすると一番外側の末尾に入る(アクセシビリティ設定がオンなら「ここに追加」で選んだグループ)。
 * 取り込みはその時点の定義のコピー(元を変えても連動しない。設計書 §5.5)。知らせはトーストを使わず、押した場所の近くに出す(決まり U3)。
 * B173 第 2 段(S2-1): 全体と保存の帯を範囲の部品(BusyScope)で包む。書き込みの間は覆って触れなくし、二度押しを止める。
 * 離れる前の確認(未保存・保存の途中)は、この範囲の dirty を見る PageLeaveGuard(app/w/layout.tsx)が出す
 */
export function AudienceBuilder(props: Props) {
  const form = useAudienceForm(props.audience);
  return (
    <BusyScope id="audience-builder" dirty={form.dirty}>
      <AudienceBuilderBody {...props} form={form} />
    </BusyScope>
  );
}

function AudienceBuilderBody({ wid, siteId, audience, audiences, goals, site, canEdit, form }: Props & { form: AudienceForm }) {
  const router = useRouter();
  const ask = useConfirm();
  const { run } = useBusyAction();
  const alt = useDragAlternatives();
  const sensors = useDragSensors();
  const dndId = useId();
  const { base, draft, dirty, notice, root, setRoot, targetId, setTargetId, name, setName, description, setDescription, manualId, setManualId } = form;
  // 画面で表せない定義(plan ② P16)。名前とメモだけ保存できる。表せるかは今の下書きが持つ(新しい props の値だけでは変えない)
  const raw = form.raw !== null;
  const rawDefinition = form.raw?.definition;
  const [randomPart] = useState(() => Math.random().toString(36).slice(2, 8));
  const [error, setError] = useState<string | null>(null);
  // 知らせ(B58): 取り込みの完了は取り込みの節に、木を変えられなかった理由は条件の木の上に、保存の成功は保存の帯に出す。
  // seq は同じ文が続いたときも読み上げ直すため(要素を作り直す key に使う)
  const [importNotice, setImportNotice] = useState<{ text: string; seq: number } | null>(null);
  const [treeError, setTreeError] = useState<{ text: string; seq: number } | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [importQuery, setImportQuery] = useState("");

  const taken = audiences.map((a) => a.id);
  // 新規の ID は名前から候補を作る(手で直したら追わない)。名前が空の間は出さない(サーバーとブラウザで乱数が食い違わないように)
  const id = audience ? audience.id : (manualId ?? (name.trim() ? audienceIdCandidate(name, taken, () => randomPart) : ""));
  const target = findNode(root, targetId)?.kind === "group" ? targetId : root.id;
  const clickTarget = alt ? target : root.id;
  // 書き込みの間は範囲の覆い(inert)で押せないので、busy では閉じない
  const ctx: RowCtx = { goals, goalsHref: `/w/${wid}/sites/${siteId}/goals`, audiences, retentionDays: site.retentionDays, timezone: site.timezone, allowAudience: false, disabled: !canEdit };
  const names = makeNames(goals, audiences);
  const dslOf = (tree: Group | null) => (raw || tree === null ? null : toDsl(tree));
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
  // 破棄(B58・B173 第 2 段): 最後に確かめた保存済みの値に戻す(useAudienceForm の discard。新規なら空に戻し、手で直した ID も戻す)
  function discard() {
    form.discard();
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
    if (audience) {
      // 自分が変えた欄だけを送る(開いた後にほかの人が変えた欄を上書きしない)。raw の下書きは definition を送らない
      const body = audiencePatchBody({ base, draft, root: raw ? null : root, canSendDefinition: draft.editable });
      // 送る欄が無い(保存のボタンは未保存の変更が無いと押せないので、ここに来るのは正規化の差だけ)なら、覆わずに破棄と同じにする
      if (Object.keys(body).length === 0) return discard();
      const outcome = await run<Audience>({
        // 実行中・一時停止中のエクスペリエンスが参照しているときは確認を挟む(設計書 §5.3、D9 ③ の §5.5)。確認のモーダル(決まり 2.5。取り消せる操作なので主ボタンの色)。確認は覆う前
        confirm: saveNotice !== null ? () => ask({ title: "オーディエンスを保存しますか?", body: saveNotice, confirmLabel: "保存する", tone: "primary" }) : undefined,
        write: (signal) => call<Audience>("PATCH", `/sites/${siteId}/audiences/${audience.id}`, body, { signal }),
        // 応答(control が正規化した値。ホストの小文字・パスの percent-encoding など)を基準と下書きにする(読み直しの前)。
        // 読み直しで届く値が未保存にも注記にもならず、正規化で値が変わっても未保存のまま残らない
        onWritten: (updated) => form.acceptSaved(updated),
        // 使っているエクスペリエンスの一覧などを読み直す
        after: "refresh",
      });
      switch (outcome.kind) {
        case "saved":
          // 読み直しを待ち切れなかったときは、本文の先頭に再読み込みの案内を出す(書き込みは成功。基準は応答の値のまま。送り直さない)
          if (outcome.refresh === "timeout") setError(REFRESH_TIMEOUT);
          else setSavedMessage(SAVED);
          return;
        case "failed":
          setError(describeError(outcome.error));
          return;
        case "unknown":
          setError(WRITE_UNKNOWN);
          return;
        default:
          // discarded(範囲が消えた・別の遷移が始まった)・cancelled(確認で取りやめた)・ignored(実行中)は何も出さない
          return;
      }
    }
    // 新規作成: 作った後は詳細の画面へ移り、着くまで覆い続ける(移った先が結果なので、作成の成功の文は出さない)。
    // 詳細の画面は別のページ(/audiences/[aid])なので、着けばこの範囲ごと消える
    const outcome = await run({
      label: "作成中…",
      write: (signal) => call("POST", `/sites/${siteId}/audiences`, { id, name, description, definition }, { signal }),
      after: "navigate",
      navigate: () => navigateApp(router, `/w/${wid}/sites/${siteId}/audiences/${id}`),
    });
    if (outcome.kind === "failed") setError(describeError(outcome.error));
    else if (outcome.kind === "unknown") setError(CREATE_UNKNOWN);
    // navigated(移動の打ち切り・別の遷移に替わった。打ち切りの文は NavGate が出す)・discarded などは何も出さない
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
  const dsl = raw ? rawDefinition : toDsl(root);
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
                <pre className={t.json}>{JSON.stringify(rawDefinition, null, 2)}</pre>
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
                {raw ? summarizeDsl(rawDefinition, names) : groupText(root, names, true)}
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
      {/* 保存は下の帯の 1 か所だけ(決まり U2)。成功は帯の左の文字で知らせる(5.3)。帯も範囲の中(覆いの間は押せない) */}
      {canEdit ? (
        <SaveBar dirty={dirty} message={savedMessage}>
          {notice ? (
            <span className="muted" data-testid="server-updated">
              {SERVER_UPDATED}
            </span>
          ) : null}
          <button type="button" className="btn" disabled={!dirty} onClick={discard}>
            破棄
          </button>
          {/* 保存中の表示は範囲の覆い(「保存中…」「作成中…」)が出すので、ボタンの文言は変えない */}
          <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void save()}>
            保存
          </button>
        </SaveBar>
      ) : null}
    </div>
  );
}
