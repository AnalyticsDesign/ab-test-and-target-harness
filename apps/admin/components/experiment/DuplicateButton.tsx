"use client";
import { useState } from "react";
import type { Experiment } from "@/lib/types";
import { DuplicateDialog } from "./DuplicateDialog";

/** 見出しの「複製」(編集者以上。どのタブ・どの状態でも) */
export function DuplicateButton({ wid, siteId, experiment }: { wid: string; siteId: string; experiment: Experiment }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        複製
      </button>
      {open ? <DuplicateDialog wid={wid} siteId={siteId} experiment={experiment} open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
