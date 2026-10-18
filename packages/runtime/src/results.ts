import type { CompiledConfig, Device, ResultOutcome, ResultsEventResponse, RuntimeSettings } from "@wtt/core";

/**
 * D9 ②(設計書 §6.1・§6.2、K9): 結果の参加・後から失敗・回復・CV の送信と、送信済みの印。
 * 印は localStorage の 1 キー(`<訪問者 ID の Cookie 名>_r`)に `{ v: 1, i, p: { runId: "variantId:o|f|r|x" }, c: { runId: goalId[] }, s? }`。
 * o = 適用成功・f = 失敗・r = 失敗の後に回復・x = 送り直さない ignored(以後その run には何も送らない)、s = 予算の停止の期限(edge が決めた until)。
 * 送信は run ごとに直列(前の送信が settle してから次を決める)。CV は参加の送信の settle を待ってから送り先を決める。
 * 入口(participant / applyFailed / applied / endScan / conversion)は例外を投げない(エンジンはコールバックの例外を隔離しない)。
 * `send` は reject しないこと(runtime が 2xx で JSON を読めないもの・通信の失敗を null にする)。送信中の Promise は runtime の inflightEvents が持つ
 */
export type ResultsSender = {
  begin(visitorHash: string | null): void;
  participant(experimentId: string, variantId: string, device: Device): void;
  applyFailed(experimentId: string): void;
  applied(experimentId: string): void;
  endScan(): void;
  conversion(goalId: string): void;
  clear(): void;
};
type Marks = { v: 1; i: string; p: Record<string, string>; c: Record<string, string[]>; s?: number };
type Body = Record<string, unknown>;

// K9: これを超える印は捨てる(読むときは読まずに送り直し、書くときはキーを消してメモリだけで持つ)。
// K9 の「p は 50 run・c は 1 run あたり 50 目標まで書く」は持たない(2026-10-17 ユーザー決定。runtime の gzip の上限(決定 50)に収めるため。
// 4,096 文字の上限がほぼ同じ役目を持ち、超えたときは印を捨てて次のページで送り直す = D1 の一意制約で 1 行に保ち、コストだけが増える)
const MAX_CHARS = 4096;

/** localStorage(sandbox の iframe などでは参照だけで throw する) */
export function localStore(win: Window): Storage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/** 印を消す(撤回・読み込み時点で denied の Mode A) */
export function clearMarks(storage: Storage | null, settings: RuntimeSettings): void {
  try {
    storage?.removeItem(settings.visitorCookieName + "_r");
  } catch {
    // 使えない環境では消すものも無い
  }
}

