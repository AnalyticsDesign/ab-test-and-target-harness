"use client";
import { useEffect, useState } from "react";
import { nextCapabilities } from "@/lib/capabilities";
import { api } from "@/lib/client";
import { startCapabilitiesPoll } from "@/lib/capabilities-poll";
import type { Capabilities } from "@/lib/types";

/**
 * 開いている画面の `/capabilities` を取り直し、最新の状態を返す(凍結の帯と版の帯が共有する。呼ぶのは CapabilitiesBanners の 1 か所だけ)。
 * 画面は描き直さない(未保存の入力を消さない)。取り直しに失敗したら直前の状態を保つ。
 * `api()` を通すので、取得の要求も画面の版を名乗る
 */
export function useCapabilitiesPoll(initial: Capabilities): Capabilities {
  const [caps, setCaps] = useState(initial);
  useEffect(
    () =>
      startCapabilitiesPoll({
        fetchCaps: () => api("GET", "/capabilities"),
        onData: (data) => setCaps((prev) => nextCapabilities(prev, data)),
        doc: document,
      }),
    [],
  );
  return caps;
}
