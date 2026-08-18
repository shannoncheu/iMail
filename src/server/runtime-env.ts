import { AsyncLocalStorage } from "node:async_hooks";

export interface RuntimeEnv {
  APP_URL?: string;
  DATABASE_URL?: string;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_IDS?: string;
  USE_MOCK_DATA?: string;
  [binding: string]: unknown;
}

const runtimeEnvKey = Symbol.for("imail.runtime-env");
const runtimeGlobal = globalThis as typeof globalThis & {
  [runtimeEnvKey]?: AsyncLocalStorage<RuntimeEnv>;
};
const runtimeEnvStorage =
  runtimeGlobal[runtimeEnvKey] ?? new AsyncLocalStorage<RuntimeEnv>();
runtimeGlobal[runtimeEnvKey] = runtimeEnvStorage;

export function runWithRuntimeEnv<T>(env: RuntimeEnv, callback: () => T): T {
  return runtimeEnvStorage.run(env, callback);
}

export function getRuntimeEnv(): RuntimeEnv | undefined {
  return runtimeEnvStorage.getStore();
}

export function getRuntimeString(name: string): string | undefined {
  const binding = getRuntimeEnv()?.[name];
  if (typeof binding === "string") return binding;
  return typeof process !== "undefined" ? process.env[name] : undefined;
}
