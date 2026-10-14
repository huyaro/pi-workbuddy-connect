// WorkBuddy 上游客户端：token 续期、积分读取、chat 请求头与 body 规整。
//
// 两版的差异全部由变体描述符与凭据里的 domain 决定，所以这里不需要
// `if (international)` 分支：chat base、billing base、UA 各自从变体取。
//
// 对齐参考实现 corrinehu/dsh-workbuddy-connect 的 `src/upstream.ts`。

import { parseModelCatalog, unwrapCatalogDocument, type UpstreamModel } from "./catalog.ts";
import type { Cred } from "./auth.ts";
import type { WorkBuddyVariant } from "./variants.ts";

/** 上游请求的默认超时。 */
const JSON_TIMEOUT_MS = 30_000;
/** 国内版 chat 与目录共用 CLI 形态 UA；网关按它分流模型名单。 */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

export interface ClientOptions {
  variant: WorkBuddyVariant;
  /** 覆盖 fetch，测试用。 */
  fetch?: typeof fetch;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrap(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/** 上游信封：`{code,msg,data}`。 */
export interface Envelope {
  code: number;
  msg: string;
  data: Record<string, unknown>;
  document: Record<string, unknown>;
}

function readEnvelope(value: unknown): Envelope {
  const record = unwrap(value);
  return {
    code: typeof record["code"] === "number" ? record["code"] : 0,
    msg: typeof record["msg"] === "string" ? record["msg"] : "",
    data: unwrap(record["data"]),
    document: record,
  };
}

/** 由信封构造一个可展示的上游错误。 */
function envelopeError(status: number, envelope: Envelope): Error {
  const message = envelope.msg !== "" ? envelope.msg : `HTTP ${status}`;
  return new Error(`workbuddy: ${message}`);
}

/** 两版 chat 请求共享的头部。 */
export function chatHeaders(cred: Cred, variant: WorkBuddyVariant): Record<string, string> {
  return {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": variant.billingBase,
    "Referer": `${variant.billingBase}/`,
    "User-Agent": CLIENT_UA,
    "Authorization": `Bearer ${cred.accessToken}`,
    ...cred.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": cred.uid },
    ...cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" },
    ...cred.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": cred.domain },
    "X-Product": "SaaS",
  };
}

/** 计费接口的头部。 */
function billingHeaders(cred: Cred, variant: WorkBuddyVariant): Record<string, string> {
  return {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": variant.billingBase,
    "Referer": `${variant.billingBase}/`,
    "User-Agent": CLIENT_UA,
    "Authorization": `Bearer ${cred.accessToken}`,
    ...cred.uid === "" ? {} : { "X-User-Id": cred.uid },
  };
}

/** 一个积分包。 */
export interface CreditAccount {
  packageName: string;
  remain: number;
  size: number;
  /** 企业接口的 -1「无上限」标记。 */
  unlimited?: boolean;
  /** 周期重置时间，原样透传。 */
  cycleResetTime?: string;
}

export interface Credits {
  total: number;
  accounts: CreditAccount[];
  /** 整个账号无上限（企业接口的 -1）。 */
  unlimited?: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 上游计费接口要求的 `YYYY-MM-DD HH:mm:ss` 本地时间。 */
function fmtStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export class WorkBuddyUpstream {
  private readonly variant: WorkBuddyVariant;
  private readonly doFetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.variant = options.variant;
    this.doFetch = options.fetch ?? fetch;
  }

  /**
   * POST 续期接口，返回新的凭据。
   *
   * 续期接口在两版上是同一个路径，但 base 从变体取：国内版走
   * `www.codebuddy.cn`，国际版走 `www.workbuddy.ai`。
   */
  async refreshAccess(cred: Cred): Promise<Cred> {
    const response = await this.doFetch(`${this.variant.billingBase}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": this.variant.billingBase,
        "Referer": `${this.variant.billingBase}/`,
        "User-Agent": CLIENT_UA,
        "X-Refresh-Token": cred.refreshToken,
        "X-Auth-Refresh-Source": "workbuddy",
        ...cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {},
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const envelope = readEnvelope(await response.json());
    const data = envelope.data;
    const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "") {
      throw new Error(envelope.msg || `workbuddy: token 续期失败；请在 ${this.variant.displayName} 重新登录`);
    }
    const expiresIn = typeof data["expiresIn"] === "number" ? data["expiresIn"] : 0;
    const domain = typeof data["domain"] === "string" && data["domain"] !== "" ? data["domain"] : cred.domain;
    const refreshToken = typeof data["refreshToken"] === "string" && data["refreshToken"] !== ""
      ? data["refreshToken"]
      : cred.refreshToken;
    return {
      ...cred,
      accessToken,
      refreshToken,
      expiresAtMs: expiresIn > 0 ? Date.now() + expiresIn * 1000 : cred.expiresAtMs,
      domain,
      source: "plugin",
    };
  }

  /**
   * GET `/v3/config` 产品目录。
   *
   * 两版路径相同，区别在 UA：国内版保持 CLI UA，网关据此下发 CLI 名单。
   */
  async fetchModels(cred: Cred, signal?: AbortSignal): Promise<UpstreamModel[]> {
    const response = await this.doFetch(`${this.variant.chatBase}/v3/config`, {
      headers: {
        "Authorization": `Bearer ${cred.accessToken}`,
        "Accept": "application/json",
        "Origin": this.variant.billingBase,
        "Referer": `${this.variant.billingBase}/`,
        "User-Agent": CLIENT_UA,
        ...this.variant.region === "global" ? { "X-Requested-With": "XMLHttpRequest", "X-Product": "SaaS" } : {},
      },
      signal: signal === undefined
        ? AbortSignal.timeout(JSON_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    });
    const envelope = readEnvelope(await response.json());
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    return parseModelCatalog(unwrapCatalogDocument(envelope.document));
  }

  /**
   * POST 计费接口读取剩余积分。
   *
   * 两种上游形状，按账号类型选：
   * - **国内版企业账号**（`enterpriseId` 非空）问
   *   `/v2/billing/meter/get-enterprise-user-usage`，答案是单一周期额度。个人
   *   接口会给这类账号返回空的 `Accounts`，卡片会因此显示「0 积分」——一个
   *   看起来合理的错数字，而不是可见的失败。
   * - **其余所有人**保持个人接口不变。
   *
   * 区域闸门是关键：企业接口在国际版上未经验证，所以一个恰好带
   * `enterpriseId` 的国际版凭据必须留在已实测的个人路径上。
   */
  async fetchCredits(cred: Cred): Promise<Credits> {
    if (this.variant.region === "cn" && cred.enterpriseId !== undefined && cred.enterpriseId !== "") {
      return await this.fetchEnterpriseCredits(cred);
    }
    const now = new Date();
    const response = await this.doFetch(`${this.variant.billingBase}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers: billingHeaders(cred, this.variant),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmtStamp(now),
        PackageEndTimeRangeEnd: fmtStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const envelope = readEnvelope(await response.json());
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const wrapper = envelope.data;
    const data = unwrap(wrapper["Response"]);
    const inner = unwrap(data["Data"]);
    const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
    const accounts: CreditAccount[] = [];
    let total = 0;
    for (const raw of rawAccounts) {
      if (!isObject(raw)) continue;
      const numberField = (key: string): number => typeof raw[key] === "number" ? raw[key] as number : 0;
      const size = numberField("CycleCapacitySize");
      const cycleRemain = numberField("CycleCapacityRemain");
      const cycleUsed = numberField("CycleCapacityUsed");
      let remain = size > 0 || cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : numberField("CapacityRemain");
      if (remain < 0) remain = 0;
      total += remain;
      accounts.push({
        packageName: typeof raw["PackageName"] === "string" ? raw["PackageName"] : "(unnamed)",
        remain,
        size: size > 0 ? size : numberField("CapacitySize"),
      });
    }
    return { total, accounts };
  }

  /**
   * 国内版企业账号的积分读取：单一周期额度，而非个人接口的具名套餐列表。
   *
   * 请求体是空对象，账号身份只走头部。官方两处调用点对字段拼写不一致
   * （`limitNum`/`credit` 与 `limit_num`/`used_num`），所以两种都接受。
   *
   * 响应里没有可识别的额度字段是硬错误而不是零：「没看懂答案」渲染成 `0`
   * 正是这类错误保持不可见的成因。
   */
  private async fetchEnterpriseCredits(cred: Cred): Promise<Credits> {
    const response = await this.doFetch(`${this.variant.billingBase}/v2/billing/meter/get-enterprise-user-usage`, {
      method: "POST",
      headers: billingHeaders(cred, this.variant),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const envelope = readEnvelope(await response.json());
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    // 官方读取器接受载荷在 `data.data`、`data` 或信封本身；观测到的答案把
    // 字段放在 `data`。
    const sources: Record<string, unknown>[] = [];
    for (const candidate of [envelope.data, envelope.document]) {
      if (!isObject(candidate)) continue;
      if (isObject(candidate["data"])) sources.push(candidate["data"]);
      sources.push(candidate);
    }
    const numberAt = (source: Record<string, unknown>, key: string): number | undefined =>
      typeof source[key] === "number" ? source[key] as number : undefined;
    let limit: number | undefined;
    let used: number | undefined;
    let cycleResetTime: string | undefined;
    for (const source of sources) {
      const candidate = numberAt(source, "limitNum") ?? numberAt(source, "limit_num");
      if (candidate === undefined) continue;
      limit = candidate;
      used = numberAt(source, "credit") ?? numberAt(source, "used_num");
      const reset = source["cycleResetTime"];
      if (typeof reset === "string" && reset !== "") cycleResetTime = reset;
      break;
    }
    if (limit === undefined) {
      throw new Error(
        "workbuddy: 企业额度接口没有返回可识别的额度字段"
        + "（期望 limitNum/limit_num 搭配 credit/used_num）",
      );
    }
    // `-1` 是上游的「无上限」标记，不是余额。作为显式标志传递，任何渲染方都
    // 不会把它误当数字。
    if (limit === -1) {
      return {
        total: 0,
        accounts: [{ packageName: "enterprise", remain: 0, size: 0, unlimited: true }],
        unlimited: true,
        ...cycleResetTime === undefined ? {} : { accounts: [{ packageName: "enterprise", remain: 0, size: 0, unlimited: true, cycleResetTime }] },
      };
    }
    // 有额度上限却没有可用用量必须报错，不能假定用了零。默认 0 会给出一个
    // 自信的「额度全满」，来自一份读不懂的响应。
    if (used === undefined) {
      throw new Error(
        "workbuddy: 企业额度接口返回了额度上限，却没有可识别的用量字段"
        + "（期望与 limitNum/limit_num 并列的 credit/used_num）",
      );
    }
    let remain = limit - used;
    if (remain < 0) remain = 0;
    return {
      total: remain,
      accounts: [{ packageName: "enterprise", remain, size: limit, ...cycleResetTime === undefined ? {} : { cycleResetTime } }],
    };
  }
}
