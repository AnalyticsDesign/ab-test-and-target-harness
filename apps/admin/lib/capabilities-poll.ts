/**
 * `/capabilities` の定期的な取り直し(React に依存しない部分。node の試験で時計を進めて確かめるため分けてある)。
 * P17: 共有 layout は router.refresh() やクライアント遷移では描き直されないので、初期値(サーバーが読んだ状態)の後は
 * 60 秒ごと(タブが隠れている間は取り直さない。Worker への要求を使わないため)と、タブが前に戻ったときに取り直す。
 * 取れなかったときは onData に null を渡す(呼び出し側が直前の表示を保つ)。stop() の後に着いた応答は捨てる
 */
export const CAPABILITIES_POLL_MS = 60_000;

/** document のうち使う所だけ(試験では偽物を渡す。本物の document はそのまま渡せる) */
export type PollDocument = {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export function startCapabilitiesPoll(opts: {
  fetchCaps: () => Promise<unknown>;
  onData: (data: unknown) => void;
  doc: PollDocument;
  intervalMs?: number;
}): () => void {
  const { fetchCaps, onData, doc, intervalMs = CAPABILITIES_POLL_MS } = opts;
  let alive = true;
  const refresh = () => {
    fetchCaps()
      .catch(() => null)
      .then((data) => {
        if (alive) onData(data);
      });
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") refresh();
  };
  // 隠れたタブでは見送る(戻ったときは visibilitychange で取り直す)
  const timer = setInterval(() => {
    if (doc.visibilityState === "visible") refresh();
  }, intervalMs);
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    alive = false;
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}
