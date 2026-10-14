// WorkBuddy AI 国际版。登录走插件 OAuth 弹窗，桌面凭据仅作回退。推理档读产品配置。
import { readFileSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "workbuddy";
const MARKER = "X-Pi-WorkBuddy";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const AUTH_ENV = "WORKBUDDY_AUTH_FILE";
const AUTH_FILE = "workbuddy-desktop-ai.info";
const PRODUCT_CONFIG_ENV = "WORKBUDDYAI_PRODUCT_CONFIG";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
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

type Cred = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
};

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

const FREE_IDS = ["hy3", "deepseek-v4.1-flash", "hy4-preview-f"] as const;
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

export function creditsAreFree(credits: string | undefined): boolean {
  if (credits === undefined) return false;
  return /^x?0(?:\.0+)?$/u.test(credits.trim());
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

export function freeModelIds(config: ProductConfig): readonly string[] {
  if (config.source === "builtin") return FREE_IDS;
  const free = config.models.filter((m) => creditsAreFree(m.credits)).map((m) => m.id);
  return free.length > 0 ? free : FREE_IDS;
}

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

export function buildPiModels(config: ProductConfig, scope: Scope) {
  const byId = new Map<string, ProductModel>();
  if (config.source === "cache") {
    for (const model of config.models) byId.set(model.id, model);
  }
  for (const model of BUILTIN_MODELS) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  const free = new Set(freeModelIds(config));
  const rows = [...byId.values()].filter((model) => scope === "all" || free.has(model.id));
  return rows.flatMap((row) => {
    if (row.contextWindow <= 0 || row.maxTokens <= 0) return [];
    const efforts = row.supportsReasoning
      ? (row.supportedEfforts?.length ? row.supportedEfforts : EFFORTS)
      : [];
    const credits = row.credits ?? "x?";
    return [{
      id: row.id,
      name: `${row.name} · ${credits}`,
      reasoning: row.supportsReasoning,
      thinkingLevelMap: thinkingLevelMap(efforts, row.canDisableThinking),
      input: (row.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: row.contextWindow,
      maxTokens: row.id === "deepseek-v4.1-flash" ? Math.min(row.maxTokens, FLASH_MAX_TOKENS) : row.maxTokens,
      compat: COMPAT,
    }];
  });
}

function desktopCandidates(): string[] {
  const env = process.env[AUTH_ENV]?.trim();
  if (env) return [env];
  const home = homedir();
  const rel = ["CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILE] as const;
  if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...rel)];
  if (process.platform === "win32") {
    return [join(home, "AppData", "Local", ...rel), join(home, "AppData", "Roaming", ...rel)];
  }
  return [join(home, ".config", ...rel)];
}

function ownPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), ".workbuddy-auth.json");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expiryToMs(value: number): number {
  if (value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

export function parseWorkBuddyAuth(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  const nested = typeof document.auth === "object" && document.auth !== null;
  const auth = (nested ? document.auth : document) as Record<string, unknown>;
  const identity = (
    nested && typeof document.account === "object" && document.account !== null
      ? document.account
      : document
  ) as Record<string, unknown>;
  const accessToken = typeof auth.accessToken === "string" ? auth.accessToken : "";
  if (accessToken === "") return undefined;
  const enterpriseId = optionalString(identity.enterpriseId);
  const nickname = optionalString(identity.nickname);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: typeof auth.expiresAt === "number" ? expiryToMs(auth.expiresAt) : 0,
    domain: optionalString(auth.domain) ?? "",
    uid: optionalString(identity.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

function parseOwn(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || typeof document.credential !== "object" || document.credential === null) {
    return undefined;
  }
  const stored = document.credential as Record<string, unknown>;
  const accessToken = typeof stored.accessToken === "string" ? stored.accessToken : "";
  if (accessToken === "") return undefined;
  const enterpriseId = optionalString(stored.enterpriseId);
  const nickname = optionalString(stored.nickname);
  return {
    accessToken,
    refreshToken: typeof stored.refreshToken === "string" ? stored.refreshToken : "",
    expiresAtMs: typeof stored.expiresAtMs === "number" ? stored.expiresAtMs : 0,
    domain: optionalString(stored.domain) ?? "",
    uid: optionalString(stored.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function current(): Promise<Cred | undefined> {
  const own = await readText(ownPath()).then((text) => (text ? parseOwn(text) : undefined));
  let desktop: Cred | undefined;
  for (const path of desktopCandidates()) {
    const text = await readText(path);
    if (!text) continue;
    desktop = parseWorkBuddyAuth(text);
    if (desktop) break;
  }
  if (!desktop) return own;
  if (!own) return desktop;
  return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
}

async function saveOwn(cred: Cred): Promise<void> {
  await writeFile(ownPath(), JSON.stringify({ version: 1, credential: cred }), { mode: 0o600 });
}

async function refreshAccess(cred: Cred): Promise<Cred> {
  const response = await fetch(`${GLOBAL_BASE}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Origin: GLOBAL_BASE,
      Referer: `${GLOBAL_BASE}/`,
      "User-Agent": CLIENT_UA,
      "X-Refresh-Token": cred.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = (await response.json()) as { code?: number; msg?: string; data?: Record<string, unknown> };
  const data = envelope.data ?? {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (!response.ok || envelope.code !== 0 || accessToken === "") {
    throw new Error(envelope.msg || "workbuddy token refresh failed; sign in again in WorkBuddy AI");
  }
  return {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : cred.refreshToken,
    expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0
      ? Date.now() + data.expiresIn * 1000
      : cred.expiresAtMs,
    domain: typeof data.domain === "string" && data.domain !== "" ? data.domain : cred.domain,
  };
}

let inflight: Promise<Cred> | undefined;

async function resolveCred(): Promise<Cred> {
  const cred = await current();
  if (!cred) {
    throw new Error(
      "workbuddy: 未登录。设置 → WorkBuddy AI → Connect 弹出登录页，或登录桌面应用 / 设 WORKBUDDY_AUTH_FILE",
    );
  }
  if (cred.expiresAtMs > 0 && Date.now() + REFRESH_MARGIN_MS < cred.expiresAtMs) return cred;
  if (cred.refreshToken === "") {
    if (cred.expiresAtMs > Date.now() + 30_000) return cred;
    throw new Error("workbuddy: access token expired; sign in again in WorkBuddy AI");
  }
  inflight ??= (async () => {
    try {
      const next = await refreshAccess(cred);
      await saveOwn(next);
      return next;
    } catch (error) {
      if (cred.expiresAtMs > Date.now() + 30_000) return cred;
      throw error;
    }
  })().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

function chatHeaders(cred: Cred): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: GLOBAL_BASE,
    Referer: `${GLOBAL_BASE}/`,
    "User-Agent": CLIENT_UA,
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": cred.uid }),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" }),
    ...(cred.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": cred.domain }),
    "X-Product": "SaaS",
  };
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

/** `before_provider_request` carries no provider, so payloads are scoped by model id.
 *  Without this the hook rewrites every other provider's request (developer role,
 *  tool_choice, stream). */
export function isWorkBuddyModel(modelId: unknown, ids: ReadonlySet<string>): boolean {
  return typeof modelId === "string" && ids.has(modelId);
}

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

function hasMarker(headers: Record<string, string | null>): boolean {
  return headers[MARKER] === "1" || headers[MARKER.toLowerCase()] === "1";
}

type Pack = { name: string; remain: number; size: number };

function unwrap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseCredits(envelope: unknown): { total: number; packs: Pack[] } {
  const inner = unwrap(unwrap(unwrap(unwrap(envelope).data).Response).Data);
  const raw = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  const packs: Pack[] = [];
  let total = 0;
  for (const item of raw) {
    const account = unwrap(item);
    const num = (key: string): number => typeof account[key] === "number" ? account[key] as number : 0;
    const size = num("CycleCapacitySize");
    const cycleRemain = num("CycleCapacityRemain");
    const cycleUsed = num("CycleCapacityUsed");
    let remain = size > 0 || cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : num("CapacityRemain");
    if (remain < 0) remain = 0;
    total += remain;
    packs.push({
      name: typeof account.PackageName === "string" ? account.PackageName : "(unnamed)",
      remain,
      size: size > 0 ? size : num("CapacitySize"),
    });
  }
  return { total, packs };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtExpiry(ms: number): string {
  if (ms <= 0) return "未知";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function bar(remain: number, size: number, width = 28): string {
  if (size <= 0) return "";
  const n = Math.round(Math.min(1, Math.max(0, remain / size)) * width);
  return `${"█".repeat(n)}${"░".repeat(width - n)}`;
}

export function widgetLines(input: {
  cred?: Cred;
  credits?: { total: number; packs: Pack[] };
  error?: string;
  scope?: Scope;
  models?: { name: string }[];
}): string[] {
  const scope = input.scope ?? "free";
  const lines = [`WorkBuddy AI · 国际版 · ${scope === "all" ? "全部模型" : "仅免费模型"}`];
  if (!input.cred) {
    lines.push("未登录。设置 → 模型 → WorkBuddy AI → Connect，或 /login workbuddy");
    if (input.error) lines.push(input.error);
    lines.push("设置  /workbuddy");
    return lines;
  }
  lines.push(`账号  已登录  ${input.cred.nickname || input.cred.uid}`);
  lines.push(`令牌  ${fmtExpiry(input.cred.expiresAtMs)} 过期（自动续期）`);
  if (input.credits) {
    lines.push(`积分  合计 ${input.credits.total}`);
    for (const pack of input.credits.packs) {
      const right = pack.size > 0 ? `${pack.remain} / ${pack.size}` : String(pack.remain);
      lines.push(`  ${pack.name}  剩余 ${right}`);
      const drawn = bar(pack.remain, pack.size);
      if (drawn) lines.push(`  ${drawn}`);
    }
  } else if (input.error) {
    lines.push(`积分  ${input.error}`);
  }
  const names = (input.models ?? []).map((model) => model.name).join("  |  ") || "（无模型）";
  lines.push(`模型  ${names}`);
  lines.push("设置  /workbuddy");
  return lines;
}

async function fetchCredits(cred: Cred): Promise<{ total: number; packs: Pack[] }> {
  const now = new Date();
  const response = await fetch(`${GLOBAL_BASE}/v2/billing/meter/get-user-resource`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: GLOBAL_BASE,
      Referer: `${GLOBAL_BASE}/`,
      "User-Agent": CLIENT_UA,
      Authorization: `Bearer ${cred.accessToken}`,
      ...(cred.uid === "" ? {} : { "X-User-Id": cred.uid }),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmtStamp(now),
      PackageEndTimeRangeEnd: fmtStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope: unknown = await response.json();
  const msg = unwrap(envelope).msg;
  if (!response.ok || unwrap(envelope).code !== 0) {
    throw new Error(typeof msg === "string" && msg !== "" ? msg : `credits ${response.status}`);
  }
  return parseCredits(envelope);
}

type Ui = {
  setWidget(key: string, content: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

/** The card belongs to sessions actually running a WorkBuddy model. */
export function showsWorkBuddyCard(provider: unknown, force = false): boolean {
  return force || provider === PROVIDER;
}

type PaintCtx = { ui: Ui; model?: { provider?: string } };

/** Paints the card and returns the lines drawn, or undefined when hidden. */
async function paint(
  ctx: PaintCtx,
  notify = false,
  extra: { scope: Scope; models: { name: string }[] } = { scope: "free", models: [] },
  force = false,
): Promise<string[] | undefined> {
  const { ui } = ctx;
  if (!showsWorkBuddyCard(ctx.model?.provider, force)) {
    ui.setWidget("workbuddy", undefined);
    ui.setStatus("workbuddy", undefined);
    return undefined;
  }
  let cred: Cred | undefined;
  let credits: { total: number; packs: Pack[] } | undefined;
  let error: string | undefined;
  try {
    cred = await resolveCred();
    credits = await fetchCredits(cred);
  } catch (caught) {
    cred = await current();
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const lines = widgetLines({ cred, credits, error, ...extra });
  ui.setWidget("workbuddy", lines);
  ui.setStatus("workbuddy", credits ? `积分 ${credits.total}` : cred ? "WorkBuddy 已登录" : "WorkBuddy 未登录");
  if (notify) {
    ui.notify(
      error ? `WorkBuddy：${error}` : `WorkBuddy 已刷新 · 积分 ${credits?.total ?? "?"}`,
      error ? "warning" : "info",
    );
  }
  return lines;
}

const PLUGIN_AUTH_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: GLOBAL_BASE,
  Referer: `${GLOBAL_BASE}/`,
  "User-Agent": CLIENT_UA,
  "X-Requested-With": "XMLHttpRequest",
  "X-Product": "SaaS",
  "X-No-Authorization": "true",
  "X-No-User-Id": "1",
  "X-No-Enterprise-Id": "1",
  "X-No-Department-Info": "1",
};

export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function credFromPluginToken(
  data: Record<string, unknown>,
  accessToken: string,
  now = Date.now(),
): Cred {
  const jwt = jwtPayload(accessToken);
  const uid = optionalString(data.uid)
    ?? optionalString(jwt.uid)
    ?? optionalString(jwt.sub)
    ?? optionalString(jwt.email)
    ?? "";
  const enterpriseId = optionalString(data.enterpriseId) ?? optionalString(data.enterprise_id);
  const nickname = optionalString(data.nickname) ?? optionalString(jwt.email) ?? optionalString(jwt.name);
  return {
    accessToken,
    refreshToken: optionalString(data.refreshToken) ?? "",
    expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0 ? now + data.expiresIn * 1000 : 0,
    domain: optionalString(data.domain) ?? "www.workbuddy.ai",
    uid,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

async function startPluginLogin(): Promise<{ state: string; authUrl: string }> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const response = await fetch(`${GLOBAL_BASE}/v2/plugin/auth/state?platform=CLI&nonce=${nonce}`, {
    method: "POST",
    headers: PLUGIN_AUTH_HEADERS,
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = unwrap(await response.json());
  const data = unwrap(envelope.data);
  const state = typeof data.state === "string" ? data.state : "";
  const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
  if (!response.ok || envelope.code !== 0 || state === "" || authUrl === "") {
    throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "workbuddy login start failed");
  }
  return { state, authUrl };
}

async function pollPluginToken(state: string): Promise<Cred> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${GLOBAL_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: PLUGIN_AUTH_HEADERS,
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = unwrap(await response.json());
    if (envelope.code === 11217) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const data = unwrap(envelope.data);
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "") {
      throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : "workbuddy login failed");
    }
    return credFromPluginToken(data, accessToken);
  }
  throw new Error("workbuddy login timed out");
}

async function loginWorkBuddy(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.("正在打开 WorkBuddy 登录页…");
  const { state, authUrl } = await startPluginLogin();
  callbacks.onAuth({ url: authUrl });
  callbacks.onProgress?.("请在弹出的页面完成登录，完成后会自动继续");
  const cred = await pollPluginToken(state);
  await saveOwn(cred);
  return { access: cred.accessToken, refresh: cred.refreshToken, expires: cred.expiresAtMs };
}

async function refreshWorkBuddyOAuth(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const prev = await current();
  const next = await refreshAccess({
    accessToken: credentials.access,
    refreshToken: credentials.refresh,
    expiresAtMs: credentials.expires ?? 0,
    domain: prev?.domain ?? "www.workbuddy.ai",
    uid: prev?.uid ?? "",
    ...(prev?.enterpriseId ? { enterpriseId: prev.enterpriseId } : {}),
    ...(prev?.nickname ? { nickname: prev.nickname } : {}),
  });
  await saveOwn(next);
  return { access: next.accessToken, refresh: next.refreshToken, expires: next.expiresAtMs };
}

export default async function (pi: ExtensionAPI) {
  let scope = loadSettings().scope;
  let models = buildPiModels(loadProductConfig(), scope);
  let ids = new Set(models.map((model) => model.id));
  /** Last painted card lines for this session, reused on model switch. */
  let card: string[] | undefined;
  const extra = () => ({ scope, models });
  const oauth = {
    name: "WorkBuddy AI",
    login: loginWorkBuddy,
    refreshToken: refreshWorkBuddyOAuth,
    getApiKey: (credentials: OAuthCredentials) => credentials.access,
  };

  function apply(next?: Scope) {
    if (next) scope = next;
    models = buildPiModels(loadProductConfig(), scope);
    ids = new Set(models.map((model) => model.id));
    pi.registerProvider(PROVIDER, {
      name: "WorkBuddy AI",
      baseUrl: `${GLOBAL_BASE}/v2`,
      api: "openai-completions",
      headers: { [MARKER]: "1" },
      oauth,
      models,
      async refreshModels() {
        scope = loadSettings().scope;
        models = buildPiModels(loadProductConfig(), scope);
        ids = new Set(models.map((model) => model.id));
        return models;
      },
    });
  }

  apply();

  pi.on("before_provider_headers", async (event) => {
    if (!hasMarker(event.headers)) return;
    const cred = await resolveCred();
    event.headers[MARKER] = null;
    event.headers[MARKER.toLowerCase()] = null;
    for (const [key, value] of Object.entries(chatHeaders(cred))) event.headers[key] = value;
  });

  pi.on("before_provider_request", (event) => {
    const payload = asObject(event.payload);
    if (!payload || !isWorkBuddyModel(payload.model, ids)) return;
    return prepareChatPayload(payload);
  });

  pi.on("session_start", (_event, ctx) => {
    // Never block session startup on the optional account/credits card.
    void paint(ctx, false, extra())
      .then((lines) => { card = lines; })
      .catch(() => undefined);
  });

  // setModel awaits this handler, so it must never block on network I/O:
  // redraw from the cached card and refresh in the background.
  pi.on("model_select", (_event, ctx) => {
    if (!showsWorkBuddyCard(ctx.model?.provider)) {
      card = undefined;
      ctx.ui.setWidget("workbuddy", undefined);
      ctx.ui.setStatus("workbuddy", undefined);
      return;
    }
    if (card) ctx.ui.setWidget("workbuddy", card);
    void paint(ctx, false, extra()).then((lines) => { card = lines; }).catch(() => undefined);
  });

  pi.registerCommand("workbuddy", {
    description: "WorkBuddy 设置：刷新积分、免费/全部模型、断开登录",
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().toLowerCase();
      if (cmd === "free" || cmd === "all") {
        await saveSettings(cmd);
        apply(cmd);
        await paint(ctx, true, extra(), true);
        return;
      }
      if (cmd === "logout" || cmd === "disconnect") {
        await unlink(ownPath()).catch(() => undefined);
        await paint(ctx, true, extra(), true);
        return;
      }
      const pick = await ctx.ui.select("WorkBuddy 设置", [
        "刷新积分与账号",
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
        await unlink(ownPath()).catch(() => undefined);
      }
      await paint(ctx, true, extra(), true);
    },
  });
}

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
  if (!showsWorkBuddyCard("workbuddy")) throw new Error("card: own provider shown");
  if (showsWorkBuddyCard("GROKCPA")) throw new Error("card: foreign provider hidden");
  if (showsWorkBuddyCard(undefined) || showsWorkBuddyCard(null) || showsWorkBuddyCard(42)) throw new Error("card: unknown provider hidden");
  if (!showsWorkBuddyCard("GROKCPA", true)) throw new Error("card: explicit command overrides");
  const ours = new Set(["hy3", "deepseek-v4.1-flash"]);
  if (!isWorkBuddyModel("hy3", ours)) throw new Error("scope: own model accepted");
  if (isWorkBuddyModel("grok-4.6", ours)) throw new Error("scope: foreign model must be rejected");
  if (isWorkBuddyModel(undefined, ours) || isWorkBuddyModel(42, ours)) throw new Error("scope: non-string rejected");
  if (thinkingLevelMap(["high"], true).off !== "off") throw new Error("off");
  const prepended = prepareChatPayload({ messages: [{ role: "user", content: "hi" }] });
  if ((prepended.messages as { role: string }[])[0].role !== "system") throw new Error("prepend");
  if (FREE_IDS.length !== 3) throw new Error("count");
  if (!creditsAreFree("x0.00") || creditsAreFree("x1.00")) throw new Error("credits free");
  const flash = buildPiModels({ source: "builtin", models: BUILTIN_MODELS }, "free")
    .find((model) => model.id === "deepseek-v4.1-flash");
  if (flash?.thinkingLevelMap.low !== "low" || flash.thinkingLevelMap.xhigh !== "xhigh" || flash.thinkingLevelMap.max !== "max") {
    throw new Error("flash efforts");
  }
  if (flash.maxTokens !== FLASH_MAX_TOKENS) throw new Error("flash cap");
  const looped = prepareChatPayload({
    model: "deepseek-v4.1-flash",
    max_tokens: 128_000,
    messages: [{ role: "assistant", content: "done", reasoning: "OK.\nLet me write.", thinking: "Go." }],
  });
  const assistant = (looped.messages as Record<string, unknown>[])[1];
  if (assistant.reasoning !== undefined || assistant.thinking !== undefined) throw new Error("reasoning replay");
  if (looped.max_tokens !== FLASH_MAX_TOKENS) throw new Error("flash payload cap");
  const fromCache = parseProductConfig(JSON.stringify({
    models: [{
      id: "deepseek-v4.1-flash",
      name: "Deepseek-V4.1-Flash",
      credits: "x0.00",
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    }],
  }));
  if (!fromCache) throw new Error("parse config");
  const cachedFlash = buildPiModels(fromCache, "free")[0];
  if (cachedFlash.thinkingLevelMap.medium !== "medium" || cachedFlash.thinkingLevelMap.max !== "max") {
    throw new Error("cache efforts");
  }
  const implied = parseProductConfig(JSON.stringify({
    models: [{
      id: "implied",
      name: "Implied",
      credits: "x0.00",
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      supportsReasoning: true,
    }],
  }));
  if (buildPiModels(implied!, "free")[0].thinkingLevelMap.xhigh !== "xhigh") throw new Error("implied efforts");
  const credits = parseCredits({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            { PackageName: "Bonus Pack", CycleCapacitySize: 250, CycleCapacityRemain: 249 },
            { PackageName: "Free Plan Subscription", CycleCapacitySize: 100, CycleCapacityRemain: 100 },
          ],
        },
      },
    },
  });
  if (credits.total !== 349 || credits.packs.length !== 2) throw new Error("credits");
  const lines = widgetLines({
    cred: {
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: Date.UTC(2027, 8, 12, 1, 30, 0),
      domain: "www.workbuddy.ai",
      uid: "u",
      nickname: "user@example.com",
    },
    credits,
  });
  if (!lines.some((line) => line.includes("user@example.com"))) throw new Error("account");
  if (!lines.some((line) => line.includes("合计 349"))) throw new Error("total");
  const token = `x.${Buffer.from(JSON.stringify({ email: "a@b.c", sub: "u9" })).toString("base64url")}.y`;
  const fromTok = credFromPluginToken(
    { refreshToken: "r", expiresIn: 10, domain: "www.workbuddy.ai", enterpriseId: "e1" },
    token,
    1000,
  );
  if (fromTok.uid !== "u9" || fromTok.nickname !== "a@b.c" || fromTok.expiresAtMs !== 11_000) throw new Error("plugin token");
  if (fromTok.enterpriseId !== "e1") throw new Error("enterprise");
  console.log("ok");
}
