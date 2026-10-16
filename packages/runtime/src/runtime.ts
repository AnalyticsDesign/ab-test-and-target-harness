import { createApplyEngine, createPageState } from "./apply";
import { analyticsNames, isAnalyticsSettings, isExposurePayloads } from "./analytics";
import { createConsent } from "./consent";
import { collectContext } from "./context";
import { decideLocally, needsRemoteDecision, requestDecision, type DecisionOutcome } from "./decision";
import { sendEvent } from "./events";
import { createExposureTracker } from "./exposure";
import { startGoalDetection } from "./goals";
import { establishIdentity, revokeIdentity } from "./identity";
import { injectPrehide, prehideSelectors, removePrehide } from "./prehide";
import { parsePreviewHash, previewPrehideSelectors, type PreviewReport } from "./preview";
import type { createPreviewEngine } from "./preview";
import type { ActiveChange, ApplyEngine, ControlWatch } from "./apply";
import type { CompiledConfig, Goal, RuntimeSettings } from "@wtt/core";

export type BootPayload = { config: CompiledConfig; settings: RuntimeSettings; apiBase?: string };

/** build の define(packages/runtime/build.mjs)。プレビューの別ファイルの内容のハッシュ(決定 50) */
declare const __WTT_PREVIEW_HASH__: string;
type PreviewFactory = typeof createPreviewEngine;

/**
 * 決定 50: プレビューの処理は別ファイル。下書きの bootstrap は先頭に埋め込み済み(読み込み口 `__WTT_PREVIEW__` がある)なので同期で返す。
 * 設置タグ経由は edge の /s/preview/<hash>.js(既定の Route の /s/* の下)を設置タグの nonce 付きで読む。
 * scriptSrc が無い・読めない・期限(timeoutMs = decisionTimeoutMs)までに読めなければ null(何も適用しない)。
 * load / error / 期限のうち最初の 1 回だけ onLoad を呼ぶ(done)。期限の後に届いた load は適用しない
 */
function loadPreviewFactory(deps: RuntimeDeps, nonce: string | null, timeoutMs: number, onLoad: (f: PreviewFactory | null) => void): void {
  const g = deps.win as unknown as { __WTT_PREVIEW__?: PreviewFactory };
  if (g.__WTT_PREVIEW__) return onLoad(g.__WTT_PREVIEW__);
  if (!deps.scriptSrc) return onLoad(null);
  let done = false;
  const finish = (f: PreviewFactory | null): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onLoad(f);
  };
  const timer = setTimeout(() => finish(null), timeoutMs); // prehide を張ったままにしない
  const s = deps.doc.createElement("script");
  s.src = new URL(`/s/preview/${__WTT_PREVIEW_HASH__}.js`, deps.scriptSrc).toString();
  if (nonce) s.nonce = nonce;
  s.onload = () => finish(g.__WTT_PREVIEW__ ?? null);
  s.onerror = () => finish(null);
  (deps.doc.head ?? deps.doc.documentElement).appendChild(s);
}

export type RuntimeDeps = {
  win: Window & { dataLayer?: unknown[]; __ab?: { consent?: unknown }; AB?: unknown };
  doc: Document;
  fetchFn: typeof fetch;
  scriptSrc: string | null;
  /** 設置タグの nonce(CSP)。生成する <script> / <style> に引き継ぐ(spec §11、決定 38) */
  nonce: string | null;
};

export type AbApi = {
  track(goalId: string): void;
  consent(granted: boolean): void;
  getAssignments(): Record<string, string>;
  /** spec §10.8: プレビュー(§12.3 (a))のときだけ非 null。通常モードは常に null(本番で Change の内容を露出しない) */
  getPreviewReport(): PreviewReport[] | null;
};

/**
 * boot payload の形チェック(zod なし — サイズ予算)。bootstrap は edge が KV parse 済みの値を焼き込むため、
 * ここでは「別物・改竄・未知 schemaVersion」を弾く最小限に留める(§6.4: 未知 schemaVersion は何も適用しない)。
 * 版 1 の設定は edge が版 2 の内部表現に変換してから焼き込む(決定 49、設計書 §6.1)ので、ここで受けるのは版 2 だけ
 */
