/**
 * Cabinet mode switch (spec 2026-09-29). Turning it off transfers
 * responsibility to the person who does it, so the gesture must be confirmed
 * and recorded — and if it cannot be recorded, it does not happen.
 */

import { getCabinetModeEnabled, setCabinetModeEnabledInConfig } from '../configStore';
import { appendCabinetAudit, type CabinetAuditEntry } from './cabinetAudit';

export interface CabinetModeDeps {
  audit?: (entry: CabinetAuditEntry) => Promise<void>;
  writeConfig?: (value: boolean) => Promise<void>;
}

export async function setCabinetMode(
  value: boolean,
  options: { confirmed?: boolean },
  deps: CabinetModeDeps = {},
): Promise<{ enabled: boolean; auditRecorded: boolean }> {
  const audit = deps.audit ?? appendCabinetAudit;
  const writeConfig = deps.writeConfig ?? setCabinetModeEnabledInConfig;
  // The IPC layer forwards the request body untyped; a truthy non-boolean must
  // neither write a false audit event nor store a non-boolean setting.
  if (typeof value !== 'boolean' || (options.confirmed !== undefined && typeof options.confirmed !== 'boolean')) {
    throw new Error('Cabinet mode value and confirmation must be boolean.');
  }
  if (!value && options.confirmed !== true) {
    throw new Error('Turning off cabinet mode requires explicit confirmation.');
  }
  if (value === (await getCabinetModeEnabled())) return { enabled: value, auditRecorded: true };
  let auditRecorded = true;
  if (value) {
    // Turning protection on is the safe direction: a broken audit log must
    // not keep it off. The caller is told, so the user knows the log missed it.
    try {
      await audit({ event: 'cabinet_mode_enabled' });
    } catch (error) {
      auditRecorded = false;
      console.warn('[cabinet] could not record re-enabling cabinet mode', error);
    }
  } else {
    // Audit first: no trace, no change.
    await audit({ event: 'cabinet_mode_disabled' });
  }
  try {
    await writeConfig(value);
  } catch (error) {
    // The change was recorded but did not happen: record the state that
    // actually holds, so the log never disagrees with the setting.
    if (auditRecorded) {
      try {
        await audit({ event: value ? 'cabinet_mode_disabled' : 'cabinet_mode_enabled' });
      } catch (compensationError) {
        console.warn('[cabinet] could not record the reverted cabinet mode change', compensationError);
      }
    }
    throw error;
  }
  return { enabled: value, auditRecorded };
}
