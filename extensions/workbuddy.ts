// WorkBuddy provider（国内版 + 国际版）。
//
// 一个扩展注册两个 provider：`workbuddy`（国内版）与 `workbuddy-ai`（国际版）。
// 两版是同一套客户端框架在不同区域的发行版，模型、账号、积分互不混用；各自
// 只跟随对应桌面 App 的登录状态，没凭据的那版整组隐藏。
//
// 凡两版不同的东西都收在 `variants.ts` 的描述符里；模型目录解析在 `catalog.ts`，
// 上游请求在 `upstream.ts`，凭据（含加密解密）在 `auth.ts` 与
// `desktop-credential-protection.ts`。
//
// 对齐参考实现 corrinehu/dsh-workbuddy-connect。

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type UpstreamModel } from "./catalog.ts";
import { WorkBuddyCredentialStore, parseWorkBuddyAuth, type Cred } from "./auth.ts";
import { WorkBuddyUpstream, chatHeaders, type Credits } from "./upstream.ts";
import { AI_VARIANT, CN_VARIANT, VARIANTS, regionOf, type WorkBuddyVariant } from "./variants.ts";

/** 每版请求打上的标记头；`before_provider_headers` 靠它认领自己的请求。 */
const MARKER = "X-Pi-WorkBuddy";
/**
 * 注册闸门用的占位 apiKey，**不是**凭据。
 *
 * pi 只有在 provider 声明了 `apiKey` 或 `oauth` 时才认为它"已配置"
 * （`composeApiKeyAuth` 的 `check` 在没有 `rawKey` 时返回 undefined），而
 * 未配置的 provider 会被整组从可用模型快照里剔除——模型选择器与
 * `--list-models` 读的都是这份快照。所以没有这一项，两版注册得再对也永远
 * 不显示：这正是"重启后只剩腾讯云"的成因。
 *
 * 真 token 由 `before_provider_headers` 写进 `event.headers`（即 pi 传给底层
 * openai 客户端的 `model.headers`），**靠合并顺序**压过这里生成的
 * `Authorization: Bearer <占位值>`——openai SDK 的 `buildHeaders` 把
 * `defaultHeaders` 排在 `authHeaders(apiKey)` 之后。这是顺序依赖，不是"钩子
 * 一定赢"的契约：将来 SDK 调整合并顺序，占位值就可能真的发出去。
 *
 * 所以这个值刻意取得一眼可辨（绝不是合法 token）：真发出去必然 401，属于
 * fail-closed，而不是静默用错身份。已实测确认（本地 echo server + 抓真实
 * 请求）：钩子认领时线上是 `Bearer <真 token>`，钩子未认领时才会看到这个占位值。
 */
const REGISTRATION_API_KEY = "workbuddy-desktop-credential";
/** 产品配置缓存 env（国际版）。 */
const PRODUCT_CONFIG_ENV = "WORKBUDDYAI_PRODUCT_CONFIG";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** 积分短缓存：自动绘制（session_start / model_select）吃缓存，手动刷新强制绕过。 */
const CREDITS_TTL_MS = 30_000;
const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
type Scope = "free" | "all";

export function thinkingLevelMap(efforts: readonly string[], canDisable = false) {
  return {
    off: canDisable ? "off" : null,
    minimal: null,
    low: efforts.includes("low") ? "low" : null,
    medium: efforts.includes("medium") ? "medium" : null,
    high: efforts.includes("high") ? "high" : null,
    xhigh: efforts.includes("xhigh") ? "xhigh" : null,
    max: efforts.includes("max") ? "max" : null,
  } as const;
}

const HIGH_ONLY = thinkingLevelMap(["high"]);
const LOW_HIGH = thinkingLevelMap(["low", "high"]);

// ---------------------------------------------------------------------------
// 国际版兜底：产品配置缓存
//
// 国际版目录优先从 `/v3/config` 实时拉取（见 CatalogRuntime）；拉不到时回退
// 到产品配置缓存 `acc-product-config-v3.json`，再回退到内置清单。国内版没有
// 这份缓存——它的目录只走 `/v3/config`。
// ---------------------------------------------------------------------------

type ProductModel = {
  id: string;
  name: string;
  credits?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  supportedEfforts?: Effort[];
  canDisableThinking: boolean;
};

type ProductConfig = { source: "cache" | "builtin"; models: ProductModel[] };

// ponytail: flash reasoning loops (OK/Let me write/Go) eat 128k max_tokens; 16k stops the stall. Raise if long answers get cut.
const FLASH_MAX_TOKENS = 16_384;

/**
 * 兜底误列的模型 id：在 App 侧目录里出现，但**上游不提供**。
 *
 * 注意判据是"上游认不认"，不是"CLI 名单里有没有"。这里踩过一次坑，记下来：
 *
 * - 桌面 App 的产品配置（`acc-product-config-v3.json`）与 `/v3/config` CLI 名单
 *   确实是两份名单（网关按 UA 分流），但**名单之差 ≠ 可用性之差**。曾据"CLI 名单
 *   里没有 `hy4-preview-f`"断定它不可用并把它剔除，实测是错的：
 *   `POST /v2/chat/completions {model:"hy4-preview-f"}` 返回 **200**，它是个能用的
 *   免费模型。凭"不在 CLI 名单里"删模型，等于凭空没收一个可用档位。
 *
 * - 真正不可用的是这两个付费档：`gpt-5.6-sol`(x3.47)、`gpt-6-astra`(x6.67)，
 *   请求返回 400 `model [...] service info not found`（与乱造 id 的报错一致）。
 *   它们只出现在 App 侧兜底清单里，选中必然失败，所以从兜底里剔除。
 *
 * 实时目录是权威的，这里只管离线兜底；上游将来上/下架某个 id 时，改这一处即可。
 */
const UNSERVABLE_FALLBACK_IDS: ReadonlySet<string> = new Set(["gpt-5.6-sol", "gpt-6-astra"]);

const BUILTIN_MODELS: ProductModel[] = [
  {
    id: "deepseek-v4.1-flash",
    name: "Deepseek-V4.1-Flash",
    credits: "x0.00",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    canDisableThinking: false,
  },
  {
    id: "hy4-preview-f",
    name: "Hy4 preview",
    credits: "x0.00",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["high"],
    canDisableThinking: false,
  },
  {
    id: "hy3",
    name: "Hy3",
    credits: "x0.00",
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["low", "high"],
    canDisableThinking: false,
  },
];

// 兜底清单里的免费 id。
const FREE_IDS = ["hy3", "deepseek-v4.1-flash", "hy4-preview-f"] as const;

/**
 * 国内版的最小兜底清单：它实测能用的两个免费档。
 *
 * 国内版原本**没有任何离线兜底**——拉不到就是空清单、整组隐藏。设计的初衷是
 * "宁可隐藏也不要给一份选了必然报错的列表"，但当网络只是**慢**而不是断的时候，
 * 代价是灾难性的：`pi` 的启动快照只等一次有界尝试（2.5s），慢于此就永久看不到
 * 国内版任何模型，连目录缓存都写不出来，下一次启动还是空的——**永远不会自愈**。
 *
 * 所以给一份最小但**实测可用**的清单：两个免费档的 id/窗口与实时目录一致（实时
 * 拉取成功后会被真实名单整体替换）。它们是"兜底"，不是"猜测"：上游若哪天撤掉，
 * 表现是选中报错，而不是静默用错模型。
 */
const CN_BUILTIN_MODELS: ProductModel[] = [
  {
    id: "hy3",
    name: "Hy3",
    credits: "x0.00",
    contextWindow: 192_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["low", "high"],
    canDisableThinking: false,
  },
  {
    id: "step-5-preview",
    name: "Step-5-Preview",
    credits: "x0.00",
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsReasoning: true,
    supportedEfforts: ["low", "medium", "high"],
    canDisableThinking: false,
  },
];

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * 实时目录落盘缓存（两版各一份）。
 *
 * 注册那一刻的清单决定"这次启动能看到什么"。国内版没有任何离线兜底，国际版只有
 * 产品配置缓存/内置清单——两者都不等于上游当前真正下发的名单。于是同一份账号、
 * 同一份目录，重启几次会看到不同的免费模型集合（实测：国际版 12 次里有 1 次多出
 * `hy4-preview-f`，那是只有兜底清单才有的条目；国内版更严重，会整个分组消失）。
 *
 * 把最近一次成功拉到的目录存下来，下次启动先用它注册，实时拉取成功后再覆盖。
 * 缓存只是同一份答案的上一次快照，不改变语义；拉取失败时卡片会标「已保存」而不是
 * 「实时」，来源依然可见。目录不含凭据（只有模型名与窗口），所以与 token 分开存。
 */
function catalogCachePath(variant: WorkBuddyVariant): string {
  return join(agentDir(), `.workbuddy-catalog-${variant.region}.json`);
}

/** 落盘缓存的结构；读取器拒绝其他版本。 */
const CATALOG_CACHE_VERSION = 1;

