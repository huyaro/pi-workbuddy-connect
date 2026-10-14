// 两版并存的注册契约：`workbuddy-cn`（国内版）与 `workbuddy-ai`（国际版）各自
// 使用自己的 base URL 与标记头，模型目录不互相污染，scope 过滤对两版都生效。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "workbuddy-variants-"));
process.env.PI_CODING_AGENT_DIR = dir;

const ext: any = await import("../extensions/workbuddy.ts");

const registered: any[] = [];
const handlers: Record<string, Function[]> = {};
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: (id: string, cfg: any) => { registered.push({ id, cfg }); },
  registerCommand: () => {},
};

await ext.default(pi);

const ids = registered.map((entry) => entry.id);
if (ids.length !== 2) throw new Error(`expected 2 providers, got ${ids.length}: ${ids.join(", ")}`);
if (!ids.includes("workbuddy-cn")) throw new Error("missing CN provider 'workbuddy-cn'");
if (!ids.includes("workbuddy-ai")) throw new Error("missing international provider 'workbuddy-ai'");

// 每版的 base URL 必须指向自己的站点；混用会让国内版打到国际版接口上。
const byId = new Map(registered.map((entry) => [entry.id, entry.cfg]));
const cn = byId.get("workbuddy-cn")!;
const ai = byId.get("workbuddy-ai")!;
if (!String(cn.baseUrl).startsWith("https://www.codebuddy.cn")) {
  throw new Error(`CN base URL wrong: ${cn.baseUrl}`);
}
if (!String(ai.baseUrl).startsWith("https://www.workbuddy.ai")) {
  throw new Error(`international base URL wrong: ${ai.baseUrl}`);
}
if (cn.name !== "WorkBuddy") throw new Error(`CN name wrong: ${cn.name}`);
if (ai.name !== "WorkBuddy AI") throw new Error(`international name wrong: ${ai.name}`);

// 标记头必须能区分两版，否则 before_provider_headers 无法把请求路由到正确凭据。
const cnMarker = cn.headers?.["X-Pi-WorkBuddy"];
const aiMarker = ai.headers?.["X-Pi-WorkBuddy"];
if (cnMarker !== "workbuddy-cn") throw new Error(`CN marker wrong: ${String(cnMarker)}`);
if (aiMarker !== "workbuddy-ai") throw new Error(`international marker wrong: ${String(aiMarker)}`);
if (cnMarker === aiMarker) throw new Error("markers must differ between variants");

// 注册的模型 id 集合必须互斥：两版共享模型 id（如 hy3、deepseek-v4.1-flash），
// 但一个 id 只能归属它真正来自的那版目录。
const cnIds = new Set(cn.models.map((model: any) => model.id));
const aiIds = new Set(ai.models.map((model: any) => model.id));

// payload hook 必须认领两版模型、拒绝其他 provider 的模型。
const hook = handlers["before_provider_request"]?.[0];
if (!hook) throw new Error("no before_provider_request handler");
const foreign = {
  model: "grok-4.6",
  messages: [{ role: "developer", content: "You are Grok." }],
  tool_choice: "none",
  tools: [{ type: "function", function: { name: "bash" } }],
};
const before = JSON.stringify(foreign);
hook({ type: "before_provider_request", payload: foreign });
if (JSON.stringify(foreign) !== before) {
  console.log("\nREGRESSION: another provider's request was rewritten.");
  process.exit(1);
}

console.log(`OK: 2 providers registered (CN ${cnIds.size} models, AI ${aiIds.size} models); base URLs, markers, and payload scope isolated.`);