export function createResultsSender(o: {
  config: CompiledConfig;
  settings: RuntimeSettings;
  storage: Storage | null;
  send(body: Body): Promise<ResultsEventResponse | null>;
  now(): number;
}): ResultsSender {
  const runs = o.config.results?.runs ?? {}; // experimentId → runId
  const live = new Set(Object.values(runs));
  const key = o.settings.visitorCookieName + "_r";
  let M: Marks = { v: 1, i: "", p: {}, c: {} };
  let hash: string | null = null; // null = localStorage を読みも書きもしない(メモリだけで重複を防ぐ。K9)
  let dead = false; // 撤回の後(届いた応答でも印を書かない)
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r)); // begin までは溜める
  const chain: Record<string, Promise<unknown>> = {}; // run ごとの直列の送信
  let cvChain: Promise<unknown> = gate;
  const seen = new Map<string, [string, Device]>(); // この scan で参加の契機を受けた experiment → [variantId, device]
  const failed = new Set<string>(); // ページの中で適用の失敗を受けた experiment
  const lateKeys = new Set<string>(); // 待っている・送った後から失敗と回復(run + 種類。送ったものは残してページの中で 1 回だけ)

  /** 送らない: 撤回の後か、予算の停止の期限(s)の前 */
  const halt = (): boolean => dead || (M.s ?? 0) > o.now();
  const enqueue = (run: string, task: () => unknown): void => {
    chain[run] = (chain[run] ?? gate).then(task).catch(() => {});
  };

  function save(): void {
    if (dead || !hash || !o.storage) return;
    try {
      const json = JSON.stringify(M);
      if (json.length > MAX_CHARS) o.storage.removeItem(key);
      else o.storage.setItem(key, json);
    } catch {
      // 書けなくてもメモリの印で続ける
    }
  }

  /** 応答の stopped を印の s にする(期限は edge の until。runtime の時計で計算しない。K8) */
  const stopOn = (r: ResultOutcome | null | undefined): void => {
    if (r?.until) M.s = r.until; // until は stopped のときだけ付く
  };

  /**
   * 参加の種類の送信(初回・後から失敗・回復)。stored で印を next に。初回の retry: false は x に
   * (後から失敗・回復の retry: false は印を変えない: 前の割り当てのパターンで送ったものが新しい参加まで止めないように)
   */
  async function sendParticipant(run: string, body: Body, next: string): Promise<void> {
    const r = await o.send({ type: "participant", v: 1, runId: run, ...body });
    if (r?.result === "stored") M.p[run] = next;
    else if (r?.retry === false && body.device) M.p[run] = body.variantId + ":x";
    stopOn(r);
    save();
  }

  /**
   * 後から失敗(recover = false: 印が o のとき)・回復(true: 印が f のとき)を、ページの中で 1 回だけ送る。
   * 回復はエクスペリエンス単位(設計書 §6.1「適用に失敗して参加した人が、後で初めて適用に成功したとき」): onApplied は Change ごとに呼ばれるので、
   * このページでそのエクスペリエンスの失敗を受けていれば送らない(task は scan の後に走るので、同じ scan の後ろの失敗も failed に入っている)
   */
  function late(experimentId: string, recover: boolean): void {
    const run = runs[experimentId];
    const k = `${run}${recover}`;
    if (!run || lateKeys.has(k)) return;
    lateKeys.add(k);
    // この scan の参加の送信(endScan で積む)より前に積まれるので、その scan の中の失敗・成功は参加の applied にだけ入る(印がまだ無い)
    enqueue(run, () => {
      const m = M.p[run];
      if (halt() || (recover && failed.has(experimentId)) || m?.slice(-1) !== (recover ? "f" : "o")) return void lateKeys.delete(k); // 送らなかった: 後でまた確かめる
      const variantId = m.slice(0, -2);
      return sendParticipant(run, { variantId, applied: recover ? "recovered" : "failed_later" }, variantId + (recover ? ":r" : ":f"));
    });
  }

  return {
    begin(h) {
      hash = h;
      try {
        const raw = h && o.storage?.getItem(key);
        const j = raw && raw.length <= MAX_CHARS ? (JSON.parse(raw) as Marks) : null;
        // i が違えば印をすべて捨てて送り直す。results.runs に無い run(終わったテスト)と形の違う項目は捨てる(壊れた印で止まらない)
        const pick = (x: object, ok: (v: unknown) => boolean) => Object.fromEntries(Object.entries(x).filter(([r, v]) => live.has(r) && ok(v)));
        if (j?.v === 1 && j.i === h) M = { v: 1, i: h, p: pick(j.p, (v) => typeof v == "string"), c: pick(j.c, Array.isArray), s: j.s } as Marks;
      } catch {
        // 読めない・形が違う(p や c が null など)なら印なし
      }
      M.i = h as string; // null のときは書かないので使わない
      if ((M.s ?? 0) <= o.now()) delete M.s;
      save();
      open();
    },
    participant(experimentId, variantId, device) {
      if (runs[experimentId]) seen.set(experimentId, [variantId, device]);
    },
    applyFailed(experimentId) {
      failed.add(experimentId);
      late(experimentId, false);
    },
    applied(experimentId) {
      late(experimentId, true);
    },
    endScan() {
      // 参加は scan の終わりに送る(参加の契機の後に起きたその scan の失敗も applied に入れる)
      for (const [e, [variantId, device]] of seen) {
        const run = runs[e]!;
        const applied = failed.has(e) ? "failed" : "ok";
        enqueue(run, () => {
          const m = M.p[run];
          // 印に同じパターンがある・x・停止中は送らない。違うパターンは送る(D1 が混在として数える)。印の適用の状態は D1 の行のまま引き継ぐ
          if (halt() || m?.slice(-1) === "x" || m?.slice(0, -2) === variantId) return;
          return sendParticipant(run, { variantId, device, applied }, variantId + ":" + (m ? m.slice(-1) : applied[0]));
        });
      }
      seen.clear();
    },
    conversion(goalId) {
      cvChain = cvChain
        .then(async () => {
          await Promise.all(Object.values(chain)); // 参加の送信中の run は settle を待つ(保存されなかった run は印が無いので外れる)
          const ids = Object.keys(M.p).filter((r) => M.p[r]!.slice(-1) !== "x" && !M.c[r]?.includes(goalId));
          for (let i = 0; i < ids.length && !halt(); i += 20) {
            const part = ids.slice(i, i + 20);
            const r = await o.send({ type: "conversion", v: 1, goalId, runIds: part });
            for (const run of part) {
              const x = r?.runs?.[run];
              if (x?.result === "stored" || x?.retry === false) (M.c[run] ??= []).push(goalId);
              stopOn(x);
            }
            save();
          }
        })
        .catch(() => {});
    },
    clear() {
      dead = true; // 以後は送らず、届いた応答でも印を書かない。begin の前に溜めた処理は走らないまま捨てる。印の削除は runtime の撤回が行う
    },
  };
}