export function parseCatalogCache(text: string): UpstreamModel[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  if (document["version"] !== CATALOG_CACHE_VERSION) return undefined;
  if (!Array.isArray(document["models"])) return undefined;
  const models: UpstreamModel[] = [];
  for (const raw of document["models"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row["id"] === "string" ? row["id"] : "";
    const contextWindow = typeof row["contextWindow"] === "number" ? row["contextWindow"] : 0;
    const maxTokens = typeof row["maxTokens"] === "number" ? row["maxTokens"] : 0;
    if (id === "" || contextWindow <= 0 || maxTokens <= 0) continue;
    // 旧版本可能把上游不提供的条目写进过缓存；读的时候同样要剔。
    if (UNSERVABLE_FALLBACK_IDS.has(id)) continue;
    const supportedEfforts = Array.isArray(row["supportedEfforts"])
      ? row["supportedEfforts"].filter((e): e is string => typeof e === "string")
      : undefined;
    models.push({
      id,
      name: typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : id,
      contextWindow,
      maxTokens,
      supportsImages: row["supportsImages"] === true,
      supportsReasoning: row["supportsReasoning"] === true,
      ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
      canDisableThinking: row["canDisableThinking"] === true,
      ...typeof row["credits"] === "string" && row["credits"] !== "" ? { credits: row["credits"] } : {},
      free: row["free"] === true,
    });
  }
  return models.length > 0 ? models : undefined;
}

function loadCatalogCache(variant: WorkBuddyVariant): UpstreamModel[] | undefined {
  try {
    return parseCatalogCache(readFileSync(catalogCachePath(variant), "utf8"));
  } catch {
    return undefined;
  }
}

async function saveCatalogCache(variant: WorkBuddyVariant, models: readonly UpstreamModel[]): Promise<void> {
  try {
    await writeFile(
      catalogCachePath(variant),
      `${JSON.stringify({ version: CATALOG_CACHE_VERSION, models })}\n`,
      { mode: 0o600 },
    );
  } catch { /* 缓存写不进去不该影响任何别的事 */ }
}

function productConfigPath(): string {
  const override = process.env[PRODUCT_CONFIG_ENV]?.trim();
  if (override) return override;
  return join(homedir(), ".workbuddy-ai", "cache", "acc-product-config-v3.json");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * `PI_OFFLINE` 是否表示"真的离线"。
 *
 * 必须与 pi 自己的判定一致（`isTruthyEnvFlag`：`1` / `true` / `yes`，大小写不敏感）。
 * 把任意非空值都当离线会出事：`PI_OFFLINE=0` 时 pi 照常联网、插件却拒绝拉取，
 * 国内版在干净目录里会**永远**是空的、还写不出缓存；而 pi 自己用的是"真值"语义，
 * 两者不一致就成了一个静默的坏状态。
 *
 * `pi --offline` 会把 `PI_OFFLINE` 设成 `"1"`，所以那条路径同样被这里认到。
 */
export function offlineRequested(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
    ? value as Effort
    : undefined;
}

function parseProductModel(value: unknown): ProductModel | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (id === "") return undefined;
  const reasoning = asRecord(row.reasoning);
  const rawEfforts = reasoning?.supportedEfforts;
  let supportedEfforts: Effort[] | undefined;
  if (Array.isArray(rawEfforts)) {
    const efforts = rawEfforts.map(parseEffort).filter((e): e is Effort => e !== undefined);
    if (efforts.length > 0) supportedEfforts = efforts;
  }
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    ...(typeof row.credits === "string" && row.credits.trim() !== "" ? { credits: row.credits.trim() } : {}),
    contextWindow: positiveNumber(row.maxInputTokens) ?? positiveNumber(row.maxAllowedSize) ?? 0,
    maxTokens: positiveNumber(row.maxOutputTokens) ?? 0,
    supportsImages: row.supportsImages === true && row.disabledMultimodal !== true,
    supportsReasoning: row.supportsReasoning === true,
    ...supportedEfforts ? { supportedEfforts } : {},
    canDisableThinking: reasoning?.canDisableThinking === true,
  };
}

export function parseProductConfig(text: string): ProductConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document || !Array.isArray(document.models)) return undefined;
  const models = document.models.map(parseProductModel).filter((m): m is ProductModel => m !== undefined);
  if (models.length === 0) return undefined;
  // 在这里就滤掉上游不提供的档位，而不是留给调用方：漏一步就会把必然 400 的
  // 模型列进兜底清单。过滤只针对 App 侧产品配置（`withoutUnservableModels`
  // 的说明解释了为什么判据必须是"实测不可用"）。
  return { source: "cache", models: withoutUnservableModels(models) };
}

export function loadProductConfig(path = productConfigPath()): ProductConfig {
  try {
    // parseProductConfig 已经在解析处滤掉不可用档位，这里不用再滤一遍。
    const parsed = parseProductConfig(readFileSync(path, "utf8"));
    if (parsed) return parsed;
  } catch { /* missing/unreadable cache → builtin */ }
  return { source: "builtin", models: BUILTIN_MODELS };
}

/**
 * 剔除上游不提供的兜底模型行（见 UNSERVABLE_FALLBACK_IDS）。
 *
 * App 侧产品配置列了若干上游其实不提供的档位（实测请求返回 400
 * `model [...] service info not found`）。它们在**唯一**的入口处被过滤，
 * 这样兜底清单从哪个分支来都不会带出必然失败的选项。
 *
 * 注意：这里**只**剔除实测不可用的 id。不要按"不在 CLI 名单里"来删——
 * `hy4-preview-f` 就不在 CLI 名单里却完全可用。
 */
export function withoutUnservableModels(models: readonly ProductModel[]): ProductModel[] {
  return models.filter((model) => !UNSERVABLE_FALLBACK_IDS.has(model.id));
}

/** 国际版兜底清单，按 credits 是否为 0 判免费。 */
export function freeModelIds(config: ProductConfig): readonly string[] {
  if (config.source === "builtin") return FREE_IDS;
  const free = config.models.filter((m) => creditsAreFree(m.credits)).map((m) => m.id);
  return free.length > 0 ? free : FREE_IDS;
}

/**
 * 归一化倍率：去掉国内版的 `credits` 单位后缀，再做零值判定。
 *
 * 国内版写成 `x2.00 credits`，国际版写成裸的 `x0.00`；只看裸值的匹配永远
 * 看不到前者，所以免费判定必须先归一化。
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined;
  const trimmed = credits.trim();
  if (trimmed === "") return undefined;
  if (/^credits?$/iu.test(trimmed)) return undefined;
  const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
  return bare === "" ? undefined : bare;
}

export function creditsAreFree(credits: string | undefined): boolean {
  const normalized = normalizeCredits(credits);
  if (normalized === undefined) return false;
  return /^x?0(?:\.0+)?$/u.test(normalized);
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function settingsPath(): string {
  return join(agentDir(), ".workbuddy-settings.json");
}

export function loadSettings(): { scope: Scope } {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as { scope?: string };
    if (parsed.scope === "all") return { scope: "all" };
  } catch { /* default free */ }
  return { scope: "free" };
}

