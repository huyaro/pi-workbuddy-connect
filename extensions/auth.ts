// WorkBuddy 凭据解析。主来源是桌面 App 自己的认证文件（只读）；插件自留副本
// 存 token 续期结果，所以桌面文件永不被写。生效凭据取两者中过期更晚的那个，
// 这样任一侧的续期都能生效。
//
// 智能上，凭据归属由变体决定：两版 App 把登录写进同一个共享认证目录，靠文件
// basename 区分，而凭据本身声明的 domain 决定它属于哪个区域。
//
// 对齐参考实现 corrinehu/dsh-workbuddy-connect 的 `src/auth.ts`。

import { readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  classifyDesktopAuthDocument,
  openAuthField,
  unwrapDesktopAuthDocument,
  WorkBuddyAtRestKeyProvider,
} from "./desktop-credential-protection.ts";
import { credentialMatchesVariant, regionOf, type WorkBuddyVariant } from "./variants.ts";

/** 归一化后的 WorkBuddy 凭据，时间戳为 epoch 毫秒。 */
export interface Cred {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** 凭据来自哪份存储；续期结果总是写回插件自留副本。 */
  source: "desktop" | "plugin";
}

/** 自留副本的磁盘格式；读取器拒绝其他版本。 */
const OWN_FORMAT_VERSION = 1;

/** 归一化一个可能是秒或毫秒的过期时间。 */
export function expiryToMs(value: number): number {
  if (value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 解析一份 WorkBuddy 认证文档，两种磁盘形态都接受：插件 OAuth 的嵌套形态
 * `{auth:{...},account:{...}}` 与扁平形态。没有 access token 就返回 undefined。
 */
export function parseWorkBuddyAuth(text: string, source: Cred["source"] = "desktop"): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  let auth: Record<string, unknown>;
  let identity: Record<string, unknown>;
  if (typeof document["auth"] === "object" && document["auth"] !== null) {
    auth = document["auth"] as Record<string, unknown>;
    identity = typeof document["account"] === "object" && document["account"] !== null
      ? document["account"] as Record<string, unknown>
      : {};
  } else {
    auth = document;
    identity = document;
  }
  const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
  if (accessToken === "") return undefined;
  const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
  const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number"
    ? expiryToMs(auth["refreshExpiresAt"])
    : undefined;
  const enterpriseId = optionalString(identity["enterpriseId"]);
  const nickname = optionalString(identity["nickname"]);
  return {
    accessToken,
    refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth["domain"]) ?? "",
    uid: optionalString(identity["uid"]) ?? "",
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source,
  };
}

/**
 * 解析插件自留副本。
 *
 * 自留副本存的是归一化后的凭据本身（驼峰 `expiresAtMs`、身份字段在顶层），
 * 不是桌面文档形态。若用 `parseWorkBuddyAuth` 去读，它会找 `expiresAt` 与
 * `account` 对象、两者都找不到、于是把过期时间归零并丢掉 uid/enterprise/
 * nickname——结果是这份副本每次请求都被当作过期而续期，且身份头丢失。
 */
export function parseOwn(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed as Record<string, unknown>;
  if (document["version"] !== OWN_FORMAT_VERSION) return undefined;
  if (typeof document["credential"] !== "object" || document["credential"] === null) return undefined;
  const stored = document["credential"] as Record<string, unknown>;
  const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
  if (accessToken === "") return undefined;
  const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : undefined;
  const enterpriseId = optionalString(stored["enterpriseId"]);
  const nickname = optionalString(stored["nickname"]);
  return {
    accessToken,
    refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
    expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored["domain"]) ?? "",
    uid: optionalString(stored["uid"]) ?? "",
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: "plugin",
  };
}

export function ownDocument(cred: Cred): Record<string, unknown> {
  return { version: OWN_FORMAT_VERSION, credential: cred };
}

/** 读一个文本文件；不存在返回 undefined。 */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 一个变体的桌面认证文件候选路径，按探测顺序。
 *
 * 两版 App 写进**同一个**共享 `CodeBuddyExtension` 认证目录，只靠文件 basename
 * 区分，所以平台顺序复用同一套，仅替换文件名。Windows 同时探测 Local 与
 * Roaming：当前版本写 Local，旧版本写 Roaming。
 */
export function desktopCandidatesFor(variant: WorkBuddyVariant): string[] {
  const override = process.env[variant.env]?.trim();
  if (override) return [override];
  const home = homedir();
  const rel = ["CodeBuddyExtension", "Data", "Public", "auth", variant.desktopFilename] as const;
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", ...rel)];
  }
  if (process.platform === "win32") {
    return [
      join(home, "AppData", "Local", ...rel),
      join(home, "AppData", "Roaming", ...rel),
    ];
  }
  return [join(home, ".config", ...rel), join(home, ".local", "share", ...rel)];
}

/** 插件自留副本路径。 */
export function ownPathFor(variant: WorkBuddyVariant, agentDir: string): string {
  return join(agentDir, variant.ownFilename);
}

/**
 * 历史遗留的自留副本文件名。
 *
 * 本插件此前的唯一 provider 是国际版，却把凭据存在 `.workbuddy-auth.json`；
 * 现在国内版占了 `workbuddy`，`.workbuddy-auth.json` 按变体约定属于国内版。
 * 若不迁移，改名后国际版用户会发现自己"未登录"。所以国际版读取时也回退到
 * 这个旧文件名，且优先用新文件。
 */
const LEGACY_AI_OWN_FILENAME = ".workbuddy-auth.json";

