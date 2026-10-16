import type { Change, CompiledConfig } from "@wtt/core";
import { applyChangeTo, applyHtml, changeKey, createPageState, injectCss, markApplied, queryAll, type CssChange, type HtmlChange } from "./apply";
import { cloneScript, runCustomJs, scriptsIn } from "./code";
import { prehideSelectorsFor } from "./prehide";

/** spec §10.8: Change ごとの適用結果。`matched` は selector に一致した要素数(selector を持たない CSS は注入で 1) */
export type PreviewChangeReport = { changeId: string; type: Change["type"]; selector?: string; matched: number; applied: boolean; error?: string };
/**
 * `error`(Experiment 単位)は、config に無い Experiment / Variant(`"unknown experiment or variant"`)、
 * 解釈できない指定(`"invalid preview request"`)、同一 Experiment の 2 つ目以降(`"duplicate experiment"`)に入る(決定 39 (4) (9))
 */
export type PreviewReport = { experimentId: string; variantId: string; changes: PreviewChangeReport[]; error?: string };

/** フラグメントから解釈した 1 件の要求。`error` があるものは適用も割当への反映もしない(report にだけ残す) */
export type PreviewRequest = { experimentId: string; variantId: string; error?: string };

/**
 * 注入する `<style>` / `<script>` に載せる nonce。設置タグが後から `__WTT_NONCE__` を置くことがあるので
 * 固定値ではなく「注入のたびに解決する関数」も受ける(CSP。spec §11 / §13.10 レシピ 2)
 */
export type NonceSource = string | null | (() => string | null);

const PREFIX = "#__ab_preview";

const decodePart = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * spec §12.3 (a): `#__ab_preview=exp_a:B,exp_b:A`。**フラグメントの先頭**がこの形のときだけ preview モードにする
 * (他の断片と混ぜられると、通常の遷移で偶然 preview に入る事故が起きうる)。
 * 決定 39 (9): `#__ab_preview` で始まれば**入力が不正でも常に隔離モードに入る**(fail-closed)— 認証なしの口で
 * 「preview のつもりが本番の計測に混ざる」ほうが害が大きいため。解釈できない要求は捨てずに `error` 付きで返し、
 * 呼び手(runtime)が `getPreviewReport()` の行として理由を見せる。
 * 各項目は最後の ":" で Experiment / Variant に割り、両側を decodeURIComponent する
 */
export function parsePreviewHash(hash: string): { preview: boolean; requests: PreviewRequest[] } {
  if (!hash.startsWith(PREFIX)) return { preview: false, requests: [] };
  const rest = hash.slice(PREFIX.length);
  // "=" 以降が指定。"=" が無い残り(空でない)は丸ごと 1 つの不正な要求として扱う
  if (rest !== "" && !rest.startsWith("=")) {
    return { preview: true, requests: [{ experimentId: decodePart(rest), variantId: "", error: "invalid preview request" }] };
  }
  const spec = rest.startsWith("=") ? rest.slice(1) : "";
  if (spec === "") return { preview: true, requests: [{ experimentId: "", variantId: "", error: "invalid preview request" }] };
  const requests: PreviewRequest[] = [];
  const seen = new Set<string>();
  for (const item of spec.split(",")) {
    const i = item.lastIndexOf(":");
    if (i <= 0 || i === item.length - 1) {
      requests.push({ experimentId: decodePart(item), variantId: "", error: "invalid preview request" });
      continue;
    }
    const experimentId = decodePart(item.slice(0, i));
    const variantId = decodePart(item.slice(i + 1));
    // 同一 Experiment の 2 つ目以降は最初の指定を優先し、こちらは適用しない(決定 39 (9))
    if (seen.has(experimentId)) {
      requests.push({ experimentId, variantId, error: "duplicate experiment" });
      continue;
    }
    seen.add(experimentId);
    requests.push({ experimentId, variantId });
  }
  return { preview: true, requests };
}

/** preview で強制適用する対象(config から解決済み) */
type Target = { experimentId: string; variantId: string; changes: Change[]; report: PreviewReport };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * spec §10.8: IMAGE は `src` を差し替えた時点で `applied: true` にするが、画像の読込は**非同期**なので、
 * 失敗したら後から `applied: false` / `error: "image load failed"` に書き換える(report は読むたびに最新の状態を返す)
 */
function watchImage(el: Element, row: PreviewChangeReport): void {
  el.addEventListener(
    "error",
    () => {
      row.applied = false;
      row.error = "image load failed";
    },
    { once: true },
  );
}

