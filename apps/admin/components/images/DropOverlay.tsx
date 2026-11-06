"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./ImageLibrary.module.css";

/** ドラッグにファイルが含まれるか(ファイル以外 = 文字やリンクのドラッグには反応しない) */
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * 画面のどこにでもファイルを落とせるようにし、ファイルを持ってきている間は画面全体に「ここにドロップしてアップロード」の覆いを出す(spec §9.2)。
 * 子の要素を出入りするたびに dragenter / dragleave が対で来るので、数を数えて 0 になったときだけ消す。
 * enabled = false(閲覧者・R2 なし)では何も付けない
 */
export function DropOverlay({ enabled, onFiles }: { enabled: boolean; onFiles: (files: File[]) => void }) {
  const [shown, setShown] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  });

  useEffect(() => {
    if (!enabled) return;
    const reset = () => {
      depth.current = 0;
      setShown(false);
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current += 1;
      setShown(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e) || depth.current === 0) return;
      depth.current -= 1;
      if (depth.current === 0) setShown(false);
    };
    // dragover で既定の動き(ブラウザがファイルを開く)を止めないと drop が来ない
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      reset();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    // ウィンドウの外でドラッグをやめたときは dragleave が届かないことがある
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      reset();
    };
  }, [enabled]);

  if (!enabled || !shown) return null;
  return (
    <div className={styles.overlay} aria-hidden="true">
      <div className={styles.overlayBox}>ここにドロップしてアップロード</div>
    </div>
  );
}