async function saveSettings(scope: Scope): Promise<void> {
  await writeFile(settingsPath(), `${JSON.stringify({ scope }, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// 模型注册
// ---------------------------------------------------------------------------

/** 一行上游模型 → pi 的模型定义。 */
function toPiModel(model: UpstreamModel, scope: Scope) {
  if (model.contextWindow <= 0 || model.maxTokens <= 0) return undefined;
  if (scope === "free" && !model.free) return undefined;
  const efforts = model.supportsReasoning
    ? (model.supportedEfforts?.length ? model.supportedEfforts : EFFORTS)
    : [];
  const credits = model.credits ?? "x?";
  return {
    id: model.id,
    name: `${model.name} · ${credits}`,
    reasoning: model.supportsReasoning,
    thinkingLevelMap: thinkingLevelMap(efforts, model.canDisableThinking),
    input: (model.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.id === "deepseek-v4.1-flash"
      ? Math.min(model.maxTokens, FLASH_MAX_TOKENS)
      : model.maxTokens,
    compat: COMPAT,
  };
}

export function buildPiModels(models: readonly UpstreamModel[], scope: Scope) {
  return models.flatMap((model) => {
    const built = toPiModel(model, scope);
    return built === undefined ? [] : [built];
  });
}

/** 内置兜底清单（国际版无网络时）也走同一条构建路径。 */
function builtinAsUpstream(): UpstreamModel[] {
  return BUILTIN_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImages: model.supportsImages,
    supportsReasoning: model.supportsReasoning,
    ...model.supportedEfforts ? { supportedEfforts: [...model.supportedEfforts] } : {},
    canDisableThinking: model.canDisableThinking,
    ...model.credits === undefined ? {} : { credits: model.credits },
    free: creditsAreFree(model.credits),
  }));
}

// ---------------------------------------------------------------------------
// 一个变体的运行时：凭据、上游、模型目录、卡片
// ---------------------------------------------------------------------------

type Ui = {
  setWidget(key: string, content: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

/**
 * （历史接口）旧版卡片门控：只认 WorkBuddy provider。
 *
 * 卡片现在跟随**登录状态**常驻显示（见 `paint`），不再按"会话正用哪个模型"
 * 撤下——查询积分不该要求先把会话切到 WorkBuddy 模型。此函数保留给外部
 * 诊断与自检使用。
 */
export function showsWorkBuddyCard(provider: unknown, ids: readonly string[], force = false): boolean {
  return force || (typeof provider === "string" && ids.includes(provider));
}

function fmtExpiry(ms: number): string {
  if (ms <= 0) return "未知";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function bar(remain: number, size: number, width = 28): string {
  if (size <= 0) return "";
  const n = Math.round(Math.min(1, Math.max(0, remain / size)) * width);
  return `${"█".repeat(n)}${"░".repeat(width - n)}`;
}

/** 低余额警示线：套餐剩余占比低于此百分比时行首标 ⚠。 */
export const LOW_CREDIT_PCT = 10;

/**
 * 暗色主题下可读的高亮 ANSI 色。
 *
 * widget 行**只在终端 TUI 模式**（`ctx.mode === "tui"`）着色：Pi Desktop（RPC）
 * 把 widgetLines 当纯文本渲染、不解析转义序列，着色会显示成 `[96m` 之类的乱码。
 */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[96m",
  yellow: "\x1b[93m",
  red: "\x1b[91m",
  gray: "\x1b[90m",
} as const;

/** 是否存在低于警示线的积分包；通知据此升级为 warning 级别（桌面端以此变色）。 */
export function hasLowCredit(credits: Credits): boolean {
  return credits.accounts.some((pack) => {
    const pct = packPct(pack);
    return pct !== undefined && pct < LOW_CREDIT_PCT;
  });
}

/** 显示宽度估算：CJK 等全角字符按 2 列，其余按 1 列（等宽字体下的近似）。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return width;
}

/** 按显示宽度右侧补空格；超宽不截断（调用方控制总宽度）。 */
function padEndWidth(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

function packPct(pack: { remain: number; size: number; unlimited?: boolean }): number | undefined {
  if (pack.unlimited || pack.size <= 0) return undefined;
  return Math.round(pack.remain / pack.size * 100);
}

/**
 * 积分摘要行：有容量就给占比，多包给包数，有低余额包就前置警示计数。
 *
 * 例：`合计 358/450（80%）· 2 个包 · ⚠ 1 个偏低`。没有容量信息（size=0）时
 * 不编造百分比，只报 `合计 <total>`；无上限账号固定 `无上限`——任何渲染路径
 * 都不出现编造的数字（与 upstream 里「看不懂的答案不能渲染成 0」同一纪律）。
 */
export function creditsSummary(credits: Credits): string {
  if (credits.unlimited) return "无上限";
  let capacity = 0;
  let remainOfCapped = 0;
  let packs = 0;
  let low = 0;
  for (const pack of credits.accounts) {
    if (pack.unlimited) continue;
    packs += 1;
    const pct = packPct(pack);
    if (pct !== undefined) {
      capacity += pack.size;
      remainOfCapped += pack.remain;
      if (pct < LOW_CREDIT_PCT) low += 1;
    }
  }
  const head = capacity > 0
    ? `合计 ${remainOfCapped}/${capacity}（${Math.round(remainOfCapped / capacity * 100)}%）`
    : `合计 ${credits.total}`;
  const tail = [
    packs > 1 ? `${packs} 个包` : "",
    low > 0 ? `⚠ ${low} 个偏低` : "",
  ].filter(Boolean).join(" · ");
  return tail ? `${head} · ${tail}` : head;
}

/**
 * 积分明细行：低余额的包排最前（需要关注的先看到），每包带精确数字与百分比，
 * 进度条只作辅助估读。行首缩进两格与卡片其他字段区分层级。
 *
 * 行数有硬上限（`maxPacks`，默认 4）：积分包多的账号（实测国内版可达 58 个）
 * 若全列出来，卡片会高达百余行——pi 终端侧 widget 超 10 行直接截断，桌面端
 * 面板按行堆叠，观感就是"弹出框巨大"。超出的包合并成一行摘要，点睛信息
 * （余额最低的几个）永远在前。
 */
export function creditRows(credits: Credits, maxPacks = 4): string[] {
  const rows: string[] = [];
  const packs = [...credits.accounts].sort((a, b) => {
    const pa = packPct(a);
    const pb = packPct(b);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return 0;
  });
  const shown = packs.slice(0, maxPacks);
  for (const pack of shown) {
    const pct = packPct(pack);
    const flag = pct !== undefined && pct < LOW_CREDIT_PCT ? "⚠ " : "";
    const right = pack.unlimited
      ? "无上限"
      : pct !== undefined ? `${pack.remain}/${pack.size}（${pct}%）` : String(pack.remain);
    // 进度条并入同一行：包多时行数减半，卡片高度直接减一档。
    const drawn = bar(pack.remain, pack.size, 14);
    rows.push(`  ${flag}${padEndWidth(pack.packageName, 24)} ${drawn ? `${drawn} ` : ""}${right}`);
  }
  const rest = packs.slice(maxPacks);
  if (rest.length > 0) {
    let remain = 0;
    for (const pack of rest) remain += pack.remain;
    rows.push(`  … 其余 ${rest.length} 个包 · 余 ${remain}`);
  }
  return rows;
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function widgetLines(input: {
  variant: WorkBuddyVariant;
  cred?: Cred;
  credits?: Credits;
  error?: string;
  scope: Scope;
  models: { name: string }[];
  catalogSource?: string;
  /** 最近一次成功积分刷新的时间；有则在刷新入口旁标注"更新于"。 */
  refreshedAt?: Date;
  /** 终端 TUI 模式下用 ANSI 高亮（暗色主题）；桌面端不解析 ANSI，必须保持纯文本。 */
  color?: boolean;
}): string[] {
  const scope = input.scope;
  const c = input.color
    ? (text: string, code: string) => `${code}${text}${ANSI.reset}`
    : (text: string) => text;
  // 账户名上头部：第一行就能对上"这是谁的账号"，不必逐行找。
  const who = input.cred === undefined ? undefined : (input.cred.nickname || input.cred.uid) || undefined;
  const lines = [
    c(
      `${input.variant.displayName} · ${input.variant.region === "cn" ? "国内版" : "国际版"} `
      + `· ${who === undefined ? "" : `${who} · `}${scope === "all" ? "全部模型" : "仅免费模型"}`,
      ANSI.bold + ANSI.cyan,
    ),
  ];
  if (!input.cred) {
    lines.push(
      "未登录。"
      + `${input.variant.displayName} 桌面 App 登录后自动可用。`,
    );
    if (input.error) lines.push(input.error);
    lines.push("设置  /workbuddy");
    return lines;
  }
  lines.push(`令牌  ${fmtExpiry(input.cred.expiresAtMs)} 过期（自动续期）`);
  if (input.credits) {
    // 摘要行加粗；有低余额包时升级为黄色警示。明细里 ⚠ 行红色，其余保持本色。
    lines.push(
      c(`积分  ${creditsSummary(input.credits)}`, hasLowCredit(input.credits) ? ANSI.bold + ANSI.yellow : ANSI.bold),
    );
    lines.push(...creditRows(input.credits).map((row) => row.includes("⚠") ? c(row, ANSI.red) : row));
  } else if (input.error) {
    lines.push(c(`积分  ${input.error}`, ANSI.yellow));
  }
  if (input.catalogSource) lines.push(c(`目录  ${input.catalogSource}`, ANSI.gray));
  // 模型清单封顶：全部拼一行会折成一大块（实测国内版 18 个模型），是卡片
  // 膨胀的另一半原因。完整的清单在模型选择器里本来就能看，这里只提示数量。
  const allNames = input.models.map((model) => model.name);
  const names = allNames.length === 0
    ? "（无模型）"
    : allNames.length <= 5
      ? allNames.join("  |  ")
      : `${allNames.slice(0, 5).join("  |  ")} … 共 ${allNames.length} 个`;
  lines.push(c(`模型  ${names}`, ANSI.gray));
  const at = input.refreshedAt ? ` · 更新于 ${fmtTime(input.refreshedAt)}` : "";
  lines.push(c(`⟳ 刷新积分  /workbuddy c${at} · 设置  /workbuddy`, ANSI.cyan));
  return lines;
}

/** 一个变体的完整运行时。 */
class VariantRuntime {
  readonly variant: WorkBuddyVariant;
  readonly widgetKey: string;
  private readonly store: WorkBuddyCredentialStore;
  private readonly upstream: WorkBuddyUpstream;
  private models: UpstreamModel[] = [];
  private catalogSource = "内置兜底";
  /** 最近一次成功刷新到的实时目录，供离线降级。 */
  private liveCatalog: UpstreamModel[] | undefined;
  /** 飞行中的目录拉取；并发调用合并到同一个请求上。 */
  private inflightRefresh: Promise<boolean> | undefined;
  /**
   * 当前清单是否"权威"——即来自落盘缓存或实时拉取，而不是离线兜底清单。
   *
   * 这是启动时该不该等这次网络的分界线。兜底清单（国际版的产品配置/内置）不等于
   * 上游现在真正下发的名单：它多出只有自己才有的条目（`hy4-preview-f`），一被
   * 注册出去就会让"免费模型集合"在重启之间变化。所以清单只要还是兜底来的，
   * 启动就该等一次实时结果（有界）。
   */
  private catalogAuthoritative = false;
  private card: string[] | undefined;
  /** 积分短缓存与取数时间；undefined = 本会话从未取到过。 */
  private creditsCache: { credits: Credits; at: number } | undefined;
  /** 飞行中的积分拉取；并发绘制/刷新合并到同一个请求上。 */
  private inflightCredits: Promise<Credits> | undefined;

  constructor(variant: WorkBuddyVariant) {
    this.variant = variant;
    this.widgetKey = variant.id;
    this.upstream = new WorkBuddyUpstream({ variant });
    this.store = new WorkBuddyCredentialStore({
      variant,
      agentDir: agentDir(),
      refresh: (cred, signal) => this.upstream.refreshAccess(cred, signal),
    });
    this.applyFallback();
  }

  /** 装载兜底目录：国际版用产品配置缓存，国内版无兜底（隐藏分组）。 */
  private applyFallback(): void {
    // 两版都优先用"上次实时拉到的目录"：它记的是上游真正下发的名单，比任何
    // 离线兜底都准。留这一层是为了让注册那一刻的清单与上游一致——否则同一份
    // 账号、同一份目录，重启几次会看到不同的免费模型集合（实测国际版 12 次里
    // 有 1 次多出 hy4-preview-f，那是兜底清单才有的条目）。
    const cached = loadCatalogCache(this.variant);
    if (cached) {
      this.models = cached;
      this.liveCatalog = cached;
      this.catalogSource = "已保存";
      this.catalogAuthoritative = true;
      return;
    }
    if (this.variant.catalog === "product-config") {
      const config = loadProductConfig();
      this.models = config.source === "cache"
        ? config.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          supportsImages: model.supportsImages,
          supportsReasoning: model.supportsReasoning,
          ...model.supportedEfforts ? { supportedEfforts: [...model.supportedEfforts] } : {},
          canDisableThinking: model.canDisableThinking,
          ...model.credits === undefined ? {} : { credits: model.credits },
          free: creditsAreFree(model.credits),
        }))
        : builtinAsUpstream();
      this.catalogSource = config.source === "cache" ? "产品配置缓存" : "内置兜底";
      // 兜底清单不是权威名单，所以这一版启动时仍要等一次实时拉取。
      this.catalogAuthoritative = false;
      return;
    }
    // 国内版用最小兜底清单（见 CN_BUILTIN_MODELS），**不再留空**：
    // 留空会让"网络慢于 2.5s"变成"永久看不到国内版"，且无法自愈。
    // 仍然是"兜底"语义——实时拉取成功后会整体替换，卡片上标明来源是"内置兜底"。
    this.models = CN_BUILTIN_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImages: model.supportsImages,
      supportsReasoning: model.supportsReasoning,
      ...model.supportedEfforts ? { supportedEfforts: [...model.supportedEfforts] } : {},
      canDisableThinking: model.canDisableThinking,
      ...model.credits === undefined ? {} : { credits: model.credits },
      free: creditsAreFree(model.credits),
    }));
    this.catalogSource = "内置兜底";
    this.catalogAuthoritative = false;
  }

  get credentials(): WorkBuddyCredentialStore {
    return this.store;
  }

  /** 当前模型清单（未按 scope 过滤）。 */
  get catalog(): readonly UpstreamModel[] {
    return this.models;
  }

  get source(): string {
    return this.catalogSource;
  }

  /** 清单是否来自缓存或实时拉取（而不是离线兜底）。 */
  get authoritative(): boolean {
    return this.catalogAuthoritative;
  }

  /**
   * 拉取实时目录；失败时保留现有清单并返回 false。
   *
   * 国内版首次拉取失败时清单仍为空——没凭据就整组隐藏，比给出一份选了必然
   * 报错的兜底列表要好。
   *
   * 并发调用合并成一次飞行请求：启动时插件自己会拉、pi 的 `refreshModels` 也会
   * 拉，两处撞在一起没必要打两个一模一样的上游请求。
   *
   * `signal` 用于给"启动时那次有界等待"设截止时间。**必须传**：上游超时是 30s，
   * 而工厂函数会被 pi await，不主动中止就会让启动陪着一次不可达的网络干等 30s。
   */
  async refreshCatalog(signal?: AbortSignal): Promise<boolean> {
    this.inflightRefresh ??= this.doRefreshCatalog(signal).finally(() => {
      this.inflightRefresh = undefined;
    });
    return await this.inflightRefresh;
  }

  private async doRefreshCatalog(signal?: AbortSignal): Promise<boolean> {
    let cred: Cred;
    try {
      // 把截止信号传进 resolve：续期是网络操作（上游 30s 超时），不接信号的话
      // "token 过期 + 网络只连不通"会让启动卡满 30s，预算形同虚设。
      cred = await this.store.resolve(signal);
    } catch {
      // 取不到凭据。分两种情况，不能一律当"未登录"处理：
      // - 确实没登录（本地就读不到凭据）→ 清空清单，分组隐藏。
      // - 有凭据但这次解析失败（续期失败、解密 helper 起不来）→ **保留/恢复**清单。
      //   把它当成未登录会让"读得到但刷不了"的一整组模型凭空消失，正是老症状
      //   （例如 WORKBUDDY_ELECTRON_BIN 指错时 100% 复现）。
      //
      // 注意"恢复"这半边是必须的：`logout` 会把 models 清空，之后用户重新登录时
      // `resolve()` 仍可能先失败一次（token 还没刷新）。只"保留"就会把空清单一直
      // 留着——状态写着"已登录"、模型却是 0 个。
      if (await this.store.credentialPresence() !== "absent") {
        if (this.models.length === 0) {
          this.applyFallback();
          this.catalogSource = "内置兜底";
        }
        return false;
      }
      this.models = [];
      this.catalogSource = "未登录";
      return false;
    }
    // `PI_OFFLINE=1`（或 `pi --offline`）是用户/CI 明确要求的"别联网"，插件自己
    // 发起的这次拉取必须同样遵守，否则 --offline 只挡住了 pi 的刷新、挡不住插件。
    // 判定与 pi 一致（见 offlineRequested），`PI_OFFLINE=0` 不算离线。
    // 已有缓存就继续用它，没有就保持现状。
    if (offlineRequested(process.env.PI_OFFLINE)) {
      if (this.liveCatalog) {
        this.models = this.liveCatalog;
        this.catalogSource = "已保存";
      }
      return false;
    }
    try {
      const models = await this.upstream.fetchModels(cred, signal);
      this.liveCatalog = models;
      this.models = models;
      this.catalogSource = "实时";
      this.catalogAuthoritative = true;
      // 两版都存：这是上游真正下发的名单，下次启动先用它注册，才能保证
      // "重启后看到的免费模型集合"与上次一致。
      await saveCatalogCache(this.variant, models);
      return true;
    } catch {
      // 中止（预算到点）与失败走同一条路：保留现有清单，别把已经注册好的清单抹掉。
      if (this.liveCatalog) {
        this.models = this.liveCatalog;
        this.catalogSource = "已保存";
      } else if (this.models.length === 0) {
        // 手上什么都没有：装回兜底清单。否则这个变体就永久停在"已登录但 0 个模型"
        // ——`logout` 清空之后重新登录、或者首拉就失败时都会踩到（老症状）。
        this.applyFallback();
      }
      return false;
    }
  }

  /**
   * 这一版该不该出现在模型列表里。
   *
   * **只读本地，绝不联网**（见 `credentialPresence`）。两种"看不到"要分开：
   * - `absent`：真的没登录 → 隐藏。
   * - `unreadable`：桌面 App 登录着，只是本机解不开（解密 helper 起不来等）
   *   → **仍然显示**。这种情况下列表里至少还有兜底清单能用来诊断；藏起来只会让
   *   用户看到"插件莫名其妙坏了"，连 `--list-models` 都查不出这一版存在。
   *
   * 早先用 `resolve()` 判定会把"能不能续期"混进来：token 过期 + 网络不可达时启动
   * 被拖到 60s；helper 坏掉时已登录用户被误判成未登录、整组消失。
   */
  async signedIn(): Promise<boolean> {
    return await this.store.credentialPresence() !== "absent";
  }

  /** 本地判定凭据在不在（绝不联网）；供常驻卡片决定显示/撤下。 */
  credentialPresence(): Promise<"ok" | "unreadable" | "absent"> {
    return this.store.credentialPresence();
  }

  /** 取凭据，失败时抛出可展示错误。 */
  async resolveCred(): Promise<Cred> {
    return await this.store.resolve();
  }

  setCard(lines: string[] | undefined): void {
    this.card = lines;
  }

  cachedCard(): string[] | undefined {
    return this.card;
  }

  /** 最近一次成功取到积分的时间；供卡片标注「更新于」。 */
  creditsRefreshedAt(): Date | undefined {
    return this.creditsCache === undefined ? undefined : new Date(this.creditsCache.at);
  }

  /**
   * 取积分：30s 内的自动绘制直接吃缓存（每次读取都是真实计费查询，自动路径
   * 不该频打上游）；缓存过期或首次调用时拉取。并发调用合并为同一次请求。
   *
   * 失败时回退旧缓存（陈旧值仍优于空白）；从未取到过就重新抛出。
   */
  async paintCredits(options?: { force?: boolean }): Promise<Credits> {
    const cached = this.creditsCache;
    if (!options?.force && cached && Date.now() - cached.at < CREDITS_TTL_MS) {
      return cached.credits;
    }
    this.inflightCredits ??= this.store.resolve()
      .then((cred) => this.upstream.fetchCredits(cred))
      .then((credits) => {
        this.creditsCache = { credits, at: Date.now() };
        return credits;
      })
      .finally(() => {
        this.inflightCredits = undefined;
      });
    try {
      return await this.inflightCredits;
    } catch (error) {
      if (cached) return cached.credits;
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.store.clear();
  }

  /** 供 OAuth 续期使用的上游客户端。 */
  get client(): WorkBuddyUpstream {
    return this.upstream;
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const runtimes = VARIANTS.map((variant) => new VariantRuntime(variant));
  const byId = new Map(runtimes.map((runtime) => [runtime.variant.id, runtime]));
  let scope = loadSettings().scope;

  /** 各版注册的模型 id 集合，供 payload hook 认领。 */
  const modelIds = new Map<string, Set<string>>();
  /** 各版当前注册的 pi 模型，供卡片渲染。 */
  const registered = new Map<string, { name: string }[]>();

  /**
   * 各版是否已登录（有可用凭据）。
   *
   * 这是"分组是否出现"的**唯一**判据——不是"清单空不空"，也不是"拉取成没成功"。
   * 早先靠"拉取失败就把清单清空"来隐藏分组，那在"有兜底清单 + 离线（跳过等待）"
   * 的组合下会漏：注册时用的是兜底清单，而没有任何一次拉取去清它，于是未登录也
   * 会列出模型。改成显式按凭据判断，兜底清单怎么变都不会误显示。
   */
  const signedIn = new Map<string, boolean>();

  function recompute(variant: WorkBuddyVariant): {
    models: ReturnType<typeof buildPiModels>;
    names: { name: string }[];
  } {
    const runtime = byId.get(variant.id)!;
    // 未登录：一个模型都不注册（整组隐藏）。启动时这个值一定已经判定过
    // （工厂里先 await signedIn() 再 apply）；尚未判定时按放行处理，由随后的
    // apply() 落定，这样已登录用户不会因为顺序问题看不到模型。
    if (signedIn.get(variant.id) === false) return { models: [], names: [] };
    const models = buildPiModels(runtime.catalog, scope);
    return { models, names: models.map((model) => ({ name: model.name })) };
  }

  /**
   * 各版上次注册时的模型签名。
   *
   * `apply()` 会在启动、目录刷新后、切换 scope 后各跑一次；每跑一次都重新
   * `registerProvider` 一遍，pi 那边要重新组装 provider、重建模型快照，而内容
   * 往往一模一样（启动时刚注册完，刷新又拿回同一份目录）。签名没变就跳过，
   * 只把真正变化的版本重注册一遍。
   */
  const appliedSignature = new Map<string, string>();

  function apply(next?: Scope) {
    if (next) scope = next;
    for (const runtime of runtimes) {
      const { models, names } = recompute(runtime.variant);
      const signature = JSON.stringify([scope, models.map((model) => [model.id, model.name, model.maxTokens])]);
      if (appliedSignature.get(runtime.variant.id) === signature) continue;
      appliedSignature.set(runtime.variant.id, signature);
      modelIds.set(runtime.variant.id, new Set(models.map((model) => model.id)));
      registered.set(runtime.variant.id, names);
      pi.registerProvider(runtime.variant.id, {
        name: runtime.variant.displayName,
        baseUrl: `${runtime.variant.billingBase}/v2`,
        api: "openai-completions",
        // 见 REGISTRATION_API_KEY：这是"让 pi 认这个 provider 已配置"的闸门，
        // 不是凭据。真 token 由 before_provider_headers 注入并覆盖它。
        apiKey: REGISTRATION_API_KEY,
        headers: { [MARKER]: runtime.variant.id },
        models,
        async refreshModels(ctx: { signal?: AbortSignal } | undefined) {
          scope = loadSettings().scope;
          // 必须把 pi 给的 signal 传下去：否则这里的拉取会一直挂到上游自己的 30s
          // 超时，而 pi 只等 15s —— 网络不可达时整个启动就陪着卡 15s 以上。
          await runtime.refreshCatalog(ctx?.signal);
          const next = recompute(runtime.variant);
          modelIds.set(runtime.variant.id, new Set(next.models.map((model) => model.id)));
          registered.set(runtime.variant.id, next.names);
          return next.models;
        },
      });
    }
  }

  /**
   * 首次注册前，先给"还没有权威清单"的那版一次有界机会。
   *
   * 注册那一刻的清单会被 pi 立刻抓进可用模型快照。早先的写法是"先注册兜底、再等、
   * 等完重注册"，于是存在一段窗口：几毫秒时快照里是兜底集合，几百毫秒后被实时集合
   * 覆盖——任何落在窗口里的观察点都会看到一个随后消失的模型。改成"先等再注册"就
   * 消掉了那个窗口：只会注册一次。
   *
   * 判据是"清单是否权威"（来自缓存或实时），不是"清单空不空"：
   * - 有落盘缓存 → 已是上次上游真正下发的名单，不必等。
   * - 没登录 → 读凭据就失败、不发请求，立刻返回。
   * - 只有兜底清单 → 等一次实时结果。
   *
   * 预算用**计时器**兜底而不是只靠 abort：abort 只对尊重信号的 fetch 有效，任何
   * 挂死的实现都会让 await 永远挂着、把 pi 的启动一起拖住。计时器保证有界。
   * （abort 只是尽力让真实 socket 早点结束，别指望它一定会释放——实测过挂死的
   * socket 能活过工厂返回；真正兜底的是计时器。）
   *
   * 边界说明（不要过度承诺）：等到了，首屏就是实时名单；没等到（慢或断网），首屏是
   * 缓存或兜底清单，**之后**若有一次拉取成功（例如 `session_start` 那次 `refreshAll()`）
   * 列表还会更新。所以"会话期内列表不再变化"是**不成立的**——目录是动态的，这里只
   * 保证不再有"注册时先给一份、随后立刻被换掉"的窗口。
   *
   * 这里**不能**再挂一个"预算到点后补拉"的后台任务：`pi` 此后很快退出进程（实测
   * `--list-models` 约 2.8s 就退），补拉来不及；而且那次不带预算的拉取会握着 socket
   * 不放，把进程拖到 15s 以上（实测）。慢网络下"能不能看到国内版"改由 CN_BUILTIN_MODELS
   * 兜住，不再依赖这次补拉。
   */
  const STARTUP_CATALOG_BUDGET_MS = 2_500;

  /**
   * 先判定两版是否已登录，再决定注册什么。
   *
   * 必须在**选择兜底清单之前**做：兜底清单是给"已登录但拉不到目录"的人用的，
   * 未登录的人一个模型都不该看到。
   *
   * 用 `signedIn()`——它只读本地凭据、**绝不联网**（见 `credentialPresence`）。
   * 这里若换成 `resolve()`，token 过期 + 网络不可达时会把启动拖到 60s。
   */
  await Promise.all(runtimes.map(async (runtime) => {
    signedIn.set(runtime.variant.id, await runtime.signedIn());
  }));

  const coldCatalogs = offlineRequested(process.env.PI_OFFLINE)
    ? []
    : runtimes.filter((runtime) => !runtime.authoritative);
  if (coldCatalogs.length > 0) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, STARTUP_CATALOG_BUDGET_MS);
    });
    try {
      await Promise.race([
        Promise.all(coldCatalogs.map(async (runtime) => {
          await runtime.refreshCatalog(controller.signal);
        })).then(() => "done" as const, () => "done" as const),
        budget,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // 首屏注册：等到了就是实时名单，没等到就是缓存/兜底清单；未登录的整组为空。
  // 这里**不能**再挂一个"预算到点后补拉"的后台任务：`pi` 在这之后很快就退出
  // 进程（实测 `--list-models` 约 2.8s 就退），补拉根本来不及；而那次不带预算的
  // 拉取会握着 socket 不放，反而把进程拖到 15s 以上（实测）。
  apply();

  /**
   * 拉一次两版的目录，然后重注册模型。
   *
   * 为什么不能只靠 pi 的 `refreshModels`：`pi` 在 refresh 被后续调用取代时会把
   * `refreshModels` 的返回值整个丢掉（`provider-composer` 里 `context.signal.aborted`
   * 直接 `return`），并且 `--list-models` 这类一次性命令**根本不发起网络刷新**。
   * 这里主动拉完并 `apply()` 重注册一次，命中与否不再依赖 pi 的刷新调度。
   */
  /**
   * 拉一次两版的目录，重判登录状态，然后重注册。
   *
   * 并发调用合并成同一次（启动时可能与别的路径撞上）；但必须能**再次**调用——
   * 切换登录状态、`/workbuddy` 刷新之后都要重跑，所以结束后清掉句柄，而不是把
   * Promise 永久缓存下来。
   */
  let refreshAllPromise: Promise<void> | undefined;
  function refreshAll(): Promise<void> {
    refreshAllPromise ??= (async () => {
      await Promise.all(runtimes.map(async (runtime) => {
        await runtime.refreshCatalog();
      }));
      // 目录拉完顺便重判登录：`/workbuddy logout` 之后要把分组撤掉，
      // 不能等到重启 pi。
      await Promise.all(runtimes.map(async (runtime) => {
        signedIn.set(runtime.variant.id, await runtime.signedIn());
      }));
      apply();
    })().finally(() => {
      refreshAllPromise = undefined;
    });
    return refreshAllPromise;
  }

  pi.on("before_provider_headers", async (event) => {
    const marker = event.headers[MARKER] ?? event.headers[MARKER.toLowerCase()];
    if (typeof marker !== "string" || marker === "" || marker === "1") return;
    const runtime = byId.get(marker);
    if (!runtime) return;
    const cred = await runtime.resolveCred();
    event.headers[MARKER] = null;
    event.headers[MARKER.toLowerCase()] = null;
    for (const [key, value] of Object.entries(chatHeaders(cred, runtime.variant))) {
      event.headers[key] = value;
    }
  });

  pi.on("before_provider_request", (event) => {
    const payload = asObject(event.payload);
    if (!payload) return;
    if (!isWorkBuddyModel(payload.model, modelIds)) return;
    return prepareChatPayload(payload);
  });

  pi.on("session_start", (_event, ctx) => {
    // 绝不阻塞会话启动：卡片是可选信息，先画未登录态再后台刷新。
    void (async () => {
      await refreshAll();
      for (const runtime of runtimes) {
        const lines = await paint(runtime, ctx, false);
        runtime.setCard(lines);
      }
    })().catch(() => undefined);
  });

  // setModel 会 await 本 handler，所以它必须永远不等网络 I/O：
  // 用缓存的卡片重画，再在后台刷新。卡片已常驻（跟随登录，不跟随模型），
  // 切到非 WorkBuddy 模型不再撤下账户/积分卡片。
  pi.on("model_select", (_event, ctx) => {
    const provider = ctx.model?.provider;
    if (typeof provider !== "string" || !modelIds.has(provider)) return;
    const runtime = byId.get(provider);
    if (!runtime) return;
    const cached = runtime.cachedCard();
    if (cached) ctx.ui.setWidget(runtime.widgetKey, cached);
    void paint(runtime, ctx, false)
      .then((lines) => runtime.setCard(lines))
      .catch(() => undefined);
  });

  /**
   * 画一张卡片（常驻）。
   *
   * 显示条件是"这一版已登录"，与会话正用哪个模型无关——查询积分不该要求
   * 先把会话切到 WorkBuddy 模型。未登录（本地判定，`absent`）的那版撤下
   * widget 与状态栏；`unreadable` 仍然显示（同 `signedIn` 的语义：藏起来只会
   * 让用户以为插件坏了）。自动路径（force=false）读 30s 积分短缓存；手动
   * 刷新（force=true，`/workbuddy c`）绕过 TTL 强制拉取。
   */
  async function paint(
    runtime: VariantRuntime,
    ctx: { ui: Ui; mode?: string; model?: { provider?: string } },
    notify: boolean,
    force = false,
  ): Promise<string[] | undefined> {
    let presence: "ok" | "unreadable" | "absent";
    try {
      presence = await runtime.credentialPresence();
    } catch {
      presence = "unreadable";
    }
    if (presence === "absent") {
      runtime.setCard(undefined);
      ctx.ui.setWidget(runtime.widgetKey, undefined);
      ctx.ui.setStatus(runtime.widgetKey, undefined);
      return undefined;
    }
    let cred: Cred | undefined;
    let credits: Credits | undefined;
    let error: string | undefined;
    try {
      cred = await runtime.resolveCred();
      credits = await runtime.paintCredits({ force });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const lines = widgetLines({
      variant: runtime.variant,
      ...cred === undefined ? {} : { cred },
      ...credits === undefined ? {} : { credits },
      ...error === undefined ? {} : { error },
      scope,
      models: registered.get(runtime.variant.id) ?? [],
      catalogSource: runtime.source,
      refreshedAt: credits === undefined ? undefined : runtime.creditsRefreshedAt(),
      // ANSI 高亮只在终端 TUI 有效；桌面（RPC）不解析转义序列，必须纯文本。
      color: ctx.mode === "tui",
    });
    runtime.setCard(lines);
    ctx.ui.setWidget(runtime.widgetKey, lines);
    ctx.ui.setStatus(
      runtime.widgetKey,
      error
        ? `${runtime.variant.displayName} 更新失败`
        : credits
          ? `${runtime.variant.displayName} 积分 ${credits.unlimited ? "∞" : credits.total}`
          : `${runtime.variant.displayName} 已登录`,
    );
    if (notify) {
      // 弹出通知带上账户名：刷新回执要能一眼对上账号（此前只有积分数字）。
      // 有低余额包时升级为 warning——桌面端按通知级别配色，比纯文本更醒目。
      const who = cred === undefined ? "" : ` ${cred.nickname || cred.uid || "已登录"}`;
      ctx.ui.notify(
        error
          ? `${runtime.variant.displayName}${who}：${error}`
          : credits === undefined
            ? `${runtime.variant.displayName}${who} 已刷新`
            : `${who.trim()} · 积分 ${creditsSummary(credits)}`,
        error || (credits !== undefined && hasLowCredit(credits)) ? "warning" : "info",
      );
    }
    return lines;
  }

  pi.registerCommand("workbuddy", {
    description: "WorkBuddy 账户/积分与设置：刷新积分、免费/全部（含付费）模型、断开登录",
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().toLowerCase();

      /**
       * 积分直达：强制拉取两版（或指定一版）的最新积分并重画卡片。
       *
       * 这是"⟳ 刷新"入口的实际执行体：绕过 30s 短缓存（用户显式要求的
       * 就是最新值），刷新期间状态栏标「刷新中…」，完成回执走 notify。
       */
      const refreshCredits = async (which?: "cn" | "ai") => {
        const targets: VariantRuntime[] = [];
        if (which === undefined) {
          targets.push(...runtimes);
        } else {
          const target = byId.get(which === "cn" ? CN_VARIANT.id : AI_VARIANT.id);
          if (target) targets.push(target);
        }
        for (const runtime of targets) {
          if ((await runtime.credentialPresence()) === "absent") continue;
          ctx.ui.setStatus(runtime.widgetKey, `${runtime.variant.displayName} 刷新中…`);
        }
        await Promise.all(targets.map(async (runtime) => {
          await refreshAll();
          await paint(runtime, ctx, true, true);
        }));
      };

      /** 切换模型范围（免费 / 含付费），并给出明确回执。 */
      const setScope = async (next: Scope) => {
        await saveSettings(next);
        apply(next);
        await refreshAll();
        const count = runtimes.reduce((sum, runtime) => sum + (registered.get(runtime.variant.id)?.length ?? 0), 0);
        ctx.ui.notify(
          next === "all"
            ? `已列出全部模型（含付费）：两版共 ${count} 个。付费模型会消耗积分，请留意倍率。`
            : `已只列出免费模型：两版共 ${count} 个。`,
          "info",
        );
      };

      /** 断开登录（可只断开其中一版），并立刻撤下对应的模型分组。 */
      const logout = async (which?: "cn" | "ai") => {
        const target = which === "cn" ? byId.get(CN_VARIANT.id) : which === "ai" ? byId.get(AI_VARIANT.id) : undefined;
        if (target) await target.logout();
        else for (const runtime of runtimes) await runtime.logout();
        await refreshAll();
        ctx.ui.notify(target ? `${target.variant.displayName} 已断开登录。` : "两版均已断开登录。", "info");
      };

      // 付费开关的显式参数形式；"全部/收费" 与 "免费" 都接受，方便手打。
      if (cmd === "free" || cmd === "免费") return void await setScope("free");
      if (cmd === "all" || cmd === "paid" || cmd === "全部" || cmd === "收费") {
        return void await setScope("all");
      }
      if (cmd === "logout" || cmd === "disconnect" || cmd === "logout-cn" || cmd === "logout-ai") {
        return void await logout(cmd.endsWith("-cn") ? "cn" : cmd.endsWith("-ai") ? "ai" : undefined);
      }
      // 积分直达：/workbuddy c（或 credits/r/refresh），可选后缀 -cn / -ai 只刷一版。
      if (cmd === "c" || cmd === "credits" || cmd === "积分" || cmd === "r" || cmd === "refresh"
        || cmd === "刷新" || cmd === "c-cn" || cmd === "c-ai" || cmd === "credits-cn" || cmd === "credits-ai"
        || cmd === "r-cn" || cmd === "r-ai") {
        return void await refreshCredits(cmd.endsWith("-cn") ? "cn" : cmd.endsWith("-ai") ? "ai" : undefined);
      }

      // 无参数：弹菜单。菜单项直接标出当前状态，避免"点了不知道发生了什么"。
      const paidLabel = scope === "free" ? "列出全部模型（含付费）" : "只列出免费模型";
      const pick = await ctx.ui.select(`WorkBuddy（当前：${scope === "free" ? "仅免费" : "含付费"}）`, [
        "查看积分（刷新）",
        paidLabel,
        "断开登录",
      ]);
      if (pick === undefined) return;
      if (pick === paidLabel) await setScope(scope === "free" ? "all" : "free");
      else if (pick === "断开登录") await logout();
      else await refreshCredits();
    },
  });
}

// ---------------------------------------------------------------------------
// payload 规整（沿用国际版既有行为，两版共用）
// ---------------------------------------------------------------------------

function asObject(payload: unknown): Record<string, unknown> | undefined {
  const value = typeof payload === "string"
    ? (() => {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })()
    : payload;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * `before_provider_request` 不带 provider，所以 payload 按模型 id 归属。
 * 没有这道闸，hook 会改写其他所有 provider 的请求（developer role、
 * tool_choice、stream）。
 */
export function isWorkBuddyModel(modelId: unknown, idsByVariant: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (typeof modelId !== "string") return false;
  for (const ids of idsByVariant.values()) {
    if (ids.has(modelId)) return true;
  }
  return false;
}

function stripAssistantReasoning(messages: unknown[]): void {
  for (const item of messages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const msg = item as Record<string, unknown>;
    if (msg.role !== "assistant") continue;
    delete msg.reasoning;
    delete msg.thinking;
    delete msg.reasoning_content;
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part) => {
      if (typeof part !== "object" || part === null) return true;
      const type = (part as { type?: string }).type;
      return type !== "reasoning" && type !== "thinking";
    });
    if (Array.isArray(msg.content) && msg.content.length === 0) msg.content = "";
  }
}

export function prepareChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  payload.stream = true;
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (typeof message === "object" && message !== null && !Array.isArray(message)
        && (message as Record<string, unknown>).role === "developer") {
        (message as Record<string, unknown>).role = "system";
      }
    }
    if (messages.length > 0 && (messages[0] as { role?: string } | undefined)?.role !== "system") {
      messages.unshift({ role: "system", content: "You are a helpful assistant." });
    }
    stripAssistantReasoning(messages);
  }
  if (payload.model === "deepseek-v4.1-flash") {
    const current = Number(payload.max_tokens);
    payload.max_tokens = Number.isFinite(current) && current > 0
      ? Math.min(current, FLASH_MAX_TOKENS)
      : FLASH_MAX_TOKENS;
  }
  if ("tool_choice" in payload) {
    const choice = payload.tool_choice;
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      }
    } else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>;
      const type = typeof wrapped.type === "string" ? wrapped.type.trim().toLowerCase() : "";
      if (type === "none") {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      } else if (type === "auto" || type === "required") {
        payload.tool_choice = type;
      } else if (type === "function") {
        const fn = typeof wrapped.function === "object" && wrapped.function !== null
          ? (wrapped.function as Record<string, unknown>)
          : undefined;
        const name = (typeof fn?.name === "string" ? fn.name : typeof wrapped.name === "string" ? wrapped.name : "").trim();
        payload.tool_choice = name || "auto";
      } else {
        delete payload.tool_choice;
      }
    } else {
      delete payload.tool_choice;
    }
  }
  // ponytail: never inject reasoning_effort — upstream sends a bare request when no
  // level is chosen, so "Default" must stay Default instead of silently becoming high.
  return payload;
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

if (process.argv.includes("--self-check")) {
  const nested = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: "a", refreshToken: "r", expiresAt: 2000, domain: "www.workbuddy.ai" },
    account: { uid: "u1", nickname: "n" },
  }));
  if (nested?.uid !== "u1" || nested.expiresAtMs !== 2_000_000) throw new Error("parse nested");
  const payload = prepareChatPayload({
    model: "hy3",
    messages: [{ role: "developer", content: "sys" }, { role: "user", content: "hi" }],
    tool_choice: { type: "function", function: { name: "foo" } },
  });
  if (payload.stream !== true) throw new Error("stream");
  if ((payload.messages as { role: string }[])[0].role !== "system") throw new Error("system");
  if (payload.tool_choice !== "foo") throw new Error("tool_choice");
  if (payload.reasoning_effort !== undefined) throw new Error("no injected effort");
  const kept = prepareChatPayload({ messages: [], reasoning_effort: "max" });
  if (kept.reasoning_effort !== "max") throw new Error("explicit effort preserved");
  if (LOW_HIGH.low !== "low" || HIGH_ONLY.low !== null || HIGH_ONLY.high !== "high") throw new Error("effort map");
  const ids = new Map<string, Set<string>>([[CN_VARIANT.id, new Set(["hy3"])], [AI_VARIANT.id, new Set(["gpt-5.5"])]]);
  if (!isWorkBuddyModel("hy3", ids)) throw new Error("scope: cn model accepted");
  if (!isWorkBuddyModel("gpt-5.5", ids)) throw new Error("scope: ai model accepted");
  if (isWorkBuddyModel("grok-4.6", ids)) throw new Error("scope: foreign model must be rejected");
  if (isWorkBuddyModel(undefined, ids) || isWorkBuddyModel(42, ids)) throw new Error("scope: non-string rejected");
  if (thinkingLevelMap(["high"], true).off !== "off") throw new Error("off");
  const prepended = prepareChatPayload({ messages: [{ role: "user", content: "hi" }] });
  if ((prepended.messages as { role: string }[])[0].role !== "system") throw new Error("prepend");
  if (!creditsAreFree("x0.00") || creditsAreFree("x1.00")) throw new Error("credits free");
  // 国内版的倍率带 `credits` 单位，必须归一化后才能判免费。
  if (!creditsAreFree("x0.00 credits")) throw new Error("cn free credits");
  if (creditsAreFree("x2.00 credits")) throw new Error("cn paid credits");
  if (normalizeCredits("x2.00 credits") !== "x2.00") throw new Error("cn credits normalize");
  // 卡片归属：两版各自认领，其他 provider 一律不认领。
  if (!showsWorkBuddyCard(CN_VARIANT.id, [CN_VARIANT.id, AI_VARIANT.id])) throw new Error("card: cn shown");
  if (!showsWorkBuddyCard(AI_VARIANT.id, [CN_VARIANT.id, AI_VARIANT.id])) throw new Error("card: ai shown");
  if (showsWorkBuddyCard("GROKCPA", [CN_VARIANT.id, AI_VARIANT.id])) throw new Error("card: foreign hidden");
  if (showsWorkBuddyCard(undefined, [CN_VARIANT.id]) || showsWorkBuddyCard(42, [CN_VARIANT.id])) {
    throw new Error("card: unknown provider hidden");
  }
  if (!showsWorkBuddyCard("GROKCPA", [CN_VARIANT.id], true)) throw new Error("card: explicit override");
  // 推理档映射。
  const mapped = buildPiModels([{
    id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1_000_000, maxTokens: 131_072,
    supportsImages: true, supportsReasoning: true, supportedEfforts: ["low", "high", "max"],
    canDisableThinking: true, credits: "x0.06 credits", free: false,
  }], "all");
  if (mapped[0].thinkingLevelMap.off !== "off" || mapped[0].thinkingLevelMap.medium !== null) {
    throw new Error("efforts map");
  }
  if (mapped[0].name !== "GLM-5.3-Flash · x0.06 credits") throw new Error("model name");
  // scope 过滤。
  const freeOnly = buildPiModels([
    { id: "free", name: "Free", contextWindow: 1000, maxTokens: 100, supportsImages: false, supportsReasoning: false, canDisableThinking: false, credits: "x0.00 credits", free: true },
    { id: "paid", name: "Paid", contextWindow: 1000, maxTokens: 100, supportsImages: false, supportsReasoning: false, canDisableThinking: false, credits: "x0.79 credits", free: false },
  ], "free");
  if (freeOnly.length !== 1 || freeOnly[0].id !== "free") throw new Error("scope free filter");
  // flash 封顶。
  const flash = buildPiModels(builtinAsUpstream(), "free").find((model) => model.id === "deepseek-v4.1-flash");
  if (flash?.maxTokens !== FLASH_MAX_TOKENS) throw new Error("flash cap");
  const looped = prepareChatPayload({
    model: "deepseek-v4.1-flash",
    max_tokens: 128_000,
    messages: [{ role: "assistant", content: "done", reasoning: "OK.\nLet me write.", thinking: "Go." }],
  });
  const assistant = (looped.messages as Record<string, unknown>[])[1];
  if (assistant.reasoning !== undefined || assistant.thinking !== undefined) throw new Error("reasoning replay");
  if (looped.max_tokens !== FLASH_MAX_TOKENS) throw new Error("flash payload cap");
  // 产品配置解析（国际版兜底）。
  const fromCache = parseProductConfig(JSON.stringify({
    models: [{
      id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00",
      maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    }],
  }));
  if (!fromCache) throw new Error("parse config");
  if (freeModelIds(fromCache).length !== 1) throw new Error("free ids");
  // 兜底里只许剔掉**实测上游不提供**的 id。特别地：`hy4-preview-f` 虽然不在 CLI
  // 名单里，实测请求返回 200，是个能用的免费模型，绝不能因为"名单里没有"就删掉
  // ——那等于凭空没收一个可用档位（这个错误犯过一次，所以钉在这里）。
  const filteredFallback = withoutUnservableModels([
    { id: "hy4-preview-f", name: "Hy4 preview", credits: "x0.00", contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, supportsReasoning: true, canDisableThinking: false },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", credits: "x3.47", contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, supportsReasoning: true, canDisableThinking: false },
    { id: "gpt-6-astra", name: "GPT-6 Astra", credits: "x6.67", contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, supportsReasoning: true, canDisableThinking: false },
  ]);
  if (filteredFallback.length !== 1 || filteredFallback[0].id !== "hy4-preview-f") {
    throw new Error("fallback filtering must drop only unservable ids");
  }
  // 可用但"不在 CLI 名单里"的免费模型必须留在兜底清单里。
  if (!BUILTIN_MODELS.some((model) => model.id === "hy4-preview-f")) {
    throw new Error("builtin fallback must keep servable hy4-preview-f");
  }
  if (BUILTIN_MODELS.some((model) => UNSERVABLE_FALLBACK_IDS.has(model.id))) {
    throw new Error("builtin list leaks unservable model");
  }
  if ((FREE_IDS as readonly string[]).some((id) => UNSERVABLE_FALLBACK_IDS.has(id))) {
    throw new Error("free id list leaks unservable model");
  }
  // 旧版本可能把不可用条目写进过缓存；读取端必须同样剔掉。
  const staleCache = parseCatalogCache(JSON.stringify({
    version: 1,
    models: [
      { id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 1_000_000, maxTokens: 64_000, free: false },
      { id: "hy3", name: "Hy3", contextWindow: 192_000, maxTokens: 64_000, free: true },
    ],
  }));
  if (staleCache?.length !== 1 || staleCache[0].id !== "hy3") {
    throw new Error("cache read must drop app-only rows");
  }
  // widget 渲染。
  const lines = widgetLines({
    variant: AI_VARIANT,
    cred: {
      accessToken: "a", refreshToken: "r", expiresAtMs: Date.UTC(2027, 8, 12, 1, 30, 0),
      domain: "www.workbuddy.ai", uid: "u", nickname: "user@example.com", source: "desktop",
    },
    credits: { total: 349, accounts: [{ packageName: "Free Plan Subscription", remain: 349, size: 350 }] },
    scope: "free",
    models: [{ name: "Hy3 · x0.00" }],
    catalogSource: "实时",
  });
  if (!lines.some((line) => line.includes("user@example.com"))) throw new Error("widget account");
  if (!lines.some((line) => line.includes("合计 349"))) throw new Error("widget total");
  if (!lines.some((line) => line.includes("WorkBuddy AI"))) throw new Error("widget name");
  // 卡片必须有刷新入口行，且带直达命令；有刷新时间就一并标注。
  if (!lines.some((line) => line.includes("⟳ 刷新积分") && line.includes("/workbuddy c"))) {
    throw new Error("widget refresh hint");
  }
  const stamped = widgetLines({
    variant: AI_VARIANT,
    cred: { accessToken: "a", refreshToken: "r", expiresAtMs: 0, domain: "www.workbuddy.ai", uid: "u", source: "desktop" },
    credits: { total: 349, accounts: [{ packageName: "Free", remain: 349, size: 350 }] },
    scope: "free",
    models: [],
    refreshedAt: new Date(2027, 8, 12, 8, 5, 9),
  });
  if (!stamped.some((line) => line.includes("更新于 08:05:09"))) throw new Error("widget refreshed-at");
  // 摘要行：有容量给占比，多包给包数，低余额包计数警示。
  const summary = creditsSummary({
    total: 40,
    accounts: [
      { packageName: "A", remain: 5, size: 100 },
      { packageName: "B", remain: 35, size: 350 },
    ],
  });
  if (!summary.includes("40/450") || !summary.includes("9%") || !summary.includes("2 个包") || !summary.includes("⚠ 1 个偏低")) {
    throw new Error(`credits summary: ${summary}`);
  }
  // 明细行：低余额的包排最前（需要关注的先看到），行首 ⚠，带精确数字与百分比。
  const rows = creditRows({
    total: 40,
    accounts: [
      { packageName: "B", remain: 35, size: 350 },
      { packageName: "A", remain: 5, size: 100 },
    ],
  });
  const firstPack = rows.find((line) => line.includes("A"));
  const secondPack = rows.find((line) => line.includes("B"));
  if (!firstPack || !secondPack || rows.indexOf(firstPack!) > rows.indexOf(secondPack!)) {
    throw new Error("credit rows: low-balance pack must sort first");
  }
  if (!firstPack!.includes("⚠") || !firstPack!.includes("5/100（5%）")) throw new Error("credit rows: warning flag");
  if (!secondPack!.includes("35/350（10%）")) throw new Error("credit rows: exact numbers");
  // 无容量信息（size=0）不编造百分比，只报合计。
  const bare = creditsSummary({ total: 123, accounts: [{ packageName: "X", remain: 123, size: 0 }] });
  if (bare !== "合计 123") throw new Error(`credits summary bare: ${bare}`);
  // 桌面（RPC）路径必须是纯文本：widgetLines 默认不带 ANSI 转义（桌面端不解析，
  // 着色会变成乱码）。
  if (lines.some((line) => line.includes("\u001b["))) throw new Error("widget must be plain text by default");
  // 账户名上头部：第一行就能对上是谁的账号。
  if (!lines[0]!.includes("user@example.com")) throw new Error("widget header must carry account name");
  // 终端 TUI 路径：color=true 才着色（暗色主题下用亮色高亮），且每行闭合 reset。
  const colored = widgetLines({
    variant: AI_VARIANT,
    cred: { accessToken: "a", refreshToken: "r", expiresAtMs: 0, domain: "www.workbuddy.ai", uid: "u", nickname: "user@example.com", source: "desktop" },
    credits: { total: 5, accounts: [{ packageName: "Free", remain: 5, size: 100 }] },
    scope: "free",
    models: [],
    color: true,
  });
  if (!colored[0]!.includes("\u001b[1m\u001b[96m")) throw new Error("colored header");
  if (!colored.some((line) => line.includes("\u001b[91m"))) throw new Error("low-credit rows must be red in TUI");
  if (colored.some((line) => line.includes("\u001b[") && !line.endsWith("\u001b[0m"))) {
    throw new Error("every colored line must reset");
  }
  // 明细行数有硬上限：积分包多的账号（实测可达 58 个）不能把卡片撑到上百行。
  const many = creditRows({
    total: 0,
    accounts: Array.from({ length: 6 }, (_, i) => ({ packageName: `P${i}`, remain: 1, size: 10 })),
  });
  const packRows = many.filter((line) => line.includes("（"));
  if (packRows.length !== 4) throw new Error(`credit rows must cap at 4 packs, got ${packRows.length}`);
  if (!many.some((line) => line.includes("其余 2 个包"))) throw new Error("overflow packs must be summarized");
  // 企业无上限的渲染不带数字。
  const unlimited = widgetLines({
    variant: CN_VARIANT,
    cred: { accessToken: "a", refreshToken: "", expiresAtMs: 0, domain: "codebuddy.cn", uid: "u", source: "desktop" },
    credits: { total: 0, accounts: [{ packageName: "enterprise", remain: 0, size: 0, unlimited: true }], unlimited: true },
    scope: "all",
    models: [],
  });
  if (!unlimited.some((line) => line.includes("无上限"))) throw new Error("enterprise unlimited");
  // 变体描述符与区域判定。
  if (regionOf("www.codebuddy.cn") !== "cn") throw new Error("region cn");
  if (regionOf("www.workbuddy.ai") !== "global" || regionOf("x.workbuddy.ai") !== "global") throw new Error("region global");
  if (regionOf("") !== "cn") throw new Error("region empty is cn");
  if (variantsCount() !== 2) throw new Error("two variants");
  // 国内版必须有非空兜底清单：留空会让"网络慢于预算"变成"永久看不到国内版"，
  // 且无法自愈（拉不到就写不出缓存，下次启动还是空的）。
  if (CN_BUILTIN_MODELS.length === 0) throw new Error("CN needs a fallback catalog");
  if (!CN_BUILTIN_MODELS.some((model) => creditsAreFree(model.credits))) {
    throw new Error("CN fallback must contain a free model");
  }
  // 判"是否登录"必须是**本地**操作，不能联网。用 resolve() 会把"能不能续期"混进来：
  // token 过期 + 网络不可达时启动被拖到 60s；解密 helper 坏掉时已登录用户被判成
  // 未登录、整组消失。这里静态钉住方法名，防止有人改回去。
  if (typeof WorkBuddyCredentialStore.prototype.credentialPresence !== "function") {
    throw new Error("credential presence must be a local-only probe");
  }
  // 目录落盘缓存：写进去的目录必须能原样读回来，否则"已保存"会是空的。
  const cacheRoundTrip = parseCatalogCache(JSON.stringify({
    version: 1,
    models: [{
      id: "hy3", name: "Hy3", contextWindow: 192_000, maxTokens: 64_000,
      supportsImages: true, supportsReasoning: true, supportedEfforts: ["low", "high"],
      canDisableThinking: false, credits: "x0.00", free: true,
    }],
  }));
  if (cacheRoundTrip?.length !== 1 || cacheRoundTrip[0].id !== "hy3" || !cacheRoundTrip[0].free) {
    throw new Error("catalog cache round-trip");
  }
  // 版本不对、结构不对、没有可用行——都必须读不出来，不能拿垃圾当目录。
  if (parseCatalogCache(JSON.stringify({ version: 2, models: [] })) !== undefined) throw new Error("cache version gate");
  if (parseCatalogCache("not json") !== undefined) throw new Error("cache bad json");
  if (parseCatalogCache(JSON.stringify({ version: 1, models: [{ id: "x" }] })) !== undefined) {
    throw new Error("cache drops rows without windows");
  }
  console.log("ok");
}

function variantsCount(): number {
  return VARIANTS.length;
}