/**
 * 挿入した HTML の中の `<script>` を実行する(§11 の `activateScripts` と同じ差し替え)。preview は失敗を report に載せるため
 * `cloneScript` で自前に差し替える — `activateScripts` は内部で例外を握るので、呼び手から失敗が見えない(§10.8)。
 * 例外の帰属(§10.8):
 * - inline の**同期**例外 … 差し替えの間だけ `sync(row)` を立て、engine が持つ `window` の `error` リスナに拾わせる
 *   (`replaceWith` 自体が throw する実装では下の catch で拾う)
 * - `src` の**読込**失敗 … clone した要素の `error` イベント(非同期に report を更新)
 * - `src` の**実行**例外(読込には成功した後の throw)… 解決済みの絶対 URL(`fresh.src`)を `srcRows` に登録しておき、
 *   engine の `error` リスナが `ErrorEvent.filename` の一致でその Change の行を後から `applied: false` にする(非同期)
 * inline スクリプトがタイマー等から**後で**投げた例外は `filename` がページ自身の URL になり、どの Change のものか
 * 帰属できないので report には載せない(この限界は spec §10.8 とレシピ 2 に明記する)
 */
function activatePreviewScripts(
  doc: Document,
  roots: Element[],
  nonce: string | null,
  row: PreviewChangeReport,
  srcRows: Map<string, PreviewChangeReport>,
  sync: (r: PreviewChangeReport | null) => void,
): void {
  for (const old of scriptsIn(roots)) {
    try {
      const fresh = cloneScript(doc, old, nonce);
      if (fresh.src) {
        srcRows.set(fresh.src, row); // fresh.src は絶対 URL に解決済み = ErrorEvent.filename と同じ形
        fresh.addEventListener("error", () => {
          row.applied = false;
          row.error = `script load failed: ${fresh.src}`;
        });
      }
      sync(row);
      old.replaceWith(fresh); // inline はここで同期実行される
    } catch (e) {
      row.error = message(e);
    } finally {
      sync(null);
    }
  }
}

/**
 * preview 専用の適用エンジン。production の `createApplyEngine` とは**別物**にしてある —
 * Exposure / 対照 watch / consent の世代管理を通らないことを「そのコードに到達しない」構造で保証するため(決定 39 (4))。
 * 適用そのものは同じ純関数(`applyChangeTo` / `applyHtml` / `injectCss` / `runCustomJs`)を使う。
 * `nonce` は関数で渡すと注入のたびに解決する(設置タグが後から置く `__WTT_NONCE__` を拾うため。§13.10 レシピ 2)
 */
