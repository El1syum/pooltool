/** Copy from a user gesture on HTTPS/platform hosts and the plain HTTP preview.
 * Returns false without leaving a temporary field or stealing focus/selection.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof text !== 'string' || !text) return false
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* Permission/embedding policy may reject the modern API. */ }
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false

  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null
  const inputSelection = input && input.selectionStart != null
    ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const anchor = selection?.anchorNode, focus = selection?.focusNode
  const anchorOffset = selection?.anchorOffset || 0, focusOffset = selection?.focusOffset || 0
  const scroll = { x: window.scrollX, y: window.scrollY }
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.tabIndex = -1
  field.setAttribute('aria-hidden', 'true')
  field.dataset.clipboardTemporary = 'true'
  field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;-webkit-user-select:text;user-select:text;'
  let copied = false
  try {
    document.body.append(field)
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, text.length)
    copied = document.execCommand('copy') === true
  } catch { /* Browsers may disallow even user-initiated legacy copying. */ }
  finally {
    field.remove()
    try {
      if (focused?.isConnected) {
        focused.focus({ preventScroll: true })
      }
      if (selection) {
        selection.removeAllRanges()
        if (ranges.length === 1 && anchor?.isConnected && focus?.isConnected && typeof selection.setBaseAndExtent === 'function') {
          selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
        } else for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range)
      }
      // Restoring the document Selection can reset a focused input's caret in
      // Chromium; restore its independent selection only after that operation.
      if (input?.isConnected && inputSelection) input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction || undefined)
      if (window.scrollX !== scroll.x || window.scrollY !== scroll.y) window.scrollTo(scroll.x, scroll.y)
    } catch { /* The copy event may have replaced or removed the old selection. */ }
  }
  return copied
}
