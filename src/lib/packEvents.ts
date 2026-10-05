/**
 * Fired on `window` whenever the vertical pack in force may have changed
 * (picked, installed, removed). Kept in its own module so the settings screen
 * and the Safe banner can share it without importing each other.
 */
export const PACKS_CHANGED_EVENT = 'packs:changed';

export function notifyPacksChanged(): void {
  window.dispatchEvent(new Event(PACKS_CHANGED_EVENT));
}
