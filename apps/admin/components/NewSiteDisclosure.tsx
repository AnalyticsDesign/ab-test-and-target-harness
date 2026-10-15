"use client";
import { useState, type ReactNode } from "react";
import { SiteCreateForm } from "./SiteForms";
import { Icon } from "./ui/Icon";
import { PageHeader } from "./ui/PageHeader";

/**
 * Site 一覧の見出しと、その右上の主操作。押すと一覧の上に作成フォームを開く。
 * 見出しごとこの client component が持つのは、開閉の状態を持ちながらボタンを PageHeader の actions に置くため
 * (ほかの画面と同じく、主操作は見出しの右)。Site が 1 つも無いときは最初から開いておく
 */
export function NewSiteDisclosure({ workspaceId, defaultOpen, title, meta }: { workspaceId: string; defaultOpen: boolean; title: ReactNode; meta?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <PageHeader
        title={title}
        meta={meta}
        actions={
          <button type="button" className="btn btn-primary" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="plus" />
            新しいサイト
          </button>
        }
      />
      {open ? <SiteCreateForm workspaceId={workspaceId} /> : null}
    </>
  );
}
