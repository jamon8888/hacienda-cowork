/**
 * Cabinet mode switch (spec 2026-09-29). Turning it off transfers
 * responsibility to the person who does it, so the gesture must be confirmed
 * and recorded — and if it cannot be recorded, it does not happen.
 */

import { getCabinetModeEnabled, setCabinetModeEnabledInConfig } from '../configStore';
import { appendCabinetAudit, type CabinetAuditEntry } from './cabinetAudit';

export interface CabinetModeDeps {
  audit?: (entry: CabinetAuditEntry) => Promise<void>;
}

export async function setCabinetMode(
  value: boolean,
  options: { confirmed?: boolean },
  deps: CabinetModeDeps = {},
): Promise<{ enabled: boolean }> {
  const audit = deps.audit ?? appendCabinetAudit;
  if (!value && options.confirmed !== true) {
    throw new Error('Turning off cabinet mode requires explicit confirmation.');
  }
  if (value === (await getCabinetModeEnabled())) return { enabled: value };
  // Audit first: no trace, no change.
  await audit({ event: value ? 'cabinet_mode_enabled' : 'cabinet_mode_disabled' });
  await setCabinetModeEnabledInConfig(value);
  return { enabled: value };
}
