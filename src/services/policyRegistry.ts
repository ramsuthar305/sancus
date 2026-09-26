import Ajv, { ValidateFunction } from 'ajv';
import type { Request, RequestHandler, Response } from 'express';
import fs from 'fs';
import path from 'path';
import getLogger from '../configs/logger';
import type { PolicyMap } from '../types/api';
import ipRestriction from '../policies/ipRestriction';

/**
 * Named policies referenced from YAML (`policies: { <name>: <config> }`) at service or route level.
 * A policy is `{ name, schema?, priority?, create(config) => express middleware }`. Higher priority
 * runs first. Built-ins are registered here; custom ones are loaded from POLICIES_DIR (*.js).
 */
export interface PolicyDefinition {
  name: string;
  schema?: object;
  priority?: number;
  create(config: unknown): RequestHandler;
}

const logger = getLogger();
const ajv = new Ajv({ allErrors: true });

class PolicyRegistry {
  private static instance: PolicyRegistry;
  private readonly defs = new Map<string, { def: PolicyDefinition; validate?: ValidateFunction }>();
  private readonly compiled = new WeakMap<object, RequestHandler[]>();

  private constructor() {
    this.register(ipRestriction);
  }

  static getInstance(): PolicyRegistry {
    if (!PolicyRegistry.instance) PolicyRegistry.instance = new PolicyRegistry();
    return PolicyRegistry.instance;
  }

  register(def: PolicyDefinition): void {
    if (!def?.name || typeof def.create !== 'function') throw new Error('policy must have a name and a create() function');
    if (this.defs.has(def.name)) throw new Error(`policy "${def.name}" already registered`);
    this.defs.set(def.name, { def, validate: def.schema ? ajv.compile(def.schema) : undefined });
  }

  /** Load every *.js / *.cjs in `dir`; each module exports one definition (or an array) as default or module.exports. */
  loadDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((f) => ['.js', '.cjs'].includes(path.extname(f))).sort()) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(path.join(dir, f));
      const defs: PolicyDefinition[] = Array.isArray(mod) ? mod : [mod.default ?? mod];
      defs.forEach((d) => this.register(d));
      logger.info({ file: f, policies: defs.map((d) => d.name) }, 'loaded policies');
    }
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  /** Called at config load: validates configs and caches the middleware chain against the owning service/route object. */
  compile(owner: object, policies: PolicyMap | undefined, where: string): void {
    if (!policies) return;
    const chain: Array<{ priority: number; handler: RequestHandler }> = [];
    for (const [name, config] of Object.entries(policies)) {
      const entry = this.defs.get(name);
      if (!entry) throw new Error(`${where}: unknown policy "${name}" (known: ${this.names().join(', ') || 'none'})`);
      if (entry.validate && !entry.validate(config)) {
        throw new Error(`${where}: invalid config for policy "${name}": ${ajv.errorsText(entry.validate.errors)}`);
      }
      chain.push({ priority: entry.def.priority ?? 0, handler: entry.def.create(config) });
    }
    chain.sort((a, b) => b.priority - a.priority);
    this.compiled.set(owner, chain.map((c) => c.handler));
  }

  handlersFor(owner: object | undefined): RequestHandler[] {
    return (owner && this.compiled.get(owner)) || [];
  }

  /** Run a chain; resolves true when a handler already sent the response. */
  static async run(handlers: RequestHandler[], req: Request, res: Response): Promise<boolean> {
    for (const handler of handlers) {
      // Resolve on next(), or when the handler answered the request itself (sync or async).
      await new Promise<void>((resolve, reject) => {
        const finish = () => resolve();
        (res as any).once?.('finish', finish);
        (res as any).once?.('close', finish);
        try {
          handler(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
        } catch (e) {
          reject(e);
        }
        if (res.headersSent) resolve();
      });
      if (res.headersSent) return true;
    }
    return false;
  }
}

export default PolicyRegistry;
