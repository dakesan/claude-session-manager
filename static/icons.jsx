// Inline SVG icons. Stroke-based, 1.5px, currentColor.
const Ico = {
  search: (p) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="7" cy="7" r="4.5" /><path d="m13.5 13.5-3-3" />
    </svg>
  ),
  plus: (p) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" {...p}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  ),
  x: (p) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
  sun: (p) => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.3 3.3l1.05 1.05M11.65 11.65l1.05 1.05M3.3 12.7l1.05-1.05M11.65 4.35l1.05-1.05" />
    </svg>
  ),
  moon: (p) => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z" />
    </svg>
  ),
  pause: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" {...p}>
      <rect x="4.5" y="3.5" width="2.5" height="9" rx=".5" />
      <rect x="9" y="3.5" width="2.5" height="9" rx=".5" />
    </svg>
  ),
  play: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" {...p}>
      <path d="M4.5 3.5v9l8-4.5z" />
    </svg>
  ),
  stop: (p) => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" {...p}>
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  ),
  refresh: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.7-3.5M13.5 8a5.5 5.5 0 0 1-9.7 3.5" />
      <path d="M12 1.5v3h-3M4 14.5v-3h3" />
    </svg>
  ),
  trash: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" />
    </svg>
  ),
  terminal: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3.5" />
    </svg>
  ),
  link: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7 4.5H4.5a3 3 0 0 0 0 6H7M9 4.5h2.5a3 3 0 0 1 0 6H9M5.5 7.5h5" />
    </svg>
  ),
  ext: (p) => (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M7 9l5.5-5.5" />
    </svg>
  ),
  dots: (p) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" {...p}>
      <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
    </svg>
  ),
  filter: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M2 3.5h12M4 8h8M6.5 12.5h3" />
    </svg>
  ),
  list: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...p}>
      <path d="M3 4h10M3 8h10M3 12h10" />
    </svg>
  ),
  grid: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  ),
  copy: (p) => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
      <path d="M3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" />
    </svg>
  ),
  branch: (p) => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}>
      <circle cx="4" cy="3" r="1.4" /><circle cx="4" cy="13" r="1.4" /><circle cx="12" cy="6" r="1.4" />
      <path d="M4 4.5v7M4 8h4.5a3 3 0 0 0 3-3V7.4" />
    </svg>
  ),
  cpu: (p) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" {...p}>
      <rect x="4" y="4" width="8" height="8" rx="1" /><rect x="6" y="6" width="4" height="4" rx=".5" />
      <path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2" />
    </svg>
  ),
  check: (p) => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="m3 8.5 3.5 3.5 7-7" />
    </svg>
  ),
  arrowRight: (p) => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
};
window.Ico = Ico;
