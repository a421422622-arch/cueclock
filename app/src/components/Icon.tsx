import type { SVGProps } from 'react';

/** 统一的线性图标（24×24 视图、1.7 描边、随文字颜色）。只放界面里用到的，需要新的往里加。 */
const PATHS = {
  play: <path d="M7 4.5v15l12-7.5-12-7.5z" />,
  pause: <><rect x="6.5" y="4.5" width="4" height="15" rx="1.2" /><rect x="13.5" y="4.5" width="4" height="15" rx="1.2" /></>,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2.2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  settings: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5" />,
  lock: <><rect x="4.5" y="11" width="15" height="10" rx="2.2" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" /></>,
  unlock: <><rect x="4.5" y="11" width="15" height="10" rx="2.2" /><path d="M8 11V7.5a4 4 0 0 1 7.6-1.7" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  timeline: <path d="M3.5 6.5h9M7.5 12h13M3.5 17.5h7" />,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.8" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.8" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.8" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.8" /></>,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  device: <><rect x="3" y="4" width="18" height="12" rx="2.2" /><path d="M8 20h8M12 16v4" /></>,
  terminal: <><path d="m5 8 4 4-4 4" /><path d="M12 17h7" /></>,
  layers: <><path d="m12 3.5 8.5 4.8L12 13 3.5 8.3 12 3.5z" /><path d="m3.5 12.5 8.5 4.8 8.5-4.8" /></>,
  zap: <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8z" />,
  alert: <><path d="M12 3.5 2.5 20h19L12 3.5z" /><path d="M12 10v4.5M12 17.4v.1" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  edit: <path d="M4 20h4L19.5 8.5l-4-4L4 16v4z" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  network: <><circle cx="12" cy="5" r="2.3" /><circle cx="5" cy="19" r="2.3" /><circle cx="19" cy="19" r="2.3" /><path d="M12 7.3V12M12 12l-7 4.7M12 12l7 4.7" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h9.5a6 6 0 0 1 0 12H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9h-9.5a6 6 0 0 0 0 12H13" /></>,
  hand: <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V11m0-3.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L4 15.5a1.6 1.6 0 0 1 2.7-1.6L8 15.5V12z" />,
  pad: <><rect x="3" y="3" width="18" height="18" rx="3.5" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
  more: <><circle cx="5" cy="12" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="19" cy="12" r="1.1" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name]}
    </svg>
  );
}