export interface CredentialStoreOptions {
  variant: WorkBuddyVariant;
  /** pi agent 目录，决定自留副本位置。 */
  agentDir: string;
  /** 执行上游 token 续期。 */
  refresh: (cred: Cred) => Promise<Cred>;
  /** 提前多久续期；默认五分钟。 */
  refreshMarginMs?: number;
  /** 解密 helper 的注入点，测试不必外启真实二进制。 */
  spawnKeyPayload?: (path: string) => Promise<string>;
}

/**
 * 只读凭据存储，按需续期。
 *
 * 续期策略：仅当 access token 进入余量窗口（或已过期）时续期，续期结果写入
 * 插件自留副本，绝不写桌面 App 的文件。续期失败仍返回尚未过期的 token，这样
 * 续期端点不可达不会打挂一个本来能用的会话。
 */
export class WorkBuddyCredentialStore {
  private readonly variant: WorkBuddyVariant;
  private readonly agentDir: string;
  private readonly refresh: CredentialStoreOptions["refresh"];
  private readonly refreshMarginMs: number;
  private readonly keyProvider: WorkBuddyAtRestKeyProvider;
  private inflight: Promise<Cred> | undefined;

  constructor(options: CredentialStoreOptions) {
    this.variant = options.variant;
    this.agentDir = options.agentDir;
    this.refresh = options.refresh;
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000;
    const electronPath = process.env[options.variant.electronEnv]?.trim()
      || options.variant.electronPath;
    this.keyProvider = new WorkBuddyAtRestKeyProvider({
      electronPath,
      helperEnvName: options.variant.electronEnv,
      ...options.spawnKeyPayload === undefined ? {} : { spawn: options.spawnKeyPayload },
    });
  }

  /** 本变体的自留副本路径；国际版优先新名，避免与国内版冲突。 */
  private ownPaths(): string[] {
    const current = ownPathFor(this.variant, this.agentDir);
    if (this.variant.region !== "global") return [current];
    const legacy = join(this.agentDir, LEGACY_AI_OWN_FILENAME);
    return legacy === current ? [current] : [current, legacy];
  }

  /** 读桌面 App 的认证文件，必要时解密；读不到返回 undefined。 */
  private async desktopCred(): Promise<Cred | undefined> {
    for (const path of desktopCandidatesFor(this.variant)) {
      const text = await readText(path);
      if (text === undefined) continue;
      const classified = classifyDesktopAuthDocument(text);
      let plaintext = text;
      if (classified.format === "encrypted") {
        const keyIds = [...new Set(classified.wrapped.fields.map((field) => field.envelope.keyId))];
        let key: Buffer;
        try {
          key = await this.keyProvider.protectorKeyFor(keyIds);
        } catch {
          // 解密不可用（App 未装、helper 启动失败）：这个候选读不出来，
          // 但别的候选或许可以，所以继续探测而不是直接失败。
          continue;
        }
        try {
          plaintext = unwrapDesktopAuthDocument(classified, (field) => openAuthField(key, field.envelope));
        } catch {
          continue;
        }
      }
      const cred = parseWorkBuddyAuth(plaintext, "desktop");
      if (!cred) continue;
      if (!credentialMatchesVariant(cred.domain, this.variant)) continue;
      return cred;
    }
    return undefined;
  }

  /** 读插件自留副本，取第一份能解析的。 */
  private async ownCred(): Promise<Cred | undefined> {
    for (const path of this.ownPaths()) {
      const text = await readText(path);
      if (text === undefined) continue;
      const cred = parseOwn(text);
      if (cred) return cred;
    }
    return undefined;
  }

  /** 当前生效凭据：自留副本与桌面文件里过期更晚的一个。 */
  async current(): Promise<Cred | undefined> {
    const own = await this.ownCred();
    const desktop = await this.desktopCred();
    if (!desktop) return own;
    if (!own) return desktop;
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
  }

  /** 把凭据写进自留副本（仅插件自有的那份）。 */
  async save(cred: Cred): Promise<void> {
    const path = ownPathFor(this.variant, this.agentDir);
    await writeFile(path, JSON.stringify(ownDocument(cred)), { mode: 0o600 });
  }

  /** 删除自留副本；不动桌面 App 自己的登录。 */
  async clear(): Promise<void> {
    for (const path of this.ownPaths()) {
      await unlink(path).catch(() => undefined);
    }
  }

  /**
   * 解析出一个可用凭据，必要时续期。无凭据时抛错，错误文案带变体名与登录入口。
   */
  async resolve(): Promise<Cred> {
    const cred = await this.current();
    if (!cred) {
      throw new Error(
        `workbuddy: ${this.variant.displayName} 未登录。`
        + `${this.variant.displayName} 桌面 App 登录后自动可用，`
        + `或设 ${this.variant.env} 指向其认证文件`,
      );
    }
    if (cred.expiresAtMs > 0 && Date.now() + this.refreshMarginMs < cred.expiresAtMs) return cred;
    if (cred.refreshToken === "") {
      if (cred.expiresAtMs > Date.now() + 30_000) return cred;
      throw new Error(`workbuddy: ${this.variant.displayName} access token 已过期；请在桌面 App 重新登录`);
    }
    this.inflight ??= (async () => {
      try {
        const next = await this.refresh(cred);
        await this.save(next);
        return next;
      } catch (error) {
        if (cred.expiresAtMs > Date.now() + 30_000) return cred;
        throw error;
      }
    })().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
}

/** 该域名的区域，转发自 variants，便于调用方只 import 本模块。 */
export { regionOf };
