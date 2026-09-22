import * as React from "react"

/**
 * The element that has keyboard focus, looking through open shadow roots: inside one, `document.activeElement` is
 * only the host, and focusing the host later would do nothing (the Profile dialogs open from inside one).
 */
function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/**
 * Puts keyboard focus back where it was when a dialog, drawer or alert closes (Phase 4 Task 25). Radix returns focus
 * only to its own trigger element, and every dialog the Dashboard opens is controlled by state with none, so a
 * keyboard user who closed one used to land on the page body and had to tab from the top again. The opener is
 * read as the dialog takes focus, and if it is gone by the time the dialog closes (its row was deleted) Radix's
 * own behaviour is left to run. A handler the caller passes still runs first and can still prevent this.
 */
export function useRestoreFocus({
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const opener = React.useRef<HTMLElement | null>(null)

  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current = deepActiveElement()
      onOpenAutoFocus?.(event)
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event)
      const target = opener.current
      opener.current = null
      if (event.defaultPrevented || !target?.isConnected) return
      event.preventDefault()
      target.focus()
    },
  }
}