export function parseBootPayload(raw: unknown): BootPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const config = (raw as Record<string, unknown>).config as CompiledConfig | undefined;
  const settings = (raw as Record<string, unknown>).settings as RuntimeSettings | undefined;
  const isRecord = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
  if (typeof config !== "object" || config === null || (config as { schemaVersion?: unknown }).schemaVersion !== 2) return null;
  if (!Array.isArray(config.experiments) || typeof config.siteId !== "string" || typeof config.version !== "number" || typeof config.siteSalt !== "string") return null;
  // 起動経路が触るコレクションの形も見る(壊れた payload で for-of / Object.values が throw するのを防ぐ。r1 CL-High-1)
  if (!isRecord(config.prehide) || !isRecord(config.exposureSelectors) || !isRecord(config.patterns) || !Array.isArray(config.goals)) return null;
  if (typeof settings !== "object" || settings === null) return null;
  if (typeof settings.visitorCookieName !== "string" || typeof settings.uuidCookieName !== "string") return null;
  if (typeof settings.uuidCookieEnabled !== "boolean" || typeof settings.idSource !== "string") return null;
  if (!Array.isArray(settings.previousCookieNames) || settings.previousCookieNames.some((n) => typeof n !== "string")) return null;
  if (typeof settings.decisionTimeoutMs !== "number" || !Number.isFinite(settings.decisionTimeoutMs)) return null;
  if (settings.consentMode !== "implicit" && settings.consentMode !== "required") return null;
  if (settings.mode !== "A" && settings.mode !== "B") return null;
  // §16 / 決定 37: forgetOnRevoke は欠落なら既定 true、型不正は他フィールドと同じく fail-closed
  const forget = (settings as { forgetOnRevoke?: unknown }).forgetOnRevoke;
  if (forget !== undefined && typeof forget !== "boolean") return null;
  // spec §10.9: analytics / exposurePayloads は欠落なら既定・導出にフォールバック、型不正は拒否(他フィールドと同じ fail-closed)
  const analytics = (settings as { analytics?: unknown }).analytics;
  if (analytics !== undefined && !isAnalyticsSettings(analytics)) return null;
  const payloads = (config as { exposurePayloads?: unknown }).exposurePayloads;
  if (payloads !== undefined && !isExposurePayloads(payloads)) return null;
  // 決定 52 (7): API の宛先(edge の公開 origin)。無ければ設置タグの src から導出する。型不正は他フィールドと同じく fail-closed
  const apiBase = (raw as Record<string, unknown>).apiBase;
  if (apiBase !== undefined && typeof apiBase !== "string") return null;
  return apiBase ? { config, settings, apiBase } : { config, settings };
}

const NOOP_API: AbApi = { track: () => {}, consent: () => {}, getAssignments: () => ({}), getPreviewReport: () => null };

