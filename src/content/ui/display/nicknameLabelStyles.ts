export function applyNicknameLabelStyles (element: HTMLElement): void {
  element.style.display = 'inline-block'
  element.style.maxWidth = '120px'
  element.style.verticalAlign = 'bottom'
  element.style.whiteSpace = 'nowrap'
  element.style.overflow = 'hidden'
  element.style.textOverflow = 'ellipsis'
  element.style.font = 'inherit'
  element.style.color = 'inherit'
  element.style.fontWeight = 'inherit'
  element.style.opacity = '0.75'
  element.style.padding = '0px 2px'
}
