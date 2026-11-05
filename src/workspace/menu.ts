// A VS Code-style dropdown / context menu: arrow keys move, Enter or Space
// runs, Escape or a click outside closes, and focus returns where it was.

export interface MenuItem {
  label: string;
  /** Shown on the right, e.g. "Ctrl+B". */
  keybinding?: string;
  disabled?: boolean;
  run: () => void;
}

export type MenuEntry = MenuItem | 'separator';

export interface MenuOptions {
  /** Where the menu goes: below an element, or at a point (context menus). */
  anchor: HTMLElement | { x: number; y: number };
  /** The element the menu is added to (so its styles apply). */
  container: HTMLElement;
  label: string;
  onClose?: () => void;
}

let closeOpen: (() => void) | null = null;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
/** "Ctrl+B" on Windows and Linux, "⌘B" on macOS. */
export const keys = (combo: string) =>
  isMac()
    ? combo.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥').replace('Enter', '↩')
    : combo;

export function showMenu(entries: MenuEntry[], options: MenuOptions): () => void {
  closeOpen?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const menu = document.createElement('div');
  menu.className = 'wb-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', options.label);
  menu.tabIndex = -1;

  const items: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if (entry === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'wb-menu-separator';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }
    const button = document.createElement('button');
    button.className = 'wb-menu-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.disabled = !!entry.disabled;
    const label = document.createElement('span');
    label.className = 'wb-menu-label';
    label.textContent = entry.label;
    button.appendChild(label);
    if (entry.keybinding) {
      const kb = document.createElement('span');
      kb.className = 'wb-menu-keybinding';
      kb.textContent = keys(entry.keybinding);
      button.appendChild(kb);
    }
    button.addEventListener('click', () => {
      close(false);
      entry.run();
    });
    button.addEventListener('mouseenter', () => !button.disabled && button.focus());
    menu.appendChild(button);
    if (!entry.disabled) items.push(button);
  }

  options.container.appendChild(menu);

  // Position: below the anchor, or at the point; kept inside the window.
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  let x: number;
  let y: number;
  if (options.anchor instanceof HTMLElement) {
    const a = options.anchor.getBoundingClientRect();
    x = a.left;
    y = a.bottom + 2;
    if (a.right + rect.width < innerWidth && a.width < 60) {
      // An icon button at the window's edge (the activity bar): open beside it.
      x = a.right + 2;
      y = a.top;
    }
  } else {
    ({ x, y } = options.anchor);
  }
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;

  const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
  const onKey = (e: KeyboardEvent) => {
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') focusAt(current + 1);
    else if (e.key === 'ArrowUp') focusAt(current < 0 ? -1 : current - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(-1);
    else if (e.key === 'Escape' || e.key === 'Tab') close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointer = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  const onBlur = () => close(false);

  let closed = false;
  function close(restoreFocus: boolean) {
    if (closed) return;
    closed = true;
    closeOpen = null;
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    if (restoreFocus) previousFocus?.focus();
    options.onClose?.();
  }

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  closeOpen = () => close(false);
  (items[0] ?? menu).focus();
  return closeOpen;
}
