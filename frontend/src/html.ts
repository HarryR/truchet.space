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
export function field(label: string, value: string, valueCls = 'panel-value'): string {
  return el_div('panel-field',
    el_span('panel-label', label) + el_span(valueCls, value))
}

/** External link (target=_blank). */
export function extLink(cls: string, href: string, text: string): string {
  return `<a class="${cls}" href="${href}" target="_blank" rel="noopener">${text}</a>`
}
