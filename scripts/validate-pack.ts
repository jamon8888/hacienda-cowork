/**
 * Validate a vertical pack folder: `pnpm run pack:validate <folder> [--app-version 1.2.3]`.
 * Exits 1 on errors, so a pack repository can run it in CI against the app
 * version it targets. Needs no installed dependencies (bun only).
 */

import path from 'node:path';

import { validatePackFolder } from '../server/services/packValidation';

const args = process.argv.slice(2);
const versionFlag = args.indexOf('--app-version');
const appVersion = versionFlag >= 0 ? args[versionFlag + 1] : undefined;
const folder = args.find((arg, index) => !arg.startsWith('--') && (versionFlag < 0 || index !== versionFlag + 1));

if (!folder || (versionFlag >= 0 && !appVersion)) {
  console.error('Usage: pnpm run pack:validate <pack folder> [--app-version 1.2.3]');
  process.exit(2);
}

const result = validatePackFolder(path.resolve(folder), appVersion ? { appVersion } : {});
if (result.pack) {
  const { pack } = result;
  console.log(`${pack.name} (${pack.id}) ${pack.version}`);
  console.log(`  requires Safe: ${pack.requiresSafe ? 'yes' : 'no'}; requires app: ${pack.minAppVersion ? `>=${pack.minAppVersion}` : 'any'}`);
  console.log(`  skills: ${result.skills.length ? result.skills.join(', ') : 'none'}; starter prompts: ${pack.suggestionPills.length}`);
}
for (const warning of result.warnings) console.log(`warning: ${warning}`);
for (const error of result.errors) console.error(`error: ${error}`);
console.log(result.ok ? 'Pack is valid.' : 'Pack is not valid.');
process.exit(result.ok ? 0 : 1);