export function createPreviewEngine(
  doc: Document,
  config: CompiledConfig,
  requests: PreviewRequest[],
  nonce: NonceSource,
): { start(): void; reports(): PreviewReport[] } {
  const getNonce = typeof nonce === "function" ? nonce : (): string | null => nonce;
  const state = createPageState();
  const targets: Target[] = [];
  const reports: PreviewReport[] = [];
  /** `src` を持つスクリプトの絶対 URL → その Change の行(読込成功後に投げられた例外を帰属させる) */
  const srcRows = new Map<string, PreviewChangeReport>();
  /** inline スクリプトを差し替えている最中だけ立つ行(同期例外の帰属先) */
  let syncRow: PreviewChangeReport | null = null;
  const setSyncRow = (r: PreviewChangeReport | null): void => {
    syncRow = r;
  };
  /**
   * preview モードのページ寿命で **1 つだけ**保持する `window` の `error` リスナ(start() で登録し、外さない)。
   * 差し替えの前後だけ張る形では、読込に成功した `src` スクリプトが後から投げた例外を拾えない(§10.8)
   */
  const onWindowError = (e: Event): void => {
    const err = e as ErrorEvent;
    const row = err.filename ? srcRows.get(err.filename) : undefined;
    if (row) {
      row.applied = false; // 読込には成功したが実行で落ちた = その Change は適用できていない
      row.error = err.message || "script error";
      return;
    }
    if (syncRow) syncRow.error = err.message || "script error"; // inline の同期例外(DOM 挿入自体は成功している)
    // どちらでもない例外(inline スクリプトのタイマー等の非同期例外・ページ自身の例外)は帰属先が決まらないので report に載せない
  };
  for (const { experimentId, variantId, error } of requests) {
    if (error !== undefined) {
      // 不正な指定 / 重複した Experiment は適用せず理由だけ残す(決定 39 (9))
      reports.push({ experimentId, variantId, changes: [], error });
      continue;
    }
    const exp = config.experiments.find((e) => e.id === experimentId);
    const variant = exp?.variants.find((v) => v.id === variantId);
    if (!exp || !variant) {
      reports.push({ experimentId, variantId, changes: [], error: "unknown experiment or variant" });
      continue;
    }
    const report: PreviewReport = {
      experimentId,
      variantId,
      changes: variant.changes.map((c) => ({
        changeId: c.id,
        type: c.type,
        ...("selector" in c && c.selector ? { selector: c.selector } : {}),
        matched: 0,
        applied: false,
      })),
    };
    reports.push(report);
    targets.push({ experimentId, variantId, changes: variant.changes, report });
  }

  // 決定 51(設計書 §3.2): 本番と同じく config の並び(後ろほど優先)の順に適用する。指定の順には頼らない。
  // 部分の記録は持たないので、後から一致した要素での逆転までは再現しない(運用ガイドに書く)。reports は指定の順のまま
  const rankOf = (id: string): number => config.experiments.findIndex((e) => e.id === id);
  targets.sort((a, b) => rankOf(a.experimentId) - rankOf(b.experimentId));

  const mark = (el: Element, key: string): boolean => markApplied(state.applied, el, key);

  function applyOne(t: Target, change: Change, row: PreviewChangeReport): void {
    const key = changeKey(t.experimentId, t.variantId, change.id);
    if (change.type === "CSS") {
      if (state.styles.has(key)) return; // 既に注入済み(再スキャンで増やさない)
      try {
        state.styles.set(key, injectCss(doc, change as CssChange, { experimentId: t.experimentId, variantId: t.variantId }, getNonce()));
        row.matched = 1; // selector を持たない Change は注入した時点で 1 件当たったとみなす(§10.8)
        row.applied = true;
        delete row.error;
      } catch (e) {
        row.error = message(e);
      }
      return;
    }
    const els = queryAll(doc, change.selector); // 不正 selector は 0 件(§10.7)
    row.matched = els.length;
    if (els.length === 0) return; // selector が外れている: matched 0 / applied false のまま(§10.8)
    if (change.type === "CUSTOM_JS") {
      if (state.executed.has(key)) return; // ページ読込ごとに 1 回(§10.4)
      state.executed.add(key);
      const r = runCustomJs(doc, change.payload.code, els[0]!, { experimentId: t.experimentId, variantId: t.variantId, changeId: change.id }, getNonce());
      if (r.ok) row.applied = true;
      else row.error = message(r.error);
      return;
    }
    if (change.type === "HTML") {
      for (const el of els) {
        if (!mark(el, key)) continue;
        let inserted: Element[] | null = null;
        try {
          inserted = applyHtml(el, change as HtmlChange);
        } catch (e) {
          row.error = message(e);
          continue;
        }
        if (inserted === null) {
          row.error = "position replace cannot target html / head / body"; // §10.4
          continue;
        }
        // 挿入した部分木への自己再適用を防ぐ: 最上位要素と、selector に一致する子孫を適用済みにする(本番の apply.ts と同じ。§10.4)
        for (const n of inserted) {
          mark(n, key);
          try {
            for (const d of Array.from(n.querySelectorAll(change.selector))) mark(d, key);
          } catch {
            /* 不正セレクタは queryAll() で既に空 */
          }
        }
        if (change.payload.runScripts && !state.executed.has(key)) {
          state.executed.add(key);
          // inline の例外は同期、src の読込失敗と実行例外は非同期に row へ入る(§10.8)
          activatePreviewScripts(doc, inserted, getNonce(), row, srcRows, setSyncRow);
        }
        row.applied = true;
      }
      return;
    }
    for (const el of els) {
      if (!mark(el, key)) continue;
      if (applyChangeTo(el, change)) {
        row.applied = true;
        if (change.type === "IMAGE") watchImage(el, row); // 読込失敗なら後から applied: false に落ちる(§10.8)
      } else {
        row.error = "change could not be applied";
      }
    }
  }

  function scan(): void {
    for (const t of targets) {
      t.changes.forEach((change, i) => {
        const row = t.report.changes[i]!;
        try {
          applyOne(t, change, row);
        } catch (e) {
          row.error = message(e); // Change 単位の例外境界(§10.7)
        }
      });
    }
  }

  let observer: MutationObserver | null = null;
  let scheduled = false;
  return {
    start() {
      doc.defaultView?.addEventListener("error", onWindowError); // ページ寿命で 1 つ(外さない。§10.8)
      scan();
      observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          scan(); // §10.4: 後から現れた要素にも当てて report を更新する
        });
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
    },
    reports() {
      return reports;
    },
  };
}

/** preview 対象の Experiment だけの prehide セレクタ(本番と同じ見え方にするため。§10.3。error 行は対象外) */
export function previewPrehideSelectors(config: CompiledConfig, requests: PreviewRequest[]): string[] {
  return prehideSelectorsFor(
    config,
    requests.filter((r) => r.error === undefined).map((r) => r.experimentId),
  );
}
