#!/usr/bin/env node
// `npm run check [dir]` — validate every service config without starting the gateway.
import fs from 'fs';
import path from 'path';
import { cacheWarnings, loadConfigDir, loadConfigFile } from '../utils/configValidator';
import getLogger from '../configs/logger';

// The check prints its own WARN lines; keep the JSON logger quiet.
getLogger().level = 'error';

const dir = path.resolve(process.argv[2] || 'api_configs');
let failed = false;

for (const f of fs.readdirSync(dir).filter((f) => ['.yml', '.yaml'].includes(path.extname(f))).sort()) {
  try {
    const cfg = loadConfigFile(path.join(dir, f));
    const routes = cfg.apis.reduce((n, a) => n + a.routes.length, 0);
    console.log(`OK    ${f}  service=${cfg.service.name} routes=${routes}`);
    for (const w of cacheWarnings(cfg)) console.log(`WARN  ${f}: ${w}`);
  } catch (e) {
    failed = true;
    console.error(`ERROR ${(e as Error).message}`);
  }
}
try {
  loadConfigDir(dir);
} catch (e) {
  failed = true;
  console.error(`ERROR ${(e as Error).message}`);
}
process.exit(failed ? 1 : 0);
