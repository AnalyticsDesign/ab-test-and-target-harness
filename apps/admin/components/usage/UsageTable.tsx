// apps/admin/components/usage/UsageTable.tsx
import type { UsageReport, UsageResource } from "@/lib/types";
import { paidNote, usageSections, type UsageMeter } from "@/lib/usage";
import { LocalTime } from "../LocalTime";
import styles from "./Usage.module.css";

/** 状態の色(止まる危険 = warn / danger、止まらない目安の超過 = note) */
const TONE_CLASS = { ok: "toneOk", warn: "toneWarn", danger: "toneDanger", note: "toneNote" } as const;
const BAR_CLASS = { ok: "barOk", warn: "barWarn", danger: "barDanger", note: "barNote" } as const;

/** 割合の横棒。100% を超えても棒は枠いっぱいで止める(数字は隣の文字で読む)。読み上げは隣の文字に任せるので棒は aria-hidden */
function Meter({ meter }: { meter: UsageMeter }) {
  return (
    <span className={styles.meter} aria-hidden="true">
      <span className={`${styles.bar} ${styles[BAR_CLASS[meter.tone]]}`} style={{ width: `${Math.min(meter.ratio, 1) * 100}%` }} />
      {meter.ticks ? (
        <>
          <span className={styles.tick} style={{ left: "70%" }} />
          <span className={styles.tick} style={{ left: "90%" }} />
        </>
      ) : null}
    </span>
  );
}

/** 表の見出しの補足(何の量か・いつ戻るか) */
const SECTION_NOTES = { daily: "UTC 0 時に戻る", capacity: "前日以降に観測した最大の量" } as const;

/**
 * backlog D10: 使用状況の表(設定 > システム > Cloudflare 使用状況。ホームの要約は件数を絞って使う)。
 * 1 日の量と保存量を別の表・別の枠にする(分母の意味が違うため)。表の分け方と出す列は lib/usage.ts の usageSections、
 * 各行に何を出すかは usageRows が決め、ここは描くだけ
 */
export function UsageTable({ report, limit }: { report: UsageReport; limit?: UsageResource[] }) {
  const note = paidNote(report);
  const sections = usageSections(report, limit);
  // 表どうしの列を揃える: どれかの表にある列は全部の表に置き、その列が無い表は空のセルにする(列の幅は Usage.module.css で固定)
  const cols = { ratio: sections.some((x) => x.ratio), status: sections.some((x) => x.status), projection: sections.some((x) => x.projection) };
  return (
    <div data-testid="usage-table">
      {note ? (
        <p className={styles.note}>
          {note}
          <a href="https://developers.cloudflare.com/workers/platform/pricing/" target="_blank" rel="noreferrer">料金</a>
        </p>
      ) : null}
      {sections.map((section) => (
        // 表ごとに枠を分ける(1 枚の枠に 2 つの表を続けると、2 つ目の見出しが 1 つ目の行の続きに見える)
        // 列の幅を固定するので、狭い画面では枠の中で横にスクロールさせる(card-flush の overflow: hidden で切れないように)
        <div key={section.kind} className="card-flush" style={{ overflowX: "auto" }} data-testid={`usage-table-${section.kind}`}>
          <table className={styles.fixed}>
            <caption className={styles.caption}>
              {section.title}
              <span className="muted">({SECTION_NOTES[section.kind]})</span>
            </caption>
            <thead>
              <tr>
                <th>資源</th>
                <th className={`${styles.num} ${styles.colAmount}`}>{section.header}</th>
                {cols.ratio ? <th className={`${styles.num} ${styles.colRatio}`}>{section.ratio ? "割合" : ""}</th> : null}
                {cols.status ? <th className={styles.colStatus}>{section.status ? "状態" : ""}</th> : null}
                {cols.projection ? <th className={styles.colProjection}>{section.projection ? "上限に達する見込み" : ""}</th> : null}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.label}
                    {row.breakdown ? <div className="muted">{row.breakdown}</div> : null}
                  </td>
                  <td className={styles.num}>
                    {row.used}
                    {row.cap ? <span className="muted"> / {row.cap}</span> : null}
                  </td>
                  {cols.ratio ? (
                    <td className={styles.num}>
                      <span className={styles.ratio}>
                        {row.meter ? <Meter meter={row.meter} /> : null}
                        <span className={styles.percent}>{row.ratioText}</span>
                      </span>
                    </td>
                  ) : null}
                  {cols.status ? <td>{row.status ? <span className={styles[TONE_CLASS[row.status.tone]]}>{row.status.text}</span> : null}</td> : null}
                  {cols.projection ? <td>{row.projectedAt ? <><LocalTime at={row.projectedAt} kind="time" /> ごろ</> : ""}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="muted">
        取得 <LocalTime at={report.asOf} kind="time" /> · 次のリセット <LocalTime at={report.resetAt} kind="time" />
      </p>
    </div>
  );
}
