"use client";
import {
  closestCenter, KeyboardSensor, pointerWithin, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type CollisionDetection, type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import styles from "./Targeting.module.css";

/**
 * ドラッグの共通設定(決定 49、設計書 §12・plan ② P1)。ポインタ(マウス・タッチ)は 4px 動かしてから始め、クリックと区別する。
 * キーボードは Space で持ち上げ、矢印キーで動かし、Space / Enter で置く(Enter で持ち上げないのは、部品のクリックに Enter を残すため)
 */
export function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );
}

const screenReaderInstructions: ScreenReaderInstructions = { draggable: "Space で持ち上げ、矢印キーで動かし、Space で置きます。Esc で取り消します" };
const announcements: Announcements = {
  onDragStart: () => "持ち上げました",
  onDragOver: ({ over }) => (over ? "置ける場所の上にあります" : "置ける場所の外です"),
  onDragEnd: ({ over }) => (over ? "置きました" : "置ける場所の外で放したので、元に戻しました"),
  onDragCancel: () => "取り消しました",
};
export const DND_ACCESSIBILITY = { screenReaderInstructions, announcements };

/**
 * 置き場所の当たり判定。置き場所は入れ子で重なる(グループの箱の中に子の行がある)ので、ポインタの下にあるもののうち一番小さい(= 一番内側の)ものを選ぶ。
 * キーボードで動かすときはポインタの位置が無いので、最も近い中心(closestCenter)
 */
export const nestedCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length === 0) return closestCenter(args);
  const area = (id: string | number) => {
    const r = args.droppableRects.get(id);
    return r ? r.width * r.height : Number.POSITIVE_INFINITY;
  };
  return [...within].sort((a, b) => area(a.id) - area(b.id)).slice(0, 1);
};

/** ドラッグできる行。行全体を動かし、つまみ(handle)からだけ始める。同じ要素を「この行の前」の置き場所(before:<id>)にもする */
export function DraggableRow({ nodeId, className, children }: { nodeId: string; className?: string; children: (handle: ReactNode) => ReactNode }) {
  const drag = useDraggable({ id: `node:${nodeId}` });
  const drop = useDroppable({ id: `before:${nodeId}` });
  const handle = (
    <span ref={drag.setActivatorNodeRef} className={styles.handle} aria-label="ドラッグで移動" {...drag.attributes} {...drag.listeners}>
      ⋮⋮
    </span>
  );
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      style={{ transform: CSS.Translate.toString(drag.transform) }}
      className={`${className ?? ""} ${drag.isDragging ? styles.dragging : ""} ${drop.isOver && !drag.isDragging ? styles.dropBefore : ""}`}
    >
      {children(handle)}
    </div>
  );
}

/** 置き場所(グループの末尾など) */
export function DropZone({ id, className, children }: { id: string; className?: string; children?: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className ?? ""} ${isOver ? styles.dropOver : ""}`}>
      {children}
    </div>
  );
}

/** ドラッグできる部品(左の欄の条件・グループ・既存のオーディエンス)。クリックでも足せる(aria-disabled は dnd-kit の attributes が disabled から付ける。disabled の間はクリックでも何もしない) */
export function DraggableChip({ id, onClick, disabled, className, title, children }: { id: string; onClick: () => void; disabled?: boolean; className?: string; title?: string; children: ReactNode }) {
  const { setNodeRef, listeners, attributes, transform } = useDraggable({ id, disabled });
  return (
    <button ref={setNodeRef} type="button" className={className} title={title} style={{ transform: CSS.Translate.toString(transform) }} {...attributes} {...listeners} onClick={disabled ? undefined : onClick}>
      {children}
    </button>
  );
}
