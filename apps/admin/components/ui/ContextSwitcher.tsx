"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { roleLabel } from "@/lib/roles";
import { popoverPosition, searchContexts } from "@/lib/switcher";
import type { WorkspaceSummary } from "@/lib/types";
import { Icon } from "./Icon";
import styles from "./Sidebar.module.css";

/**
 * ワークスペースとサイトの切替(決定 54 (9)。GA4 のアカウント・プロパティの切替に倣う)。サイドバーの上端に 1 つの枠を常に出し、
 * 押すとサイドバーの右(幅 760px 未満は下)に開く: 上に検索欄、その下に 2 列(左 = ワークスペース、右 = 左で選んだワークスペースのサイト)。
 * 検索中は「ワークスペース › サイト」の 1 列。閉じる = Esc(枠へフォーカスを戻す)・外側のクリック・画面の移動・画面の大きさの変化
 */
export function ContextSwitcher({ workspaces, wid, sid }: { workspaces: WorkspaceSummary[]; wid: string; sid: string | null }) {
  const pathname = usePathname();
  const ws = workspaces.find((w) => w.id === wid) ?? null;
  const site = sid && ws ? (ws.sites.find((s) => s.id === sid) ?? null) : null;
  const [open, setOpen] = useState(false);
  const [pickedId, setPickedId] = useState(wid);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    setQuery("");
    if (focusButton) button.current?.focus();
  }, []);
  // 画面を移ったら閉じる(サイドバーは遷移をまたいで残る)
  useEffect(() => close(false), [pathname, close]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  if (!ws) return null;
  function toggle() {
    if (open) return close(false);
    const r = button.current!.getBoundingClientRect();
    setPos(popoverPosition(r, { width: window.innerWidth, height: window.innerHeight })); // 画面の内側に収める
    setPickedId(wid);
    setQuery("");
    setOpen(true);
  }
  const picked = workspaces.find((w) => w.id === pickedId) ?? ws;
  const hits = searchContexts(workspaces, query);
  const siteLabel = site ? site.name : "サイト一覧";
  return (
    <div>
      <button
        ref={button}
        type="button"
        className={styles.ctxButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`ワークスペースとサイトの切り替え: ${ws.name} / ${siteLabel}`}
        onClick={toggle}
      >
        <span className={styles.ctxStack}>
          <span className={styles.ctxWs}>{ws.name}</span>
          <span className={styles.ctxSite}>{siteLabel}</span>
        </span>
        <Icon name="chevrons" size={14} />
      </button>
      {open ? (
        <div
          ref={pop}
          className={styles.ctxPop}
          style={pos}
          role="dialog"
          aria-label="ワークスペースとサイトの切り替え"
          // 今の画面と同じ先(例: サイト一覧にいて「一覧」)を押すと pathname が変わらず開いたままになるので、リンクを押したら閉じる
          onClick={(e) => {
            if ((e.target as Element).closest("a")) close(false);
          }}
        >
          <div className={styles.ctxSearch}>
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ワークスペース・サイトを検索" aria-label="ワークスペース・サイトを検索" autoComplete="off" />
          </div>
          {query.trim() ? (
            <div className={styles.ctxCol}>
              {hits.length === 0 ? <div className={styles.ctxEmpty}>一致するワークスペース・サイトはありません</div> : null}
              {hits.map((h) => (
                <Link key={h.href} href={h.href} className={styles.ctxOpt}>
                  <span>{h.label}</span>
                  <small>{h.sub}</small>
                </Link>
              ))}
            </div>
          ) : (
            <div className={styles.ctxCols}>
              <div className={styles.ctxCol}>
                <h3 className={styles.ctxHead}>
                  ワークスペース
                  <Link href="/w" aria-label="ワークスペース一覧">
                    一覧
                  </Link>
                </h3>
                {workspaces.map((w) => (
                  <button key={w.id} type="button" className={styles.ctxOpt} aria-pressed={w.id === picked.id} aria-current={w.id === ws.id ? "true" : undefined} onClick={() => setPickedId(w.id)}>
                    <span>{w.name}</span>
                    <small>
                      {roleLabel(w.role)} · サイト {w.sites.length}
                    </small>
                  </button>
                ))}
              </div>
              <div className={styles.ctxCol}>
                <h3 className={styles.ctxHead}>
                  サイト
                  <Link href={`/w/${picked.id}`} aria-label="サイト一覧">
                    一覧
                  </Link>
                </h3>
                {picked.sites.length === 0 ? <div className={styles.ctxEmpty}>このワークスペースにはサイトがありません</div> : null}
                {picked.sites.map((s) => (
                  <Link key={s.id} href={`/w/${picked.id}/sites/${s.id}`} className={styles.ctxOpt} aria-current={s.id === sid && picked.id === ws.id ? "true" : undefined}>
                    <span>{s.name}</span>
                    <small>{s.domain}</small>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
