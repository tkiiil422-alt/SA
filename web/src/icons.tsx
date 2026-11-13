import type { ReactNode } from 'react'

/* One hand-drawn 24px stroke set, so every icon in the console has the same weight and corner. */
const dot = (cx: number, cy: number, r = 2) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
const P: Record<string, ReactNode> = {
  today: <><path d="M4 7h16M4 12h16M4 17h16" opacity=".4" />{dot(14.5, 7)}{dot(8.5, 12)}{dot(16.5, 17)}</>,
  tickets: <><path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z" /><path d="M14.5 6.5v11" strokeDasharray="1.6 2.2" /></>,
  new: <path d="M12 5v14M5 12h14" />,
  projects: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  councils: <><path d="M4 5h10a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H8.5L5.5 16v-2.5H4A1.5 1.5 0 0 1 2.5 12V6.5A1.5 1.5 0 0 1 4 5z" /><path d="M18.5 8.5h1A1.5 1.5 0 0 1 21 10v5.5a1.5 1.5 0 0 1-1.5 1.5H19v2.5L16 17h-3.5" /></>,
  novels: <><path d="M12 6.5c-1.6-1.2-3.8-1.8-7.5-1.5v12.5c3.7-.3 5.9.3 7.5 1.5 1.6-1.2 3.8-1.8 7.5-1.5V5c-3.7-.3-5.9.3-7.5 1.5z" /><path d="M12 6.5V19" /></>,
  fanqie: <path d="M20.5 3.5 10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4z" />,
  usage: <path d="M4 20h16M6.5 20v-6M11.5 20V8M16.5 20v-9" />,
  secrets: <><circle cx="8" cy="15.5" r="3.8" /><path d="m10.8 12.8 8.2-8.3M15.5 8l2.2 2.2M13.3 10.2l1.7 1.7" /></>,
  connections: <path d="m9.5 14.5 5-5M10.6 6.6l1.6-1.6a4 4 0 0 1 5.7 5.7l-1.6 1.6M13.4 17.4l-1.6 1.6a4 4 0 0 1-5.7-5.7l1.6-1.6" />,
  settings: <><path d="M4 7.5h8.5M16.5 7.5H20M4 16.5h3.5M11.5 16.5H20" /><circle cx="14.5" cy="7.5" r="2" /><circle cx="9.5" cy="16.5" r="2" /></>,
  pi: <><rect x="4" y="5" width="16" height="14" rx="2.5" /><path d="m8 10 2.5 2L8 14M12.5 14.5H16" /></>,
  system: <><rect x="4" y="4.5" width="16" height="6.5" rx="1.6" /><rect x="4" y="13" width="16" height="6.5" rx="1.6" />{dot(8, 7.75, 1.1)}{dot(8, 16.25, 1.1)}</>,
  events: <path d="M3 12h4l2.5-6.5 4 13 2.5-6.5H21" />,
  decisions: <path d="M12 4.5V19M8 19h8M5 8h14M5 8l-2.5 5.5a2.5 2.5 0 0 0 5 0zM19 8l-2.5 5.5a2.5 2.5 0 0 0 5 0z" />,
  more: <>{dot(5.5, 12, 1.6)}{dot(12, 12, 1.6)}{dot(18.5, 12, 1.6)}</>,
  logout: <path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h9.5" />,
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  chev: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  coin: <><circle cx="12" cy="12" r="8.5" /><path d="M14.6 9.3c-.5-.8-1.4-1.3-2.6-1.3-1.5 0-2.6.8-2.6 1.9 0 1.3 1.1 1.7 2.6 2.1 1.6.4 2.7.9 2.7 2.2 0 1.2-1.1 2-2.7 2-1.2 0-2.2-.5-2.7-1.3M12 6.3V8M12 16.2V18" /></>,
  model: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" /></>,
  send: <path d="M5 12h13M12.5 6l6 6-6 6" />,
  check: <path d="m5.5 12.5 4 4L18.5 7.5" />,
  x: <path d="M7 7l10 10M17 7 7 17" />,
  alert: <><path d="M12 4.5 20.5 19h-17z" /><path d="M12 10v4" />{dot(12, 16.6, 1.1)}</>,
  pulse: <><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="7.5" opacity=".35" /></>,
  pause: <path d="M9 6v12M15 6v12" />,
  server: <><rect x="4" y="4.5" width="16" height="15" rx="2" /><path d="M8 9h8M8 13h5" /></>,
}

export function Icon({ name, size = 18, stroke = 1.7 }: { name: string; size?: number; stroke?: number }) {
  return <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{P[name] ?? null}</svg>
}

/**
 * The mark: three rails with a bead on each, set at different points: three workers at different stages of their work.
 * Colours come from CSS (.logo__bg / .logo__ink), so the sidebar and dark mode can recolour it.
 */
export function Logo({ size = 28 }: { size?: number }) {
  return <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect className="logo__bg" width="32" height="32" rx="9" />
    <path className="logo__rail" d="M8.5 10.5h15M8.5 16h15M8.5 21.5h15" strokeWidth="2" strokeLinecap="round" />
    <circle className="logo__ink" cx="19.5" cy="10.5" r="3.1" />
    <circle className="logo__ink" cx="12.5" cy="16" r="3.1" />
    <circle className="logo__ink" cx="17" cy="21.5" r="3.1" />
  </svg>
}
