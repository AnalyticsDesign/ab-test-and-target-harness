/** request-count の手元の観測だけで使う(製品のコードからは呼ばない)。 */
export type ObservedRequest = { url: string; control: string[]; complete: boolean };

/** 新しい要求がこの間来なければ「落ち着いた」とみなす。 */
const QUIET_MS = 2_000;

export async function waitForObservedQuiet(
  read: () => Promise<ObservedRequest[]>,
  expectedUrls: () => readonly string[] = () => [],
): Promise<number> {
  const deadline = Date.now() + 30_000;
  let last = "";
  let since = Date.now();
  while (Date.now() < deadline) {
    const reqs = await read();
    const now = `${reqs.length}/${reqs.reduce((n, r) => n + r.control.length, 0)}/${reqs.filter((r) => r.complete).length}`;
    // ブラウザが実際に送った各要求を、URLの重複も含めて観測できるまで静穏を始めない。
    // 根/子のspanは取り込み途中でも読めるため、完了済みの行だけを到着扱いにする。
    const remaining = reqs.filter((r) => r.complete).map((r) => r.url);
    const arrived = expectedUrls().every((url) => {
      const index = remaining.indexOf(url);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
    if (!arrived || reqs.some((r) => !r.complete) || now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= QUIET_MS) {
      return Date.now();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("admin への要求の観測が 30 秒たっても揃わないか、落ち着かない");
}
