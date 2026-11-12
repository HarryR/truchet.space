/**
 * Bottom bar: title, tile count and New.
 */

export interface MenuActions {
  newWorld(): void
}

export class Menu {
  private count: HTMLElement

  constructor(bar: HTMLElement, actions: MenuActions) {
    bar.innerHTML = `
      <span class="menu-brand">
        <span class="menu-title">truchet<span class="dim">.space</span></span>
        <span class="menu-count" aria-live="polite"></span>
      </span>
      <span class="menu-spacer"></span>
      <button class="menu-btn" data-act="new" title="Start a new pattern">New</button>`
    this.count = bar.querySelector('.menu-count')!

    bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'new') actions.newWorld()
    })
  }

  update(tiles: number) {
    this.count.textContent = `${tiles.toLocaleString()} tile${tiles === 1 ? '' : 's'}`
  }
}
