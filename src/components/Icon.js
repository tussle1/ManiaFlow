/**
 * Icons — one 24×24 stroke set, drawn inline.
 *
 * No icon font and no image requests: a font is a blocking network dependency and a sprite
 * sheet is a second thing to keep in sync. Every icon here is a path list on a shared grid
 * with a shared stroke width, which is what makes them read as one family at 14px.
 *
 * Icons are decorative by default (`aria-hidden`). An icon-only button must carry its own
 * accessible name — `Button` does that for you.
 */

const PATHS = {
  dashboard: ['M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6v-9h-6v9zm0-16v5h6V4h-6z'],
  library: ['M4 5h5v15H4V5zm7 0h4v15h-4V5zm7.5 1.2l3.4 12.6-2.9.8-3.4-12.6 2.9-.8z'],
  practice: ['M4 4h16v12H4V4zm4 16h8M12 16v4'],
  timing: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3.5 2'],
  input: ['M3 6h18v12H3V6zm3 3.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 13h.01M9.5 13h5'],
  statistics: ['M4 20V10m5 10V4m5 16v-7m5 7V8'],
  settings: ['M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5'],
  play: ['M7 4.5v15l13-7.5-13-7.5z'],
  pause: ['M8.5 4.5v15M15.5 4.5v15'],
  stop: ['M6 6h12v12H6z'],
  restart: ['M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm5.2-1.8L21 21'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M4.5 12.5l5 5 10-11'],
  alert: ['M12 3.5L1.8 20.5h20.4L12 3.5zM12 10v4.5M12 17.6h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.6h.01'],
  shield: ['M12 3l7.5 3v6c0 4.6-3.1 8-7.5 9.4C7.6 20 4.5 16.6 4.5 12V6L12 3zm-2.6 9.2l2 2 3.6-4'],
  chevronDown: ['M5.5 9l6.5 6.5L18.5 9'],
  chevronRight: ['M9 5.5l6.5 6.5L9 18.5'],
  chevronLeft: ['M15 5.5L8.5 12l6.5 6.5'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  download: ['M12 3.5v12m0 0l-4.5-4.5M12 15.5l4.5-4.5M4 20h16'],
  upload: ['M12 20.5v-12m0 0L7.5 13M12 8.5L16.5 13M4 4h16'],
  trash: ['M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 10.5v6M13.5 10.5v6'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4'],
  plug: ['M9 3v6M15 3v6M6.5 9h11v3a5.5 5.5 0 0 1-11 0V9zM12 17.5V21'],
  link: ['M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.5 6.3M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.3-1.3'],
  external: ['M14 4h6v6M20 4l-8.5 8.5M18 14v5.5H4.5V6H10'],
  folder: ['M3.5 6.5h5.8l2 2.5h9.2v10H3.5v-12.5z'],
  note: ['M9 18V5.5l10-2V16M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  wave: ['M2 12h2.5l2-6 3 15 3-11 2 4h7.5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-14v5l3.5 2'],
  loop: ['M4 9h13l-3-3m3 3l-3 3M20 15H7l3 3m-3-3l3-3'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0-3.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z'],
  keyboard: ['M2.5 6h19v12h-19V6zm3 3.5h.01M9 9.5h.01M12.5 9.5h.01M16 9.5h.01M18.5 9.5h.01M5.5 13h.01M18.5 13h.01M8.5 13h7'],
  sliders: ['M4 8h9M17 8h3M4 16h3M11 16h9M15 5.5v5M9 13.5v5'],
  layers: ['M12 3l9 5-9 5-9-5 9-5zm9 9l-9 5-9-5m18 4.5l-9 5-9-5'],
  bolt: ['M13.5 2.5L4 14h6.5L10 21.5 20 10h-6.8l.3-7.5z'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  copy: ['M9 9h11v11H9V9zm-4.5 6H3V4h11v1.5'],
  flag: ['M5.5 21V4h13l-2.5 4L18.5 12h-13'],
  gauge: ['M4 17a9 9 0 1 1 16 0M12 17l4-6'],
  save: ['M5 4h11l3 3v13H5V4zm3 0v6h8V4M8 20v-6h8v6'],
  power: ['M12 3.5v8M7.5 6.8a7.5 7.5 0 1 0 9 0'],
  question: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4M12 17.2h.01'],
  list: ['M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01'],
  grid: ['M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z'],
  arrowRight: ['M4 12h15m0 0l-5.5-5.5M19 12l-5.5 5.5'],
  arrowLeft: ['M20 12H5m0 0l5.5-5.5M5 12l5.5 5.5'],
  sort: ['M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3'],
  filter: ['M3.5 5.5h17l-6.5 7.5V20l-4-2.5v-4.5L3.5 5.5z'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5V10H9M12 8v4.5l3.5 2'],
  pauseCircle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 8.5v7M14 8.5v7'],
  playCircle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM10 8.2l6 3.8-6 3.8V8.2z'],
  stopCircle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9h6v6H9z'],
  bug: ['M8 7.5a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0v-4zM4 10h4M16 10h4M4.5 15.5l3-1.5M19.5 15.5l-3-1.5M9 4.5L7.5 3M15 4.5L16.5 3M12 15.5V21'],
};

/**
 * Render an icon.
 * @param {string} name a key of the table above
 * @param {number|{size?:number, class?:string, title?:string}} [options]
 * @returns {SVGElement}
 */
export function icon(name, options = {}) {
  const config = typeof options === 'number' ? { size: options } : options;
  const size = config.size || 16;
  const paths = PATHS[name] || PATHS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(config.strokeWidth || 1.7));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', config.title ? 'false' : 'true');
  if (config.class) svg.setAttribute('class', config.class);
  if (config.title) {
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = config.title;
    svg.append(title);
  }
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}


