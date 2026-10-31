import type Redis from 'ioredis';

/**
 * A Lua script registered on the client with `defineCommand`, so ioredis sends EVALSHA (40-byte
 * hash) instead of the whole script on every call, and falls back to EVAL by itself when Redis
 * answers NOSCRIPT (after a restart or SCRIPT FLUSH).
 *
 * Scripts must be on the client before its first command. With auto-pipelining, ioredis builds a
 * pipeline per tick and copies the client's custom commands into it when it is created; a script
 * defined later is missing from a pipeline that already exists, and ioredis then mismatches its
 * callbacks and throws an uncaught error. So scripts are declared at module load with
 * defineScript(), and RedisService calls installScripts() right after it creates the client.
 */
export interface LuaScript {
  name: string;
  numberOfKeys: number;
  lua: string;
}

const scripts: LuaScript[] = [];

function install(redis: Redis, script: LuaScript): void {
  const client = redis as any;
  if (typeof client[script.name] !== 'function') client.defineCommand(script.name, { numberOfKeys: script.numberOfKeys, lua: script.lua });
}

export function defineScript(name: string, numberOfKeys: number, lua: string): LuaScript {
  const script = { name, numberOfKeys, lua };
  // Not installed on clients that already exist: one of them may have a pipeline in flight. Those
  // clients run this script with EVAL (see runScript); clients created from now on get EVALSHA.
  scripts.push(script);
  return script;
}

/** Call once on a new client, before it sends any command. */
export function installScripts(redis: Redis): void {
  scripts.forEach((s) => install(redis, s));
}

export function runScript<T = unknown>(redis: Redis, script: LuaScript, ...keysAndArgs: (string | number)[]): Promise<T> {
  const client = redis as any;
  if (typeof client[script.name] === 'function') return client[script.name](...keysAndArgs);
  // Not installed on this client (it skipped installScripts): plain EVAL is a built-in command that
  // every pipeline has, so it is always safe; defining the script here would not be.
  return client.eval(script.lua, script.numberOfKeys, ...keysAndArgs);
}
