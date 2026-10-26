/**
 * `/capabilities` の定期的な取り直し(React に依存しない部分。node の試験で時計を進めて確かめるため分けてある)。
 * P17: 共有 layout は router.refresh() やクライアント遷移では描き直されないので、初期値(サーバーが読んだ状態)の後は
 * 60 秒ごと(タブが隠れている間は取り直さない。Worker への要求を使わないため)と、タブが前に戻ったときに取り直す。
 * 取れなかったときは onData に null を渡す(呼び出し側が直前の表示を保つ)。onData に渡すのは最後に出した要求の応答(失敗の null を含む)だけで、
 * それより前に出した要求の応答と、stop() の後に着いた応答は捨てる(60 秒ごとの取得とタブを戻したときの取得が前後しても、古い応答で帯を戻さないため)
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
  // 要求の連番。応答が着いた時点でこれが自分の番号でなければ、後に新しい要求を出しているので捨てる
  let latest = 0;
  const refresh = () => {
    const seq = ++latest;
    fetchCaps()
      .catch(() => null)
      .then((data) => {
        // 最新の要求が失敗し、先に出した要求の成功が後から着いたときも捨てる(表示は直前のまま、次の取得で直る。
        // 書き込みは control が止めるので、害は表示の遅れだけ)
        if (alive && seq === latest) onData(data);
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
