/**
 * Bottom bar: title, tile count, Undo and New.
 */

export interface MenuActions {
  undo(): void
  newWorld(): void
}

export class Menu {
  private count: HTMLElement
  private undoBtn: HTMLButtonElement

  constructor(bar: HTMLElement, actions: MenuActions) {
    bar.innerHTML = `
      <span class="menu-brand">
        <span class="menu-title">truchet<span class="dim">.space</span></span>
        <span class="menu-count" aria-live="polite"></span>
      </span>
      <span class="menu-spacer"></span>
      <button class="menu-btn" data-act="undo" title="Undo the last tile (Ctrl+Z)">Undo</button>
      <button class="menu-btn" data-act="new" title="Start a new pattern">New</button>`
    this.count = bar.querySelector('.menu-count')!
    this.undoBtn = bar.querySelector('[data-act="undo"]')!

    bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'undo') actions.undo()
      else if (act === 'new') actions.newWorld()
    })
  }

  update(tiles: number, canUndo: boolean) {
    this.count.textContent = `${tiles.toLocaleString()} tile${tiles === 1 ? '' : 's'}`
    this.undoBtn.disabled = !canUndo
  }
}
