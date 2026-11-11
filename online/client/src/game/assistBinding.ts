/** Assist is a hold-to-show keyboard action; it never owns a mouse button. */
export const DEFAULT_ASSIST_BINDING = 'ControlLeft'

export function modifierFamily(code: string): string | null {
  return /^(Control|Alt|Shift|Meta)(Left|Right)$/.exec(code)?.[1] || null
}

export function isAssistKeyboardBinding(value: unknown): value is string {
  return typeof value === 'string' && /^(?:Key[A-Z]|Digit\d|F(?:[1-9]|1\d|2[0-4])|Arrow(?:Left|Right|Up|Down)|(?:Control|Alt|Shift|Meta)(?:Left|Right)|Space|Enter|NumpadEnter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|Numpad(?:\d|Add|Subtract|Multiply|Divide|Decimal|Equal|Comma))$/.test(value)
}

export function normalizeAssistBinding(value: unknown): string {
  return isAssistKeyboardBinding(value) ? value : DEFAULT_ASSIST_BINDING
}

export function matchesAssistBinding(code: string, configured: unknown, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}): boolean {
  const binding = normalizeAssistBinding(configured)
  const family = modifierFamily(binding)
  // A letter assignment never consumes native copy/paste or other Ctrl/Meta
  // chords. A configured modifier itself still accepts both physical sides.
  if (!family && (modifiers.ctrlKey || modifiers.metaKey)) return false
  return family ? modifierFamily(code) === family : code === binding
}

export function bindingLabel(value: string | undefined): string {
  if (!value) return 'Не назначено'
  const family = modifierFamily(value)
  if (family) return family === 'Control' ? 'Ctrl' : family === 'Meta' ? 'Meta' : family
  return value.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', '↔ ')
    .replace('Mouse0', 'ЛКМ').replace('Mouse1', 'СКМ').replace('Mouse2', 'ПКМ').replace('Space', 'Пробел')
}

/** Modifier-family conflicts include e.g. assist CtrlLeft vs another CtrlRight. */
export function findBindingConflicts(bindings: Record<string, unknown>): Array<[string, string, string]> {
  const seen = new Map<string, string>()
  const conflicts: Array<[string, string, string]> = []
  for (const [action, value] of Object.entries(bindings)) {
    if (typeof value !== 'string' || !value) continue
    const key = modifierFamily(value) || value
    const previous = seen.get(key)
    if (previous) conflicts.push([action, previous, bindingLabel(value)])
    else seen.set(key, action)
  }
  return conflicts
}
