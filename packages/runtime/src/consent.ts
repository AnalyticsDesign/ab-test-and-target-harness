export type ConsentState = "granted" | "denied" | "pending";
export type ConsentHooks = { onGrant(): void; onRevoke(): void };
export type ConsentMachine = { readonly state: ConsentState; set(granted: boolean): void };

/**
 * spec §16: モードによらず明示的な `denied` は尊重する(fail-safe。2026-09-01 決定)。
 * required は事前状態なし・未知値とも pending(明示的な granted まで初期化しない)。
 * implicit は denied 以外(pending を含む)を無視して即起動する — 「待ち」を持ち込むと設定ミスで配信が黙って止まるため
 */
export function initialConsentState(mode: "implicit" | "required", preset: unknown): ConsentState {
  if (preset === "denied") return "denied";
  if (mode === "implicit") return "granted";
  return preset === "granted" ? "granted" : "pending";
}

export function createConsent(mode: "implicit" | "required", preset: unknown, hooks: ConsentHooks): ConsentMachine {
  let state = initialConsentState(mode, preset);
  return {
    get state() {
      return state;
    },
    set(granted: boolean) {
      const next: ConsentState = granted ? "granted" : "denied";
      if (next === state) return; // 遷移時のみ発火(§16: 起動処理は 1 回だけ / 削除は denied への遷移時)
      state = next;
      if (next === "granted") hooks.onGrant();
      else hooks.onRevoke();
    },
  };
}
