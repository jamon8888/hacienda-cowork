import { useEffect, useState } from 'react';

import { packs } from '@/ipc';
import { PACKS_CHANGED_EVENT } from '@/lib/packEvents';
import type { PackSuggestions } from '@/components/layout/new-tab/suggestionTree';

/**
 * The starter prompts of the vertical pack in force, kept current when the
 * user switches packs. A pack that cannot be read offers nothing: the screen
 * shows its ordinary suggestions.
 */
export function useActivePackSuggestions(): PackSuggestions | null {
  const [pack, setPack] = useState<PackSuggestions | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const view = await packs.list();
        if (!cancelled) setPack(view.activePack);
      } catch {
        if (!cancelled) setPack(null);
      }
    };
    void load();
    window.addEventListener(PACKS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(PACKS_CHANGED_EVENT, load);
    };
  }, []);

  return pack;
}
