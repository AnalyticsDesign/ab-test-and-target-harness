import type { ReactNode } from "react";

/** 16px グリッド・線幅 1.4 の線画アイコン。依存を足さないため inline SVG をここに集める。色は currentColor */
const PATHS = {
  flask: (<><path d="M6 2h4M7 2v4L3.5 12.5A1 1 0 0 0 4.4 14h7.2a1 1 0 0 0 .9-1.5L9 6V2" /><path d="M5 10h6" /></>),
  target: (<><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r=".6" /></>),
  venn: (<><circle cx="6" cy="8" r="4" /><circle cx="10" cy="8" r="4" /></>),
  link: (<><path d="M6.5 9.5l3-3" /><path d="M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1" /><path d="M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" /></>),
  history: (<><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.5 2.5v2.5H5" /><path d="M8 5v3l2 1.5" /></>),
  gear: (<><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>),
  grid: (<><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></>),
  users: (<><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5" /><path d="M10.5 3.6a2 2 0 0 1 0 3.8M12 9.8c1.1.5 1.8 1.6 2 3.2" /></>),
  chevrons: <path d="M5.5 6L8 3.5 10.5 6M5.5 10L8 12.5 10.5 10" />,
  plus: <path d="M8 3v10M3 8h10" />,
  upload: (<><path d="M8 11V3M4.5 6.5L8 3l3.5 3.5" /><path d="M3 13h10" /></>),
  sun: (<><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  monitor: (<><rect x="2" y="3" width="12" height="8" rx="1.2" /><path d="M6 14h4M8 11v3" /></>),
  copy: (<><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8" /></>),
  arrow: <path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" />,
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  home: <path d="M2.5 7.5L8 3l5.5 4.5M4 6.5v6.5h8V6.5" />,
  key: (<><circle cx="5.2" cy="10.8" r="2.7" /><path d="M7.2 8.8l5.8-5.8M11 5l1.8 1.8M9.6 6.4l1.4 1.4" /></>),
  eye: (<><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>),
  shield: <path d="M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z" />,
  stack: (<><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3M2 11l6 3 6-3" /></>),
  logout: <path d="M6 2.5H3.5v11H6M10 5l3 3-3 3M13 8H6" />,
  left: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  gauge: (<><path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" /><path d="M8 11.5l2.6-3.6" /></>),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {PATHS[name]}
    </svg>
  );
}
