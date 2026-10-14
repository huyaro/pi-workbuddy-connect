import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const authDir = join(tmpdir(), `workbuddy-session-start-${process.pid}`);
await mkdir(authDir, { recursive: true });
await writeFile(join(authDir, ".workbuddy-auth.json"), JSON.stringify({
  version: 1,
  credential: {
    accessToken: "test-token",
    refreshToken: "",
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    domain: "",
    uid: "test-user",
  },
}));
process.env.PI_CODING_AGENT_DIR = authDir;

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => await new Promise<Response>(() => {});

const ext: any = await import("../extensions/workbuddy.ts");
const handlers: Record<string, Function[]> = {};
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: () => {},
  registerCommand: () => {},
};
await ext.default(pi);
const start = handlers.session_start?.[0];
if (!start) throw new Error("no session_start handler");

const ui = { setWidget() {}, setStatus() {}, notify() {} };
const result = await Promise.race([
  start({}, { model: { provider: "workbuddy" }, ui }),
  new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol.for("timed-out")), 100)),
]);
globalThis.fetch = originalFetch;
if (result === Symbol.for("timed-out")) {
  throw new Error("session_start is blocked by the WorkBuddy network request");
}
console.log("OK: session_start returns without waiting for WorkBuddy network");
