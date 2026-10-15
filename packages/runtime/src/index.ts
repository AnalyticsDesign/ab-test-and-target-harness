import { createRuntime, type RuntimeDeps } from "./runtime";

// §10.7: runtime 自身の例外でサイトを壊さない(config 取得失敗と同じく「何もしない」)
try {
  const g = self as unknown as { __WTT_BOOT__?: unknown; __WTT_BOOTED__?: boolean; __WTT_NONCE__?: string | null };
  const cs = document.currentScript as HTMLScriptElement | null;
  const scriptSrc = cs?.src ?? null;
  // CSP の nonce hiding で content 属性は空になるため IDL 属性を先に見る(spec §11)
  const nonce = cs?.nonce || cs?.getAttribute("nonce") || null;
  // 注入した下書きの bootstrap には currentScript が無く nonce も取れない。設置タグが持つ nonce は
  // **起動するかどうかに関わらず**残しておき、preview の適用時に引き継げるようにする(CSP ページ対応)
  if (nonce) g.__WTT_NONCE__ = nonce;
  // 1 ページ 1 起動(§13.10 レシピ 2)。下書きの bootstrap を addInitScript で注入したページには設置タグの
  // bootstrap も届くが、後から走った方は何もしない — 先に走った(注入した下書きの)AB をそのまま残す
  if (!g.__WTT_BOOTED__) {
    g.__WTT_BOOTED__ = true;
    const rawBoot = g.__WTT_BOOT__;
    createRuntime(
      { win: window as RuntimeDeps["win"], doc: document, fetchFn: (...a: Parameters<typeof fetch>) => fetch(...a), scriptSrc, nonce },
      rawBoot,
    );
  }
} catch (e) {
  console.debug("wtt: boot failed", e);
}
