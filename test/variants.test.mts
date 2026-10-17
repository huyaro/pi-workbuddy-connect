// 两版并存的注册契约：`workbuddy`（国内版）与 `workbuddy-ai`（国际版）各自
// 使用自己的 base URL 与标记头，模型目录不互相污染，scope 过滤对两版都生效。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "workbuddy-variants-"));
process.env.PI_CODING_AGENT_DIR = dir;
// 测试必须与机器状态无关：把两版的桌面认证文件指向不存在的路径，否则跑在有
// 真实登录的机器上时会去读真凭据、发真实网络请求，结果随机（目录有时拉到、
// 有时拉不到），断言也就跟着飘。
process.env.WORKBUDDY_AUTH_FILE = join(dir, "absent-cn.info");
process.env.WORKBUDDY_AI_AUTH_FILE = join(dir, "absent-ai.info");

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
// 断言的是"两版各注册了一次"，不是"注册调用总数是 2"：启动时先按兜底目录注册，
// 目录刷新后内容变了会**再注册一次**（pi 明确支持重注册，后者合并覆盖前者）。
// 所以按 provider id 取最后一次注册的配置来验，重复注册同一份内容则不该发生。
const distinctIds = [...new Set(ids)].sort();
if (distinctIds.length !== 2) {
  throw new Error(`expected 2 distinct providers, got ${distinctIds.length}: ${distinctIds.join(", ")}`);
}
if (!distinctIds.includes("workbuddy")) throw new Error("missing CN provider 'workbuddy'");
if (!distinctIds.includes("workbuddy-ai")) throw new Error("missing international provider 'workbuddy-ai'");

// 用注册出来的真实 id 做排序断言（不是写死字符串）：CN_VARIANT 在前，
// 所以 registered 里第一条就是国内版。
const cnId = registered[0].id;
const aiId = registered.find((entry) => entry.id !== cnId)!.id;

// 国内版必须排在前面。pi 的模型列表按 **provider id** 排序
// （`provider.localeCompare(other.provider)`，见 model-selector 与 list-models），
// 不看 displayName。所以 CN 的 id 必须字典序小于 AI 的 id——这条钉住它，免得
// 将来又改回 `workbuddy-cn`（那样 CN 会被排到 AI 后面，看起来像"国内版不见了"）。
// 用注册出来的真实 id 比较，而不是写死字符串，否则改了名这条断言照样通过。
if (cnId.localeCompare(aiId) >= 0) {
  throw new Error(`CN provider id must sort before AI id: '${cnId}' vs '${aiId}'`);
}

// 每版的 base URL 必须指向自己的站点；混用会让国内版打到国际版接口上。
const byId = new Map(registered.map((entry) => [entry.id, entry.cfg]));
const cn = byId.get("workbuddy")!;
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
if (cnMarker !== "workbuddy") throw new Error(`CN marker wrong: ${String(cnMarker)}`);
if (aiMarker !== "workbuddy-ai") throw new Error(`international marker wrong: ${String(aiMarker)}`);
if (cnMarker === aiMarker) throw new Error("markers must differ between variants");

// 注册的模型 id 集合必须互斥：两版共享模型 id（如 hy3、deepseek-v4.1-flash），
// 但一个 id 只能归属它真正来自的那版目录。
const cnIds = new Set(cn.models.map((model: any) => model.id));
const aiIds = new Set(ai.models.map((model: any) => model.id));

// pi 的可用性闸门：provider 没有声明 `apiKey` 或 `oauth` 时，`composeApiKeyAuth`
// 的 `check` 返回 undefined，pi 就不把它算作「已配置」，于是把它**整组**从可用
// 模型快照里剔除。模型选择器与 `--list-models` 读的都是那份快照——所以少了这一项，
// 两版注册得再正确也一个都不显示（线上表现：重启后只剩腾讯云）。
//
// 这是"注册配置正确"与"模型真的可见"之间的鸿沟，上面那些断言全部覆盖不到，
// 必须单独钉住。
for (const [id, cfg] of byId) {
  const hasGate = typeof cfg.apiKey === "string" && cfg.apiKey !== "";
  if (!hasGate && !cfg.oauth) {
    throw new Error(`provider '${id}' has no apiKey/oauth — pi will hide all of its models`);
  }
}

// `PI_OFFLINE` 的判定必须与 pi 自己一致（`isTruthyEnvFlag`：1/true/yes）。
// 把任意非空值都当离线会造出一个静默坏状态：`PI_OFFLINE=0` 时 pi 照常联网、
// 插件却拒绝拉取，国内版在干净目录里永远是空的、还写不出缓存。
if (!ext.offlineRequested("1")) throw new Error("PI_OFFLINE=1 must mean offline");
if (!ext.offlineRequested("true")) throw new Error("PI_OFFLINE=true must mean offline");
if (!ext.offlineRequested("YES")) throw new Error("PI_OFFLINE=YES must mean offline");
if (ext.offlineRequested("0")) throw new Error("PI_OFFLINE=0 must NOT mean offline");
if (ext.offlineRequested("false")) throw new Error("PI_OFFLINE=false must NOT mean offline");
if (ext.offlineRequested("") || ext.offlineRequested(undefined)) {
  throw new Error("unset/empty PI_OFFLINE must NOT mean offline");
}

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
