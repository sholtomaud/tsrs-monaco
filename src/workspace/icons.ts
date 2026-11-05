// Icons for the workbench: VS Code's codicons (the font Monaco already
// loads) for actions and chevrons, and small Seti-style badges for files.

/** Codicon glyphs used here (from monaco-editor's codicons library). */
export const CODICON = {
  files: '',
  menu: '',
  chevronRight: '',
  chevronDown: '',
  newFile: '',
  collapseAll: '',
  close: '',
  play: '',
  beaker: '',
  debugStop: '',
  discard: '',
  trash: '',
  edit: '',
  error: '',
  warning: '',
  check: '',
  github: '',
  book: '',
  layoutSidebarLeft: '',
  layoutPanel: '',
  file: '',
} as const;

export type CodiconName = keyof typeof CODICON;

export function codicon(name: CodiconName, extraClass = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `codicon ${extraClass}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.textContent = CODICON[name];
  return span;
}

interface Badge {
  /** Background colour; omitted for a glyph drawn in `color` on no background. */
  fill?: string;
  color: string;
  text: string;
  size?: number;
}

const BADGES: [RegExp, Badge][] = [
  [/\.d\.(m|c)?ts$/, { color: '#3178c6', text: 'D', size: 9 }],
  [/\.test\.(m|c)?tsx?$/, { fill: '#2e9e5b', color: '#fff', text: 'TS', size: 7 }],
  [/\.(m|c)?tsx?$/, { fill: '#3178c6', color: '#fff', text: 'TS', size: 7 }],
  [/\.(m|c)?jsx?$/, { fill: '#e8d44d', color: '#1e1e1e', text: 'JS', size: 7 }],
  [/(^|\/)package\.json$/, { fill: '#cb3837', color: '#fff', text: 'n', size: 10 }],
  [/(^|\/)tsconfig\.json$/, { color: '#3178c6', text: '{}', size: 10 }],
  [/\.json$/, { color: '#c9a52a', text: '{}', size: 10 }],
  [/\.html?$/, { color: '#e44d26', text: '<>', size: 9 }],
  [/\.css$/, { color: '#42a5f5', text: '#', size: 12 }],
  [/\.md$/, { color: '#519aba', text: 'M', size: 10 }],
  [/\.svg$/, { color: '#d9822b', text: '◆', size: 10 }],
  [/\.wgsl$/, { fill: '#7e57c2', color: '#fff', text: 'W', size: 8 }],
];

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A 16×16 icon for a file, by name; `null` means use the generic file codicon. */
export function fileIconSvg(path: string): string | null {
  const badge = BADGES.find(([pattern]) => pattern.test(path))?.[1];
  if (!badge) return null;
  const size = badge.size ?? 8;
  const rect = badge.fill ? `<rect x="1" y="2" width="14" height="12" rx="2" fill="${badge.fill}"/>` : '';
  return (
    `<svg class="file-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${rect}` +
    `<text x="8" y="8.5" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" ` +
    `font-weight="700" font-size="${size}" fill="${badge.color}">${escape(badge.text)}</text></svg>`
  );
}

export function fileIcon(path: string): Element {
  const svg = fileIconSvg(path);
  if (!svg) return codicon('file', 'file-icon file-icon-generic');
  const holder = document.createElement('span');
  holder.innerHTML = svg;
  return holder.firstElementChild!;
}
