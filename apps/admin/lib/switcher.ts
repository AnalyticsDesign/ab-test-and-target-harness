// apps/admin/lib/switcher.ts — ワークスペースとサイトの切替の検索(決定 54 (9))。GA4 と同じく、検索中は「ワークスペース › サイト」の 1 列
import type { WorkspaceSummary } from "./types";

export type ContextHit = { href: string; label: string; sub: string };

/** 空の検索語は結果なし(2 列の表示に戻す)。移り先は表示の文字列ではなく ID から作る(名前に「›」があっても壊れない) */
export function searchContexts(workspaces: WorkspaceSummary[], query: string): ContextHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: ContextHit[] = [];
  for (const w of workspaces) {
    if (w.name.toLowerCase().includes(q)) hits.push({ href: `/w/${w.id}`, label: w.name, sub: `ワークスペース · サイト ${w.sites.length}` });
    for (const s of w.sites) {
      if (`${s.name} ${s.domain} ${s.id}`.toLowerCase().includes(q)) hits.push({ href: `/w/${w.id}/sites/${s.id}`, label: `${w.name} › ${s.name}`, sub: s.domain });
    }
  }
  return hits;
}

const GAP = 8; // 枠と一覧の間
const MARGIN = 16; // 画面の端との余白
const MAX_WIDTH = 560;
const MIN_HEIGHT = 200; // 検索欄 + 数行。これより下が狭ければ一覧を上へずらす
const NARROW = 760; // これ未満は枠の下に開く(決定 54 (9))

/**
 * 切替の一覧の位置と大きさ(position: fixed の座標。r1 / r2 CX-Medium-4)。幅 760px 以上は枠の右、未満は枠の下に開く。
 * 上端は画面の内側(16px)に収め、下に 200px 取れなければ上へずらす(画面がそれより低ければ上端を余白に置き、残り全部を一覧にする)。
 * 右端・下端も画面の端から 16px の内側に収まるよう幅と高さを縮める(一覧の中はスクロールする)
 */
export function popoverPosition(
  anchor: { top: number; right: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): { top: number; left: number; width: number; maxHeight: number } {
  const below = viewport.width < NARROW;
  const preferred = below ? anchor.bottom + 6 : anchor.top;
  const lowestTop = viewport.height - MARGIN - MIN_HEIGHT; // ここより下に置くと 200px 取れない
  const top = Math.max(MARGIN, Math.min(preferred, lowestTop));
  const left = below ? anchor.left : anchor.right + GAP;
  const width = Math.max(0, Math.min(MAX_WIDTH, viewport.width - MARGIN - left));
  const maxHeight = Math.max(0, viewport.height - MARGIN - top);
  return { top, left, width, maxHeight };
}
