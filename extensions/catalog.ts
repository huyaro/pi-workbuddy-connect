// WorkBuddy 模型目录：`/v3/config` 产品文档的解析，以及两版的差异。
//
// 两版都读 `/v3/config`，真正的区别是 User-Agent：网关按客户端身份分流，这个
// 分流是关键的。CLI 形态的 UA 换来 CLI 的名单（本插件实际能用的那些模型），
// App 形态的 UA 换来 App 内部名单。国内版保持它 chat 时用的 CLI UA，所以它
// 公布的目录正是它自己的请求能用的目录；国际版没有 CLI 身份，保持 App UA。
//
// 对齐参考实现 corrinehu/dsh-workbuddy-connect 的 `src/upstream.ts` +
// `src/catalog.ts` 的解析部分。

/** 一个上游模型条目。 */
export interface UpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  /** 上游明确声明的推理档；没有时调用方按 supportsReasoning 推断。 */
  supportedEfforts?: string[];
  canDisableThinking: boolean;
  /** 归一化后的倍率字符串，如 `x0.00`；未声明则 undefined。 */
  credits?: string;
  /** 倍率为 0 即为免费。 */
  free: boolean;
}

/** 推理档的规范集合。 */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 把上游的 `credits` 字段归一化成裸倍率。
 *
 * 国内版写成 `x2.00 credits`（带单位后缀），国际版写成裸的 `x0.00`。只看裸
 * 倍率的匹配永远看不到前者，所以免费判定必须先去掉单位词。
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined;
  const trimmed = credits.trim();
  if (trimmed === "") return undefined;
  // 只写了单位词的字符串不带倍率。
  if (/^credits?$/iu.test(trimmed)) return undefined;
  const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
  return bare === "" ? undefined : bare;
}

/** 归一化倍率是否为 0（即免费）。 */
export function creditsAreFree(credits: string | undefined): boolean {
  const normalized = normalizeCredits(credits);
  if (normalized === undefined) return false;
  return /^x?0(?:\.0+)?$/u.test(normalized);
}

function parseEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
    ? value as Effort
    : undefined;
}

/**
 * 解析一行模型。
 *
 * `disabled` 行与没有窗口的行直接丢弃：前者是上游下架标记，后者选了必然报错。
 */
function parseRow(row: Record<string, unknown>): UpstreamModel | undefined {
  const id = optionalString(row["id"]);
  if (id === undefined || row["disabled"] === true) return undefined;
  const input = positive(row["maxInputTokens"]) ? row["maxInputTokens"] : 0;
  const output = positive(row["maxOutputTokens"]) ? row["maxOutputTokens"] : 0;
  if (input <= 0 || output <= 0) return undefined;
  const credits = normalizeCredits(optionalString(row["credits"]));
  const reasoning = isObject(row["reasoning"]) ? row["reasoning"] : undefined;
  const rawEfforts = reasoning?.["supportedEfforts"];
  let supportedEfforts: Effort[] | undefined;
  if (Array.isArray(rawEfforts)) {
    const efforts = rawEfforts.map(parseEffort).filter((e): e is Effort => e !== undefined);
    if (efforts.length > 0) supportedEfforts = efforts;
  }
  return {
    id,
    name: optionalString(row["name"]) ?? id,
    contextWindow: input,
    maxTokens: output,
    supportsImages: row["supportsImages"] === true && row["disabledMultimodal"] !== true,
    // `supportsReasoning` 只在上游明确声明时才算；推理档存在同样意味着支持。
    supportsReasoning: row["supportsReasoning"] === true
      || (reasoning !== undefined && (reasoning["supports"] === true || supportedEfforts !== undefined)),
    ...supportedEfforts === undefined ? {} : { supportedEfforts },
    canDisableThinking: reasoning?.["canDisableThinking"] === true,
    ...credits === undefined ? {} : { credits },
    free: creditsAreFree(credits),
  };
}

/**
 * `cli` agent 的名单，即本插件实际能用的模型。
 *
 * 找不到这份名单是硬错误，不是"没有模型"：网关换了形状时，静默返回空列表会
 * 让整组模型无声消失，而明确报错能在卡片上显示原因。
 */
function cliRoster(data: Record<string, unknown>): string[] | undefined {
  const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
  for (const agent of agents) {
    if (!isObject(agent)) continue;
    if (agent["name"] === "cli" && Array.isArray(agent["models"])) {
      const ids = agent["models"].filter((id): id is string => typeof id === "string");
      if (ids.length > 0) return ids;
    }
  }
  return undefined;
}

/**
 * 解析 `/v3/config` 的产品文档。
 *
 * 成员是 `cli` 名单与可用行的交集，顺序按名单。名单缺失或交集为空都抛错。
 */
export function parseModelCatalog(data: Record<string, unknown>): UpstreamModel[] {
  const roster = cliRoster(data);
  if (roster === undefined) throw new Error("workbuddy 模型目录没有列出 cli agent 的模型");
  const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
  const byId = new Map<string, UpstreamModel>();
  for (const raw of rawModels) {
    if (!isObject(raw)) continue;
    const parsed = parseRow(raw);
    if (parsed) byId.set(parsed.id, parsed);
  }
  const models = roster
    .map((id) => byId.get(id))
    .filter((model): model is UpstreamModel => model !== undefined);
  if (models.length === 0) throw new Error("workbuddy 模型目录解析结果为空");
  return models;
}

/** 目录来源，用于卡片上标明列表是实时的还是兜底的。 */
export type CatalogSource = "live" | "product-config" | "builtin";

export interface CatalogResult {
  models: UpstreamModel[];
  source: CatalogSource;
}

/**
 * 从 `/v3/config` 的响应信封里取出产品文档。
 *
 * 两种形状共用这条路径：接口把答案包在 `{code,msg,data}` 里，但也见过 `/v3/config`
 * 直接把产品文档裸放在顶层。把缺失的 `data` 当成空文档，会把第二种形状变成
 * 虚假的"没有 cli 名单"，所以本身看起来就像目录（带 models 或 agents）的
 * body 直接当作答案。
 */
export function unwrapCatalogDocument(envelope: Record<string, unknown>): Record<string, unknown> {
  if (isObject(envelope["data"])) return envelope["data"];
  if ("models" in envelope || "agents" in envelope) return envelope;
  return {};
}
