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
/** 产品配置缓存 env（国际版）。 */
const PRODUCT_CONFIG_ENV = "WORKBUDDYAI_PRODUCT_CONFIG";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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

const FREE_IDS = ["hy3", "deepseek-v4.1-flash", "hy4-preview-f"] as const;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
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
  return { source: "cache", models };
}

export function loadProductConfig(path = productConfigPath()): ProductConfig {
  try {
    const parsed = parseProductConfig(readFileSync(path, "utf8"));
    if (parsed) return parsed;
  } catch { /* missing/unreadable cache → builtin */ }
  return { source: "builtin", models: BUILTIN_MODELS };
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

/** 卡片归属：只属于真正跑该版模型的会话。 */
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

export function widgetLines(input: {
  variant: WorkBuddyVariant;
  cred?: Cred;
  credits?: Credits;
  error?: string;
  scope: Scope;
  models: { name: string }[];
  catalogSource?: string;
}): string[] {
  const scope = input.scope;
  const lines = [
    `${input.variant.displayName} · ${input.variant.region === "cn" ? "国内版" : "国际版"} `
    + `· ${scope === "all" ? "全部模型" : "仅免费模型"}`,
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
  lines.push(`账号  已登录  ${input.cred.nickname || input.cred.uid}`);
  lines.push(`令牌  ${fmtExpiry(input.cred.expiresAtMs)} 过期（自动续期）`);
  if (input.credits) {
    lines.push(
      input.credits.unlimited
        ? "积分  无上限"
        : `积分  合计 ${input.credits.total}`,
    );
    for (const pack of input.credits.accounts) {
      const right = pack.unlimited
        ? "无上限"
        : pack.size > 0 ? `${pack.remain} / ${pack.size}` : String(pack.remain);
      lines.push(`  ${pack.packageName}  剩余 ${right}`);
      const drawn = bar(pack.remain, pack.size);
      if (drawn) lines.push(`  ${drawn}`);
    }
  } else if (input.error) {
    lines.push(`积分  ${input.error}`);
  }
  if (input.catalogSource) lines.push(`目录  ${input.catalogSource}`);
  const names = input.models.map((model) => model.name).join("  |  ") || "（无模型）";
  lines.push(`模型  ${names}`);
  lines.push("设置  /workbuddy");
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
  private card: string[] | undefined;

  constructor(variant: WorkBuddyVariant) {
    this.variant = variant;
    this.widgetKey = variant.id;
    this.upstream = new WorkBuddyUpstream({ variant });
    this.store = new WorkBuddyCredentialStore({
      variant,
      agentDir: agentDir(),
      refresh: (cred) => this.upstream.refreshAccess(cred),
    });
    this.applyFallback();
  }

  /** 装载兜底目录：国际版用产品配置缓存，国内版无兜底（隐藏分组）。 */
  private applyFallback(): void {
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
      return;
    }
    // 国内版没有离线兜底：目录只来自 `/v3/config`，拉不到就先空着，
    // 由 refreshCatalog 填充。
    this.models = [];
    this.catalogSource = "尚未拉取";
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

  /**
   * 拉取实时目录；失败时保留现有清单并返回 false。
   *
   * 国内版首次拉取失败时清单仍为空——没凭据就整组隐藏，比给出一份选了必然
   * 报错的兜底列表要好。
   */
  async refreshCatalog(): Promise<boolean> {
    let cred: Cred;
    try {
      cred = await this.store.resolve();
    } catch {
      // 未登录：国内版与没兜底的国际版都清空，保证分组隐藏。
      if (this.variant.catalog === "v3-config") {
        this.models = [];
        this.catalogSource = "未登录";
      }
      return false;
    }
    try {
      const models = await this.upstream.fetchModels(cred);
      this.liveCatalog = models;
      this.models = models;
      this.catalogSource = "实时";
      return true;
    } catch {
      if (this.liveCatalog) {
        this.models = this.liveCatalog;
        this.catalogSource = "已保存";
      }
      return false;
    }
  }

  /** 是否有可用凭据（决定分组是否显示）。 */
  async signedIn(): Promise<boolean> {
    try {
      await this.store.resolve();
      return true;
    } catch {
      return false;
    }
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

  async paintCredits(): Promise<Credits> {
    const cred = await this.store.resolve();
    return await this.upstream.fetchCredits(cred);
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

  function recompute(variant: WorkBuddyVariant): {
    models: ReturnType<typeof buildPiModels>;
    names: { name: string }[];
  } {
    const runtime = byId.get(variant.id)!;
    const models = buildPiModels(runtime.catalog, scope);
    return { models, names: models.map((model) => ({ name: model.name })) };
  }

  function apply(next?: Scope) {
    if (next) scope = next;
    for (const runtime of runtimes) {
      const { models, names } = recompute(runtime.variant);
      modelIds.set(runtime.variant.id, new Set(models.map((model) => model.id)));
      registered.set(runtime.variant.id, names);
      pi.registerProvider(runtime.variant.id, {
        name: runtime.variant.displayName,
        baseUrl: `${runtime.variant.billingBase}/v2`,
        api: "openai-completions",
        headers: { [MARKER]: runtime.variant.id },
        models,
        async refreshModels() {
          scope = loadSettings().scope;
          await runtime.refreshCatalog();
          const next = recompute(runtime.variant);
          modelIds.set(runtime.variant.id, new Set(next.models.map((model) => model.id)));
          registered.set(runtime.variant.id, next.names);
          return next.models;
        },
      });
    }
  }

  apply();

  /** 后台拉一次两版的目录，然后重注册模型。 */
  async function refreshAll(): Promise<void> {
    await Promise.all(runtimes.map(async (runtime) => {
      await runtime.refreshCatalog();
    }));
    apply();
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
  // 用缓存的卡片重画，再在后台刷新。
  pi.on("model_select", (_event, ctx) => {
    const provider = ctx.model?.provider;
    let matched = false;
    for (const runtime of runtimes) {
      if (!showsWorkBuddyCard(provider, [...modelIds.keys()])) {
        runtime.setCard(undefined);
        ctx.ui.setWidget(runtime.widgetKey, undefined);
        ctx.ui.setStatus(runtime.widgetKey, undefined);
        continue;
      }
      if (provider !== runtime.variant.id) continue;
      matched = true;
      const cached = runtime.cachedCard();
      if (cached) ctx.ui.setWidget(runtime.widgetKey, cached);
    }
    if (!matched) return;
    const runtime = byId.get(provider as string);
    if (!runtime) return;
    void paint(runtime, ctx, false)
      .then((lines) => runtime.setCard(lines))
      .catch(() => undefined);
  });

  /** 画一张卡片；返回画出的行，隐藏时返回 undefined。 */
  async function paint(
    runtime: VariantRuntime,
    ctx: { ui: Ui; model?: { provider?: string } },
    notify: boolean,
    force = false,
  ): Promise<string[] | undefined> {
    const ids = [...modelIds.keys()];
    if (!showsWorkBuddyCard(ctx.model?.provider, ids, force)) {
      // 只有当当前会话不在用**任何**一版模型时才隐藏这张卡片。
      return undefined;
    }
    let cred: Cred | undefined;
    let credits: Credits | undefined;
    let error: string | undefined;
    try {
      cred = await runtime.resolveCred();
      credits = await runtime.paintCredits();
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
    });
    ctx.ui.setWidget(runtime.widgetKey, lines);
    ctx.ui.setStatus(
      runtime.widgetKey,
      credits
        ? `积分 ${credits.unlimited ? "∞" : credits.total}`
        : cred ? `${runtime.variant.displayName} 已登录` : `${runtime.variant.displayName} 未登录`,
    );
    if (notify) {
      ctx.ui.notify(
        error
          ? `${runtime.variant.displayName}：${error}`
          : `${runtime.variant.displayName} 已刷新 · 积分 ${credits?.unlimited ? "无上限" : credits?.total ?? "?"}`,
        error ? "warning" : "info",
      );
    }
    return lines;
  }

  pi.registerCommand("workbuddy", {
    description: "WorkBuddy 设置：刷新模型与积分、免费/全部模型、断开登录",
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().toLowerCase();
      if (cmd === "free" || cmd === "all") {
        await saveSettings(cmd);
        apply(cmd);
        for (const runtime of runtimes) await paint(runtime, ctx, true, true);
        return;
      }
      if (cmd === "logout" || cmd === "disconnect" || cmd === "logout-cn" || cmd === "logout-ai") {
        const target = cmd.endsWith("-cn")
          ? byId.get(CN_VARIANT.id)
          : cmd.endsWith("-ai") ? byId.get(AI_VARIANT.id) : undefined;
        if (target) await target.logout();
        else for (const runtime of runtimes) await runtime.logout();
        await refreshAll();
        for (const runtime of runtimes) await paint(runtime, ctx, true, true);
        return;
      }
      const pick = await ctx.ui.select("WorkBuddy 设置", [
        "刷新模型与积分",
        scope === "free" ? "列出全部模型（含付费）" : "只列出免费模型",
        "断开登录",
      ]);
      if (pick === undefined) return;
      if (pick.startsWith("列出全部")) {
        await saveSettings("all");
        apply("all");
      } else if (pick.startsWith("只列出")) {
        await saveSettings("free");
        apply("free");
      } else if (pick === "断开登录") {
        for (const runtime of runtimes) await runtime.logout();
      } else {
        await refreshAll();
      }
      for (const runtime of runtimes) await paint(runtime, ctx, true, true);
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
  console.log("ok");
}

function variantsCount(): number {
  return VARIANTS.length;
}
