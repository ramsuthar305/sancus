import Ajv, { ErrorObject } from 'ajv';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import schema from '../configs/apiConfig.schema.json';
import { APIConfig } from '../types/api';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile<APIConfig>(schema);

export class ConfigError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors || [])
    .map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${(e.params.allowedValues as string[]).join(', ')})` : ''}`)
    .join('; ');
}

/** `${VAR}` and `${VAR:-default}` in config files are replaced from the environment before parsing. */
export function interpolateEnv(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => process.env[name] ?? fallback ?? '');
}

/** Parse and validate one YAML file. Throws ConfigError on any problem. */
export function loadConfigFile(filePath: string): APIConfig {
  let parsed: unknown;
  try {
    parsed = yaml.load(interpolateEnv(fs.readFileSync(filePath, 'utf8')));
  } catch (e) {
    throw new ConfigError(filePath, `YAML parse error: ${(e as Error).message}`);
  }
  if (!validate(parsed)) {
    throw new ConfigError(filePath, formatErrors(validate.errors));
  }
  return parsed;
}

/**
 * Load every *.yml / *.yaml in a directory. Throws on the first invalid file or on
 * duplicate service names — an invalid config must never be served.
 */
export function loadConfigDir(dir: string): APIConfig[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => ['.yml', '.yaml'].includes(path.extname(f)))
    .sort();
  const configs = files.map((f) => loadConfigFile(path.join(dir, f)));

  const seen = new Set<string>();
  for (const c of configs) {
    if (seen.has(c.service.name)) throw new ConfigError(dir, `duplicate service name "${c.service.name}"`);
    seen.add(c.service.name);
  }
  return configs;
}
