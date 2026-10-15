import type { Change } from "./types";

/**
 * `GET .../experiments/:eid` が返す Change には `updatedBy` / `updatedAt` が付く(`lib/types.ts` のコメント参照)。
 * core の `ChangeSchema`(`packages/core/src/schema.ts`)は各 type とも `strictObject` で、そこに無いキーは
 * 422 `invalid_change`(`Unrecognized keys: "updatedBy", "updatedAt"`)で拒否する。
 *
 * `PUT .../variants/:vid/changes` に送る直前にこの形へ落とす — control が実際に受け取れる形
 * (`id` / `type` / `selector`?(CSS のみ持たない) / `payload`)だけを残す。
 * schema.ts:133-141 の全 7 branch を確認済み: CSS だけ selector が無く、他は必須(min 1)。
 * ここで `selector ?? ""` に倒すのは、control 側の 422(空文字は invalid_change)にそのまま委ねるため
 * (Task 12 review: このマッピングが崩れると保存の全件が壊れるため個別に固定する価値がある)
 */
export function toChangeWire(c: Change): { id: string; type: Change["type"]; selector?: string; payload: Record<string, unknown> } {
  return { id: c.id, type: c.type, ...(c.type === "CSS" ? {} : { selector: c.selector ?? "" }), payload: c.payload };
}
