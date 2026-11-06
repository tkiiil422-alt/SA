/**
 * The few shell services a view needs.
 *
 * The shell (app.js) fills these in at startup; views import the same object,
 * so a view never reaches into the shell's DOM directly.
 */
export const bus = {
  /** Transient message at the bottom; `action` is `{ label, run }`. */
  toast: () => {},
  /** Modal confirmation: `{ title, text, confirmLabel, danger, fields }` -> Promise<values|null>. */
  sheet: async () => null,
  /** Router: `navigate('#/tickets')` or `navigate('#/tickets/abc')`. */
  navigate: () => {},
  /** Ask the shell for a fresh overview (badge, aside, alerts). */
  refreshOverview: async () => null,
  /** Re-render the current route. */
  reload: () => {},
  /** Pause or resume accepting new work; resolves with the fresh overview. */
  setPaused: async () => null,
  /** Switch the colour theme: 'system' | 'light' | 'dark'. */
  setTheme: () => {},
  /** The stored theme choice, not the resolved one. */
  theme: () => 'system',
  /**
   * Compose panel. The shell owns the dialog; views only ask for it.
   * `preset` may carry { text, model, secrets, projectId, council }.
   */
  openCompose: () => {},
  closeCompose: () => {},
  /**
   * Upload singleton bridge (F2 fills the implementation).
   * state() -> { active:boolean, name?:string, percent?:number, done?:boolean, error?:string }
   * subscribe(fn) -> unsubscribe
   */
  upload: {
    state: () => ({ active: false }),
    subscribe: () => () => {},
  },
}
