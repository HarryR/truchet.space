// ── Reused class-name constants ──

export const C_FIELD = 'panel-field'
export const C_LABEL = 'panel-label'
export const C_VALUE = 'panel-value'
export const C_VALUE_MONO = 'panel-value mono'
export const C_CLOSE = 'panel-close'
export const C_LOAD  = 'panel-loading'
export const C_ERR   = 'panel-error'
export const C_VALUE_ERR = 'panel-value panel-error'
export const C_MBTN  = 'mint-btn'

/** Build an HTML element string. */
export function el(tag: string, cls: string, content: string, attrs = ''): string {
  return `<${tag} class="${cls}"${attrs}>${content}</${tag}>`
}

export function el_div(cls: string, content: string, attrs = ''): string {
  return el('div', cls, content, attrs)
}

export function el_span(cls: string, content: string, attrs = ''): string {
  return el('span', cls, content, attrs)
}

export function el_button(cls: string, content: string, attrs = ''): string {
  return el('button', cls, content, attrs)
}

/** Panel field: label + value. */
export function field(label: string, value: string, valueCls = C_VALUE): string {
  return el_div(C_FIELD,
    el_span(C_LABEL, label) + el_span(valueCls, value))
}

/** External link (target=_blank). */
export function extLink(cls: string, href: string, text: string): string {
  return `<a class="${cls}" href="${href}" target="_blank" rel="noopener">${text}</a>`
}
