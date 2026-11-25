import type { ReactNode } from 'react'

/* One hand-drawn 24px stroke set, so every icon in the console has the same weight and corner. */
const dot = (cx: number, cy: number, r = 2) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
const P: Record<string, ReactNode> = {
  today: <><path d="M4 7h16M4 12h16M4 17h16" opacity=".4" />{dot(14.5, 7)}{dot(8.5, 12)}{dot(16.5, 17)}</>,
  director: <><rect x="4" y="4.5" width="16" height="12.5" rx="3" /><path d="M9 20.5h6M12 17v3.5" />{dot(9.2, 10.5, 1.3)}{dot(14.8, 10.5, 1.3)}</>,
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
  devenv: <><path d="m7 8-3.5 4L7 16M17 8l3.5 4L17 16M14 5.5 10 18.5" /></>,
  pentest: <><path d="M12 3.5 5 6.5v5.5c0 4.5 3 7.6 7 8.8 4-1.2 7-4.3 7-8.8V6.5z" /><circle cx="12" cy="11.5" r="2.2" /><path d="M12 7.5v1.5M12 14v1.5M8 11.5h1.5M14.5 11.5H16" /></>,
  defense: <><path d="M12 3.5 5 6.5v5.5c0 4.5 3 7.6 7 8.8 4-1.2 7-4.3 7-8.8V6.5z" /><path d="m9 12.2 2.1 2.1 4.1-4.3" /></>,
  wechat: <><path d="M9.5 6C5.9 6 3 8.4 3 11.3c0 1.6.9 3 2.3 4l-.6 2.1 2.2-1.1c.8.2 1.7.4 2.6.4 3.6 0 6.5-2.4 6.5-5.4S13.1 6 9.5 6z" /><path d="M16 10.6c2.8.4 5 2.3 5 4.7 0 1.3-.7 2.5-1.8 3.3l.5 1.8-1.9-.9c-.7.2-1.4.3-2.2.3-2.4 0-4.4-1.2-5.1-2.9" />{dot(7.5, 10.7, 1.1)}{dot(11.5, 10.7, 1.1)}</>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4.5 7 7.5 5.5L19.5 7" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15" /></>,
  copy: <><rect x="9" y="9" width="10.5" height="10.5" rx="2" /><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5" /></>,
  download: <><path d="M12 4.5v10.5m0 0-3.5-3.5M12 15l3.5-3.5M5 19h14" /></>,
  play: <path d="M7.5 5.5 18.5 12l-11 6.5z" />,
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
  memory: <><path d="M9.5 4.5a3.5 3.5 0 0 0-3.5 3.5v.5A3 3 0 0 0 4 11.3a3 3 0 0 0 1.8 2.7v.5a3.5 3.5 0 0 0 3.7 3.5h.5V4.5zM14.5 4.5a3.5 3.5 0 0 1 3.5 3.5v.5A3 3 0 0 1 20 11.3a3 3 0 0 1-1.8 2.7v.5a3.5 3.5 0 0 1-3.7 3.5H14V4.5z" /></>,
  schedules: <><circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.8 1.8M9 3.5h6M12 3.5V5.5" /></>,
  server: <><rect x="4" y="4.5" width="16" height="15" rx="2" /><path d="M8 9h8M8 13h5" /></>,
  arrowUp: <path d="M12 19V5.5M6.5 11 12 5.5 17.5 11" />,
  menu: <path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15" />,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.8 12h16.4M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z" /></>,
  feishu: <path d="M5 6.5 13 4l6 4.5-6.5 4.5L5 6.5zm0 0 4.5 11.5 9.5-5.5-5-1.5" />,
  qq: <><path d="M12 4.2c-3.3 0-5.4 2.5-5.4 5.7 0 .8.1 1.4.2 1.9-.9 1-1.6 2.3-1.6 3.5 0 .8.4 1.3.9 1.3.5 0 .9-.4 1.3-.9.7 1.3 1.9 2.2 3.3 2.5-.9.4-1.5 1-1.5 1.7 0 .7.8 1.1 2.8 1.1s2.8-.4 2.8-1.1c0-.7-.6-1.3-1.5-1.7 1.4-.3 2.6-1.2 3.3-2.5.4.5.8.9 1.3.9.5 0 .9-.5.9-1.3 0-1.2-.7-2.5-1.6-3.5.1-.5.2-1.1.2-1.9 0-3.2-2.1-5.7-5.4-5.7z" /></>,
  grid: <><rect x="4.5" y="4.5" width="6" height="6" rx="1.5" /><rect x="13.5" y="4.5" width="6" height="6" rx="1.5" /><rect x="4.5" y="13.5" width="6" height="6" rx="1.5" /><rect x="13.5" y="13.5" width="6" height="6" rx="1.5" /></>,
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  panelRight: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M15 4.5v15" /></>,
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
