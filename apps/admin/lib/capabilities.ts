import type { Capabilities, ChangeType, WriteFreezeState } from "./types";
import { formatLocalTime } from "./local-time";

export const DEFAULT_CAPABILITIES: Capabilities = { imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, writeFreeze: null };

export const CHANGE_TYPES: ChangeType[] = ["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"];

/**
 * `/capabilities` の本文の形を検査する。不正なら null。
 * 「フィールドが無い」(古い control)は既定で補い、「フィールドはあるが型が不正」・object でない・配列は応答全体を信用しない
 */
export function parseCapabilities(data: unknown): Capabilities | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const bad = (k: string, ok: (v: unknown) => boolean) => k in d && !ok(d[k]);
  if (bad("imageUpload", (v) => typeof v === "boolean")) return null;
  if (bad("edgeOrigin", (v) => v === null || typeof v === "string")) return null;
  if (bad("tagOrigin", (v) => v === null || typeof v === "string")) return null;
  if (bad("edgeOnWorkersDev", (v) => typeof v === "boolean")) return null;
  if (bad("passwordLogin", (v) => typeof v === "boolean")) return null;
  if (bad("writeFreeze", (v) => v === null || isWriteFreezeState(v))) return null;
  return {
    imageUpload: typeof d.imageUpload === "boolean" ? d.imageUpload : DEFAULT_CAPABILITIES.imageUpload,
    edgeOrigin: typeof d.edgeOrigin === "string" ? d.edgeOrigin : null,
    // 設置タグの origin。応答に tagOrigin が無い古い control では、設置タグは edge と同じホストなので edgeOrigin を使う
    tagOrigin: typeof d.tagOrigin === "string" ? d.tagOrigin : typeof d.edgeOrigin === "string" ? d.edgeOrigin : null,
    edgeOnWorkersDev: d.edgeOnWorkersDev === true,
    passwordLogin: d.passwordLogin === true,
    writeFreeze: isWriteFreezeState(d.writeFreeze) ? d.writeFreeze : null,
  };
}

/** 200 以外・形が違うときは既定に倒す(画像は出す・帯は出さない)。最終判定は control が返す 409 / 422 / 503 */
export function resolveCapabilities(res: { status: number; data: unknown }): Capabilities {
  return (res.status === 200 ? parseCapabilities(res.data) : null) ?? DEFAULT_CAPABILITIES;
}

const isWriteFreezeState = (v: unknown): v is WriteFreezeState => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.reason === null || typeof o.reason === "string") && (o.until === null || typeof o.until === "string") && (o.since === null || typeof o.since === "number");
};

/**
 * backlog D13 / 決定 56 (5)(6): 凍結中のバナーの文。until は表示だけ(過ぎても凍結は続く)。
 * now = null はマウント前(サーバーの描画)で、時刻を含めない(サーバー = UTC とブラウザで文字が食い違うとハイドレーションが壊れる。B44)。
 * 文言は公開物 — 設計記録への参照を書かない
 */
export function writeFreezeBannerText(f: WriteFreezeState, now: number | null, timeZone?: string): string {
  const head = "メンテナンス中のため、変更は保存できません";
  if (f.reason === null) return `${head}(凍結の設定が読めません。作業者に確認してください)`;
  const base = `${head}。理由: ${f.reason}`;
  const until = f.until === null ? NaN : Date.parse(f.until);
  if (now === null || !Number.isFinite(until)) return base;
  const at = formatLocalTime(until, "deadline", timeZone);
  return until <= now ? `${base}。再開の見込み(${at})を過ぎています。作業者に確認してください` : `${base}。再開の見込み: ${at}`;
}

/**
 * backlog D13 / P17: 開いている画面のバナーが取り直した `/capabilities` の本文(取れなければ null)から次の表示を決める。
 * writeFreeze が無い・null = 凍結していない。取れない・形が不正(parseCapabilities が null。writeFreeze 以外のフィールドの型が不正な場合も含む)= 直前の表示を保つ
 * (control が一時的に読めないだけで「保存できる」と伝えない)
 */
export function nextWriteFreeze(prev: WriteFreezeState | null, data: unknown): WriteFreezeState | null {
  const caps = parseCapabilities(data);
  return caps === null ? prev : caps.writeFreeze;
}

/** 決定 43 (6): R2 なしでは IMAGE を新規に選べない。既存の IMAGE Change は選択肢に残して表示だけできるようにする */
export function changeTypeOptions(imageUpload: boolean, currentType: ChangeType): ChangeType[] {
  return imageUpload || currentType === "IMAGE" ? CHANGE_TYPES : CHANGE_TYPES.filter((t) => t !== "IMAGE");
}

/** 決定 46: Member 画面の「リセットリンク」は、パスワードログインが開いているときだけ意味がある(閉じていると control が 409) */
export const shouldShowResetLink = (caps: Capabilities): boolean => caps.passwordLogin === true;
/** 非常用の入口の閉じ忘れに気づけるよう、開いているあいだは認証済み領域の全ページに出す */
export const shouldShowBreakGlassBanner = (caps: Capabilities): boolean => caps.passwordLogin === true;
