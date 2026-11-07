// Builds DOM for the side bar views. Text always goes in as text nodes, so
// workflow logs and GitHub data can't inject markup.

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = String(value);
    else if (key in el && typeof value !== 'string') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}