export function createRuntime(deps: RuntimeDeps, rawBoot: unknown): AbApi {
  const payload = parseBootPayload(rawBoot);
  if (payload === null) {
    deps.win.AB = NOOP_API; // §10.7 / §6.4: 不正な boot は何もしない(サイトの AB 呼出は壊さない)
    return NOOP_API;
  }
  const { config, settings, apiBase } = payload;

  // spec §12.3 (a) / 決定 39 (4): 完全隔離モード。ここから下(Identity / consent / decision / Goals / Exposure)には一切入らない。
  // Cookie も読まず、dataLayer にも触れず、通信もしない。指定された Experiment の Variant を強制適用するだけ
  // 決定 39 (9): #__ab_preview で始まれば入力が不正でも preview(fail-closed)。不正・重複は error 行として report に出る
  const { preview: isPreview, requests: previewRequests } = parsePreviewHash(deps.win.location.hash);
  if (isPreview) {
    let engine: ReturnType<PreviewFactory> | null = null;
    const forced: Record<string, string> = {};
    for (const r of previewRequests) if (r.error === undefined) forced[r.experimentId] = r.variantId;
    const previewApi: AbApi = {
      track: () => {}, // §12.3 (a): Goals / /event は送らない
      consent: () => {}, // consent は参照も変更もしない
      getAssignments: () => ({ ...forced }),
      getPreviewReport: () => (engine === null ? [] : engine.reports()), // begin() 前は空配列(preview なので非 null)
    };
    deps.win.AB = previewApi;
    // 注入した下書きには document.currentScript が無いので deps.nonce は null。設置タグが残した
    // __WTT_NONCE__(index.ts が起動の可否に関わらず保存する)を**注入のたびに**引き継ぐ — 後から現れた要素への
    // 再適用や <script> の差し替えは設置タグの実行より後になり得るため、値を 1 回で握らない。
    // CSP(nonce + strict-dynamic)のページで CUSTOM_JS / HTML の <script> / CSS の <style> がブロックされないために必要(spec §11)
    const getNonce = (): string | null => deps.nonce ?? (deps.win as unknown as { __WTT_NONCE__?: string | null }).__WTT_NONCE__ ?? null;
    const begin = (): void => {
      injectPrehide(deps.doc, previewPrehideSelectors(config, previewRequests), getNonce()); // 本番と同じチラつき対策(§10.3)
      loadPreviewFactory(deps, getNonce(), settings.decisionTimeoutMs, (factory) => {
        try {
          if (factory) {
            engine = factory(deps.doc, config, previewRequests, getNonce);
            engine.start();
          } else {
            console.debug("wtt: preview unavailable");
          }
        } catch (e) {
          console.debug("wtt: preview failed", e); // §10.7: プレビューの失敗でページを壊さない
        } finally {
          removePrehide(deps.doc); // factory(...) の例外でも必ず外す
        }
      });
    };
    // 下書きの bootstrap は Playwright の addInitScript でページのどのスクリプトよりも先に走る(§13.10 レシピ 2)。
    // その時点では documentElement も head もまだ無いことがあり、prehide の appendChild と MutationObserver の observe は
    // どちらも documentElement を要求する。出来上がってから始める
    const domReady = (): boolean => deps.doc.documentElement !== null && deps.doc.head !== null;
    // Chromium では空の <html><head> が既にあることもある。その場合でも「自前の nonce が無い(= 注入された)」まま
    // 読込中なら、設置タグが __WTT_NONCE__ を置くまで待つ(最初の readystatechange の時点では <head> のタグは実行済み)
    if (domReady() && !(deps.nonce === null && deps.doc.readyState === "loading")) {
      begin();
    } else {
      const onReady = (): void => {
        if (!domReady()) return; // readystatechange は loading の途中でも来る
        deps.doc.removeEventListener("readystatechange", onReady);
        deps.doc.removeEventListener("DOMContentLoaded", onReady);
        begin();
      };
      deps.doc.addEventListener("readystatechange", onReady);
      deps.doc.addEventListener("DOMContentLoaded", onReady);
    }
    return previewApi;
  }

  const assignments: Record<string, string> = {};
  let engine: ApplyEngine | null = null;
  const pageState = createPageState(); // §10.4: 適用済み・実行済み・注入済みはページ寿命(撤回 → 再許可で作り直すエンジンに引き継ぐ)
  let generation = 0; // 起動世代。revoke → 再 grant で進み、旧世代の応答・タイマーは無効になる
  let revoked = false;
  // 現世代の decision リクエストの中断口。revoke から届くように start() の外に置く(下の onRevoke を参照)
  let aborter: AbortController | null = null;
  let currentVisitorId: string | null = null; // 現世代の Identity(forget の宛先)。Mode B は常に null(Cookie は edge 所有)
  let stopGoals: (() => void) | null = null;
  /**
   * §9.2 / r1 CX-High-1: /event は「Mode A = Identity 確立後」「D-lite = 最初の decision 応答(Set-Cookie)が settle した後」でないと
   * edge に Identity が無く 204 で無視される。それまでの検知はここに溜め、準備できたら同じ順で送る。撤回で捨てる
   */
  let eventsReady = false;
  let pendingGoals: Goal[] = [];
  /** in-flight の goal event。撤回時はこれらの settle を待ってから forget を送る(r2 CX-High-2: DO で処理済みになってから消す) */
  const inflightEvents = new Set<Promise<void>>();
  /** 撤回で送った forget の settle。次世代は期限タイマーと prehide より前にこれを待つ(r2 CX-High-1) */
  let pendingForget: Promise<void> | null = null;
  const FORGET_WAIT_MS = 2000; // in-flight goal の settle を待つ上限(通信断で撤回を無期限に遅らせない)

  const names = analyticsNames(settings); // §10.9: 名札はサイト設定。無ければ既定名
  const pushDataLayer = (evt: Record<string, unknown>): void => {
    // 決定 62: 宛先の配列名もサイト設定(GTM のスニペットの `l=`)。§10.5: 無ければ作ってから push。
    // 作った後に読み直すのは、window の setter 付きプロパティ(onload 等)が代入を無視・変換しうるため。
    // push を持たない既存の値は上書きせず push だけをやめる(サイトの持ち物を壊さず、適用と /event は続ける)。
    // getter だけのプロパティ(frameElement 等)への代入は strict mode で TypeError になるので、計測の失敗として握る
    const win = deps.win as unknown as Record<string, { push?: (e: unknown) => unknown } | null | undefined>;
    try {
      if (win[names.dataLayerName] == null) win[names.dataLayerName] = [] as unknown[];
      const dl = win[names.dataLayerName];
      if (typeof dl?.push === "function") dl.push(evt);
    } catch (e) {
      console.debug("wtt: dataLayer push failed", names.dataLayerName, e);
    }
  };
  const exposure = createExposureTracker(config, names, assignments, pushDataLayer);

  /** revoke 時に旧 Identity 由来の状態を捨てる。§16 の「旧 Identity は復元しない」を getAssignments にも及ぼす(r1 CX-Medium-1) */
  function clearAssignments(): void {
    for (const k of Object.keys(assignments)) delete assignments[k];
  }

  function decisionUrl(): string {
    if (settings.mode === "B") return "/__ab/decision"; // 同一ゾーン相対(§9.6)
    const base = apiBase ?? deps.scriptSrc ?? deps.win.location.href;
    return new URL(`/v1/sites/${encodeURIComponent(config.siteId)}/decision`, base).toString();
  }

  function eventUrl(): string {
    if (settings.mode === "B") return "/__ab/event"; // 同一ゾーン相対(§9.6)
    const base = apiBase ?? deps.scriptSrc ?? deps.win.location.href;
    return new URL(`/v1/sites/${encodeURIComponent(config.siteId)}/event`, base).toString();
  }

  function goalBody(goal: Goal): Record<string, unknown> | null {
    const body: Record<string, unknown> = { type: "goal", goalId: goal.id };
    if (settings.mode === "A") {
      if (currentVisitorId === null) return null; // 到達しない(flush は Identity 確立後にしか呼ばれない)
      body.visitorId = currentVisitorId;
    }
    return body;
  }

  function postGoal(goal: Goal): void {
    const body = goalBody(goal);
    if (!body) return;
    const p = sendEvent(deps.fetchFn, eventUrl(), body);
    inflightEvents.add(p);
    void p.finally(() => inflightEvents.delete(p));
  }

  /** 送信準備が整った世代で、溜めた Goal を検知順に送る */
  function flushEvents(): void {
    eventsReady = true;
    const queued = pendingGoals;
    pendingGoals = [];
    for (const g of queued) postGoal(g);
  }

  /** §10.6 / §10.9: conversion の共通処理。dataLayer に push し、needsProfile なら /event へ転送(§9.2。準備前はキュー) */
  function conversion(goal: Goal): void {
    const k = names.conversion.keys;
    pushDataLayer({ event: names.conversion.event, [k.goalId]: goal.id, [k.goalName]: goal.name, [names.extraKey]: null });
    if (!config.needsProfile) return;
    if (!eventsReady) {
      pendingGoals.push(goal);
      return;
    }
    postGoal(goal);
  }

  async function start(): Promise<void> {
    const gen = ++generation;
    // §16 / r2 CX-High-1: 撤回直後の再 grant は forget が settle するまで待つ。decisionTimeoutMs の中で待つと期限切れで世代ごと止まるので、
    // 期限タイマーと prehide を張る前に待つ(待っている間は元表示のまま。forget は通常 1 往復)。
    // 判定 R2: forget 自体が hang(通信断・edge の詰まり)したときの待ちも FORGET_WAIT_MS で打ち切る — 打ち切らないと
    // ブラウザのネットワークタイムアウトまで prehide も期限タイマーも張られないまま全世代が止まる。§16 の forget は
    // best-effort(失敗は Retention に委ねる)なので、上限後は先へ進んでよい(forget 自体は中断せず keepalive のまま飛ばし続ける)
    if (pendingForget) {
      await Promise.race([pendingForget, new Promise<void>((resolve) => setTimeout(resolve, FORGET_WAIT_MS))]);
      if (revoked || gen !== generation) return;
    }
    let expired = false;
    const myAborter = new AbortController(); // 起動ごとに新品。共有変数は現世代を指すが、期限タイマーは自分の分だけ中断する
    aborter = myAborter;
    const isStale = (): boolean => expired || revoked || gen !== generation; // decision の適用可否(期限を含む)
    const isRevoked = (): boolean => revoked || gen !== generation; // Goal の検知・送信可否(期限に依存しない。r2 CX-High-1)
    const deadlineTimer = setTimeout(() => {
      if (gen !== generation) return;
      expired = true;
      myAborter.abort();
      removePrehide(deps.doc); // §10.3: 期限で解除して元表示(Exposure なし)
      console.debug("wtt: decision timeout");
    }, settings.decisionTimeoutMs);

    async function run(): Promise<void> {
      injectPrehide(deps.doc, prehideSelectors(config, deps.win.location.href), deps.nonce); // consent 前には呼ばれない(§16)
      // 撤回で revokeIdentity が Cookie を消した後に古い世代の処理が終わっても、Cookie は作り直されない。
      // 撤回 → 再許可の後、新しい世代の Cookie を古い世代が上書きすることもない(isRevoked は世代の進みも見る)
      const identity = await establishIdentity(settings, config.siteSalt, deps.doc, () => !isRevoked());
      if (isRevoked()) return; // Identity 確立中に撤回された世代は何も始めない(検知も decision も)
      currentVisitorId = identity.visitorId;
      const { ctx, viewport } = collectContext({
        url: deps.win.location.href,
        referrer: deps.doc.referrer,
        userAgent: deps.win.navigator.userAgent,
        width: deps.win.innerWidth,
        height: deps.win.innerHeight,
        hasViewportMeta: deps.doc.querySelector('meta[name="viewport"]') !== null, // 決定 49 §11: meta より前で読んだ幅は不明
        now: Date.now(), // 判定時刻は 1 回の判定の最初に 1 度だけ取る
        firstVisitAt: identity.firstVisitAt,
      });
      // §10.6: Goals は実験の有無に関係なく検知する。decision の結果や期限には依存しない(PAGEVIEW はここで即発火 → Mode A は直後に送る、D-lite は decision 応答後)
      stopGoals?.();
      stopGoals = startGoalDetection(config, deps.doc, ctx.url, conversion);
      if (settings.mode === "A") flushEvents(); // Identity は確立済み。D-lite は Cookie が decision 応答で発行されるまで待つ
      if (isStale()) return; // 期限切れなら decision は送らない(Goal 検知は続く)

      let outcome: DecisionOutcome;
      if (needsRemoteDecision(settings, config, ctx.url)) {
        const body: Record<string, unknown> = { v: config.version, url: ctx.url, referrer: ctx.referrer, device: ctx.device, browser: ctx.browser, os: ctx.os };
        if (viewport) body.viewport = viewport; // viewport の meta が無い時点の幅は送らない(不明)
        if (settings.mode === "A" && identity.visitorId !== null) {
          body.visitorId = identity.visitorId; // D-lite は Cookie が正(§9.1)
          body.firstVisitAt = identity.firstVisitAt; // Mode C でも参考用の匿名 ID そのものは送らない(時刻だけ。決定 49 §7.4)
        }
        outcome = await requestDecision(deps.fetchFn, decisionUrl(), body, myAborter.signal, config.version);
        // D-lite: 応答(Set-Cookie)が settle した。応答が空・失敗・期限切れの abort でも送信を始める(r1 CL-High-1 / r2 CX-High-1)。
        // 期限で abort された初回訪問は Cookie が届いていないことがあり、その Goal は edge が 204 で無視する(既知の制約)
        if (settings.mode === "B" && !isRevoked()) flushEvents();
      } else {
        outcome = identity.visitorId === null ? null : decideLocally(config, ctx, identity.visitorId);
      }

      if (isStale()) return; // §10.3 / §16: 期限後・revoke 後・世代交代後の応答は破棄(適用も Exposure もしない)
      if (outcome === null) {
        console.debug("wtt: decision unavailable"); // §10.7: 元表示
        return;
      }
      for (const e of outcome.experiments) assignments[e.id] = e.variant;
      const changes: ActiveChange[] = [];
      const watches: ControlWatch[] = [];
      // 決定 51(設計書 §3.2): 順位 = config の並びの番号(後ろほど優先)。decision の応答の順には頼らない。
      // 適用も並びの順(前 → 後)に行う(HTML の挿入と CSS の順を並びのとおりにするため)
      const chosen = new Map(outcome.experiments.map((e) => [e.id, e.variant]));
      config.experiments.forEach((exp, rank) => {
        const vid = chosen.get(exp.id);
        const variant = vid === undefined ? undefined : exp.variants.find((v) => v.id === vid);
        if (!variant) return;
        if (variant.changes.length === 0) {
          watches.push({ experimentId: exp.id, selectors: config.exposureSelectors[exp.id] ?? [] }); // 対照 Variant(§10.5)
        } else {
          for (const change of variant.changes) changes.push({ experimentId: exp.id, variantId: variant.id, change, rank });
        }
      });
      // 防御: 現状 run() は世代ごとに 1 回で、isStale() が旧世代を止めているが、将来 activate()(Phase 2)等で
      // 同じ世代に 2 回目の start が入っても前のエンジンの MutationObserver をページ寿命で残さない(Plan 10 B2)。stop() は冪等
      engine?.stop();
      engine = createApplyEngine(
        deps.doc,
        {
          onApplied: (experimentId) => exposure.expose(experimentId),
          onControlSeen: (experimentId) => exposure.expose(experimentId),
        },
        { nonce: deps.nonce, state: pageState },
      );
      engine.start(changes, watches);
    }

    // §10.7: 起動経路のどの例外もサイトを壊さない。prehide を deadline 任せにせずここで必ず解除する(r1 CL-High-1)
    try {
      await run();
    } catch (e) {
      console.debug("wtt: start failed", e);
    } finally {
      clearTimeout(deadlineTimer);
      if (gen === generation) {
        aborter = null; // 現世代の in-flight は無くなった(新世代が張り替えた controller は消さない)
        removePrehide(deps.doc); // 旧世代の終了で現世代の prehide を剥がさない
      }
    }
  }

  function sendDliteConsentDenied(): void {
    // §16: D-lite は consent body を 1 回送り、edge が両 Cookie に Max-Age=0 を返す(DO へは転送しない)
    void deps
      .fetchFn("/__ab/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "consent", value: "denied" }),
        keepalive: true,
      })
      .catch(() => {});
  }

  const consentMachine = createConsent(settings.consentMode, deps.win.__ab?.consent, {
    onGrant: () => {
      // createConsent は遷移時のみ発火するため、ここに来る前の状態は pending か denied しかない(§16: 起動は 1 回だけ)
      revoked = false;
      void start(); // revoke 後の再 grant は新世代で起動(旧 Identity は復元しない、§16)
    },
    onRevoke: () => {
      // in-flight の decision を **consent body より先に** 中断する(§16 / §9.6)。
      // D-lite の decision 応答は正本 Cookie の Set-Cookie(Max-Age=1 年)を伴い、これはブラウザが
      // JS の判断より前に適用してしまう。応答本体を isStale() で捨てても、撤回直後に着弾した応答が
      // 削除したばかりの Cookie を 1 年分再発行する。中断を先に置くことで、edge が最後に見るのは削除になる
      //(すでに転送中の応答は取り消せない — 窓を塞ぐだけ)
      aborter?.abort();
      aborter = null;
      revoked = true;
      generation++; // in-flight の応答・期限タイマーを無効化
      engine?.stop();
      engine = null;
      stopGoals?.(); // §10.6: 検知も止める(再 grant で新世代として張り直す)
      stopGoals = null;
      pendingGoals = []; // 未送信の検知は捨てる
      eventsReady = false;
      removePrehide(deps.doc);
      // 旧 Identity 由来の状態を捨てる(r1 CX-Medium-1 / 2026-09-01 決定)。
      // 適用済みの DOM は巻き戻さない — 同一ページ内で撤回 → 再許可し、かつ Variant が変わった場合に
      // 前の書き換えが残る既知の制約(spec §10.4)。次のページ読込で解消する
      clearAssignments();
      exposure.reset();
      if (settings.mode === "B") {
        sendDliteConsentDenied(); // D-lite は DO 非接触のまま(§16)
      } else {
        // §16 / 決定 37: 撤回時点の ID を控えて forget を 1 回送る。既定 on、Site 設定で off。
        // r2 CX-High-2: in-flight の goal event が DO で処理済み(settle)になるのを待ってから送る — abort では送信済みのサーバー処理を止められず、
        // forget(KV 読取なし)が goal(KV 読取あり)を追い越して削除後に Profile が再生成される。上限 FORGET_WAIT_MS で通信断でも撤回を遅らせない。
        // forget 自体の失敗(503 / 通信断)は再試行せず Retention に委ねる(best-effort。spec §16)。
        // 現行 config の needsProfile は見ない — needsProfile の版で作られた Profile は現行が needsProfile=false でも DO に残り、
        // edge の forget は config を見ずに処理する(決定 37 C)。Profile を使ったことの無い Site でも撤回時の 1 要求で済む(backlog B53)
        const forgetId = currentVisitorId;
        if (settings.forgetOnRevoke !== false && forgetId !== null) {
          const inflight = [...inflightEvents];
          pendingForget = Promise.race([
            Promise.allSettled(inflight).then(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, FORGET_WAIT_MS)),
          ]).then(() => sendEvent(deps.fetchFn, eventUrl(), { type: "forget", visitorId: forgetId }));
        }
        revokeIdentity(settings, deps.doc); // Cookie は即時に消す(forget は控えた ID で送る)
      }
      currentVisitorId = null;
    },
  });

  const api: AbApi = {
    track(goalId) {
      if (consentMachine.state !== "granted") return; // §16: pending / denied 中は event を送らない
      const goal = config.goals.find((g) => g.id === goalId && g.type === "CUSTOM");
      if (!goal) {
        console.debug(`wtt: unknown custom goal ${goalId}`);
        return;
      }
      conversion(goal);
    },
    consent(granted) {
      consentMachine.set(granted);
    },
    getAssignments() {
      return { ...assignments };
    },
    getPreviewReport() {
      return null; // §10.8: 通常モードは常に null
    },
  };
  deps.win.AB = api;
  if (consentMachine.state === "granted") {
    void start();
  } else if (consentMachine.state === "denied" && settings.mode === "A") {
    // 事前状態が denied のまま読み込まれた場合も、残存 Identity を 1 回だけ掃除する(r1 CX-High-1)。
    // 通信は伴わない(§16: denied の間は decision / event を送らない)。
    // D-lite(mode B)はここで何もしない — 正本 Cookie は edge 所有で削除に通信が要るため、
    // 「denied の間は通信しない」規律を優先する(§16 の 2026-09-01 決定)。撤回の伝達は
    // サイト側が AB.consent(false) を呼ぶことで成立する(導入ガイドの必須手順)
    revokeIdentity(settings, deps.doc);
  }
  return api;
}
