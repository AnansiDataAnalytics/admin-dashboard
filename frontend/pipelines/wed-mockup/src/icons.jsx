// icons.jsx — small inline SVG icon set (stroke-based, currentColor).
const Svg = ({ children, size = 16, sw = 1.6, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth={sw} strokeLinecap="round"
       strokeLinejoin="round" {...rest}>{children}</svg>
);

const Icon = {
  server: (p) => <Svg {...p}><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></Svg>,
  sliders: (p) => <Svg {...p}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/></Svg>,
  download: (p) => <Svg {...p}><path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></Svg>,
  cpu: (p) => <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2"/></Svg>,
  shield: (p) => <Svg {...p}><path d="M12 3l7 3v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/></Svg>,
  upload: (p) => <Svg {...p}><path d="M12 21V9M7 13l5-5 5 5M5 3h14"/></Svg>,
  broom: (p) => <Svg {...p}><path d="M14 3l7 7M19 8l-8.5 8.5M10.5 16.5l-3-3M9 18l-4 3M12 21l-4-4-4 4M7 14l3 3"/></Svg>,
  check: (p) => <Svg {...p}><path d="M5 12l4.5 4.5L19 7"/></Svg>,
  x: (p) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18"/></Svg>,
  skip: (p) => <Svg {...p}><path d="M6 5l8 7-8 7zM17 5v14"/></Svg>,
  dot: (p) => <Svg {...p}><circle cx="12" cy="12" r="4"/></Svg>,
  clock: (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></Svg>,
  calendar: (p) => <Svg {...p}><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/></Svg>,
  tag: (p) => <Svg {...p}><path d="M3 12l8-8h7a1 1 0 011 1v7l-8 8a2 2 0 01-3 0l-5-5a2 2 0 010-3z"/><circle cx="15.5" cy="8.5" r="1.3"/></Svg>,
  user: (p) => <Svg {...p}><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></Svg>,
  hand: (p) => <Svg {...p}><path d="M8 11V5.5a1.5 1.5 0 013 0V11M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 3.5-2.5 7-6 7-2.5 0-4-1-5.5-3L4 14a1.4 1.4 0 012-2l2 2"/></Svg>,
  bolt: (p) => <Svg {...p}><path d="M13 3L5 13h6l-1 8 8-10h-6z"/></Svg>,
  box: (p) => <Svg {...p}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></Svg>,
  file: (p) => <Svg {...p}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 16h6"/></Svg>,
  chevron: (p) => <Svg {...p}><path d="M9 6l6 6-6 6"/></Svg>,
  arrowRight: (p) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6"/></Svg>,
  repeat: (p) => <Svg {...p}><path d="M4 9a6 6 0 016-6h7M20 7l-3-4-3 4M20 15a6 6 0 01-6 6H7M4 17l3 4 3-4"/></Svg>,
  cloud: (p) => <Svg {...p}><path d="M7 18a4 4 0 01-.5-7.97A5 5 0 0116 9.5a3.5 3.5 0 011 6.86"/><path d="M7 18h10"/></Svg>,
  external: (p) => <Svg {...p}><path d="M14 5h5v5M19 5l-7 7M11 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-5"/></Svg>,
  flask: (p) => <Svg {...p}><path d="M9 3h6M10 3v6l-5 9a1.5 1.5 0 001.3 2.3h11.4A1.5 1.5 0 0019 18l-5-9V3"/><path d="M7.5 14h9"/></Svg>,
  layers: (p) => <Svg {...p}><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></Svg>,
};

window.Icon = Icon;
window.StatusGlyph = function StatusGlyph({ status, size = 16 }) {
  if (status === "passed") return <Icon.check size={size} sw={2.2} />;
  if (status === "failed") return <Icon.x size={size} sw={2.2} />;
  if (status === "skipped") return <Icon.skip size={size} sw={1.8} />;
  if (status === "running") return <Icon.dot size={size} />;
  return <Icon.dot size={size} />; // pending
};
