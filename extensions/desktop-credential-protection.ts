// WorkBuddy 5.6.x 桌面凭据的静态加密（at-rest）保护：分类、取密钥、解密。
//
// 自 WorkBuddy 5.6 起，两版桌面 App（国际版 5.6.2 跟进）都会把
// `auth.accessToken` / `auth.refreshToken` 加密落盘（`buildPolicy: "fields"`，
// 默认开启），所以插件读到的是 `{$wbEncrypted:1, envelope}` 包装，而不是
// token 明文字符串。
//
// 打开它需要的一切都在同一台机器上：
// - 封装的密钥载荷（`{version:1, atRestSecretKey}`）来自 WorkBuddy 改造过的
//   Electron 私有绑定 `workbuddyStorage`，靠以 `ELECTRON_RUN_AS_NODE=1` 运行
//   **它自己的**二进制取回；
// - `protectorKey = sha256(atRestSecretKey, utf8)`，配合 AES-256-GCM 打开信封；
//   AAD 构造如下，转写自 App 自身的 `buildAuthenticatedContextAad`。
//
// 插件进程自身永远无法调用 `_linkedBinding`（它跑在 pi 的 Node 里，不在被 fork
// 的 Electron 里），所以 helper 是外启的。密钥仅在内存缓存、单飞、当出现不同
// keyId 时重新解析。载荷、密钥、token 一律不落日志；错误信息只带长度、id 与
// 退出码。
//
// 对齐参考实现 corrinehu/dsh-workbuddy-connect 的
// `src/desktop-credential-protection.ts`。

import { execFile } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";

/** 一份桌面认证文档可被读出的四种形态。 */
export type DesktopAuthFormat = "absent" | "plaintext" | "encrypted" | "unrecognized";

/** 一个信封解出的各部分。 */
export interface WorkBuddyEnvelope {
  suite: number;
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** 认证文档里仍是加密包装的字段。 */
export interface WrappedAuthField {
  field: "accessToken" | "refreshToken" | "nickname";
  envelope: WorkBuddyEnvelope;
}

/**
 * 一份读到的桌面认证文档，按 `format` 判别。`encrypted` 变体带原文档与仍是
 * 包装的字段；调用方解密这些字段、把重建后的文本交给常规解析器，这样身份与
 * 过期字段不需要第二条代码路径。
 */
export type DesktopAuthClassification =
  | { format: "absent" }
  | { format: "plaintext" }
  | { format: "encrypted"; wrapped: { document: Record<string, unknown>; fields: readonly WrappedAuthField[] } }
  | { format: "unrecognized" };

/**
 * 载荷顶层 `version` 之外的字段一律忽略：`atRestDeveloperPublicKey` 是 App
 * 自己用的公钥，与本插件无关。
 */
export interface WorkBuddyAtRestPayload {
  atRestSecretKey: string;
}

/** 本插件读取的认证字段；顺序即解密顺序。 */
const AUTH_FIELDS = ["accessToken", "refreshToken"] as const;
/** `account.nickname` 在 5.6 起同样加密，身份展示需要它。 */
const ACCOUNT_FIELDS = ["nickname"] as const;

/** 解码一个 base64 值，给了长度就校验精确字节数。 */
function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) return undefined;
  // Buffer.from 对杂字符宽容；要求往返一致，这样被篡改的信封在任何密钥材料
  // 参与之前就被拒掉。
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

/** 解析一个字段的加密包装；不是合法包装就返回 undefined。 */
function parseWrappedField(field: WrappedAuthField["field"], value: unknown): WrappedAuthField | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const wrapped = value as Record<string, unknown>;
  if (wrapped["$wbEncrypted"] !== 1 || typeof wrapped["envelope"] !== "string") return undefined;
  let inner: unknown;
  try {
    inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
  const parts = inner as Record<string, unknown>;
  const nonce = parseBase64(parts["nonce"], 12);
  const authTag = parseBase64(parts["authTag"], 16);
  const ciphertext = parseBase64(parts["ciphertext"]);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  if (typeof parts["suite"] !== "number" || !Number.isInteger(parts["suite"])) return undefined;
  // suite 1 是 WorkBuddy 5.6.x 为凭据字段定义的唯一方案。其他值属于本插件
  // 没见过的格式，所以包装不被认作 encrypted——文档读出 unrecognized，由
  // 调用方报告诊断，而不是盲目尝试打开。
  if (parts["suite"] !== 1) return undefined;
  if (typeof parts["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(parts["keyId"])) return undefined;
  return {
    field,
    envelope: { suite: parts["suite"], keyId: parts["keyId"], nonce, authTag, ciphertext },
  };
}

/**
 * 读出一份桌面认证文档的形态。`absent` 是空文件；`plaintext` 是常规解析器能读
 * 的任何文档（即使没带 token）；`encrypted` 至少有一个字段处于可解码的包装；
 * 其余——JSON 不可解析、非对象、包装无法解码——都是 `unrecognized`。
 */
export function classifyDesktopAuthDocument(text: string): DesktopAuthClassification {
  if (text.trim() === "") return { format: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { format: "unrecognized" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { format: "unrecognized" };
  const document = parsed as Record<string, unknown>;
  const auth = typeof document["auth"] === "object" && document["auth"] !== null
    ? document["auth"] as Record<string, unknown>
    : document;
  const account = typeof document["account"] === "object" && document["account"] !== null
    ? document["account"] as Record<string, unknown>
    : undefined;
  const fields: WrappedAuthField[] = [];
  const collect = (
    holder: Record<string, unknown>,
    names: readonly WrappedAuthField["field"][],
    // 缺字段是正常的（refreshToken 可能不存在），但字段存在却不是能解码的
    // 包装，说明这是本插件不认识的加密方案，不能当成明文放过去。
    strict: boolean,
  ): boolean => {
    for (const field of names) {
      const value = holder[field];
      if (typeof value === "string") continue;
      const wrapped = parseWrappedField(field, value);
      if (wrapped === undefined && value !== undefined && strict) return false;
      if (wrapped !== undefined) fields.push(wrapped);
    }
    return true;
  };
  if (!collect(auth, AUTH_FIELDS, true)) return { format: "unrecognized" };
  if (account && !collect(account, ACCOUNT_FIELDS, false)) return { format: "unrecognized" };
  if (fields.length === 0) return { format: "plaintext" };
  return { format: "encrypted", wrapped: { document, fields } };
}

/**
 * 把一个加密文档解密成常规解析器可读的明文 JSON 文本。
 *
 * 任一包装字段打不开就抛错，错误里带字段名与 keyId——绝不含信封或 token 内容。
 */
export function unwrapDesktopAuthDocument(
  classification: Extract<DesktopAuthClassification, { format: "encrypted" }>,
  openField: (wrapped: WrappedAuthField) => string | undefined,
): string {
  const wrapped = classification.wrapped;
  const rebuilt = structuredClone(wrapped.document) as Record<string, unknown>;
  for (const field of wrapped.fields) {
    const holder = field.field === "nickname"
      ? (typeof rebuilt["account"] === "object" && rebuilt["account"] !== null
        ? rebuilt["account"] as Record<string, unknown>
        : rebuilt)
      : (typeof rebuilt["auth"] === "object" && rebuilt["auth"] !== null
        ? rebuilt["auth"] as Record<string, unknown>
        : rebuilt);
    const value = openField(field);
    if (value === undefined) {
      throw new Error(
        `workbuddy: 无法解密凭据字段 ${field.field}（keyId ${field.envelope.keyId}）；`
        + "桌面 App 可能已升级加密方式，或本机无法启动其解密 helper",
      );
    }
    holder[field.field] = value;
  }
  return JSON.stringify(rebuilt);
}

/**
 * 一个字段信封的认证上下文 AAD，转写自 App bundle 的
 * `buildAuthenticatedContextAad`（已对 5.6.x 实测验证）。凭据字段在 `field`
 * 框架下恒为 suite 1（WBEV1）；该框架家族的其他成员属于别的文档类型，这里
 * 刻意不实现——打开字段不是猜测未来格式的地方。
 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const prefix = Buffer.from("WB-AAD\0", "ascii");
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  // 凭据字段没有序列号；末尾的 0 对应参考脚本的默认 context。
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/**
 * 用一个 protector key 打开信封；打不开返回 undefined。接受的格式正是
 * WorkBuddy 5.6.x 写入的——`field` 框架下的 suite 1——所以失败意味着
 * "不是这个格式 / 密钥不对"，如实报告而不是换别的框架重试。
 */
export function openAuthField(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * 按 App 自身的规则校验 helper 载荷：`version:1` 且是规范的 32 字节、
 * 非全零 base64 密钥。否则 undefined。
 */
export function parseAtRestPayload(text: string): WorkBuddyAtRestPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const payload = parsed as Record<string, unknown>;
  if (payload["version"] !== 1) return undefined;
  const secret = payload["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") return undefined;
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length !== 32) return undefined;
  if (decoded.toString("base64") !== secret) return undefined;
  if (decoded.every((byte) => byte === 0)) return undefined;
  return { atRestSecretKey: secret };
}

/** 由载荷密钥派生 protector key（对其 UTF-8 字符串做 sha256）。 */
export function deriveProtectorKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * 在 WorkBuddy 改造过的 Electron 里读私人绑定 `workbuddyStorage` 的
 * `loggerGet()`，返回密封的 at-rest 密钥载荷。
 */
const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
const HELPER_SCRIPT_ARGUMENT_FLAG = "-e";
const HELPER_TIMEOUT_MS = 15_000;

/**
 * 启动一次 App 自己的二进制取回密钥载荷。
 *
 * stdout/stderr 不进错误信息：它们可能带路径或崩溃转储，而载荷本身绝不能出现
 * 在消息里。
 */
async function spawnKeyPayload(electronPath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }, (error, stdout) => {
      if (error) {
        const reason = (error as { killed?: boolean }).killed === true
          ? `在 ${HELPER_TIMEOUT_MS}ms 后超时或被终止`
          : error.code !== undefined
            ? `退出码 ${String(error.code)}`
            : "无法启动";
        reject(new Error(`workbuddy: 解密 helper（${electronPath}）${reason}`));
        return;
      }
      const output = stdout.trim();
      if (output === "") {
        reject(new Error(`workbuddy: 解密 helper（${electronPath}）没有输出载荷`));
        return;
      }
      resolve(output);
    });
  });
}

/** 密钥解析结果：protector key 与信封会引用的 keyId。 */
interface ResolvedKey {
  key: Buffer;
  keyId: string;
}

/** keyId 的计算方式与 App 一致：protector key 的 sha256 前 16 个 hex 字符。 */
function keyIdFor(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * 按需解析并缓存 protector key。密钥只在内存中；解析单飞；出现不同 keyId 时
 * 重新解析。
 */
export class WorkBuddyAtRestKeyProvider {
  private readonly electronPath: string | undefined;
  private readonly helperEnvName: string;
  private readonly spawn: (path: string) => Promise<string>;
  private cache: ResolvedKey | undefined;
  private inflight: Promise<ResolvedKey> | undefined;

  constructor(options: {
    electronPath?: string | undefined;
    /** 覆盖 helper 二进制的 env 名，仅用于错误文案。 */
    helperEnvName?: string;
    /** 注入 helper 启动器，测试不必外启真实二进制。 */
    spawn?: (path: string) => Promise<string>;
  } = {}) {
    this.electronPath = options.electronPath;
    this.helperEnvName = options.helperEnvName ?? "WORKBUDDY_ELECTRON_BIN";
    this.spawn = options.spawn ?? spawnKeyPayload;
  }

  /** helper 使用的二进制路径，供诊断与错误文案。 */
  get helperPath(): string | undefined {
    return this.electronPath;
  }

  /**
   * 取一个能打开 `requested` 中任一 keyId 的 protector key。
   *
   * 缓存命中且 keyId 覆盖请求时直接复用；否则重新问一次 helper——信封换了
   * keyId 说明桌面 App 轮换过密钥，旧 key 打不开新信封。
   */
  async protectorKeyFor(requested: readonly string[]): Promise<Buffer> {
    if (this.cache && (requested.length === 0 || requested.includes(this.cache.keyId))) {
      return this.cache.key;
    }
    if (this.electronPath === undefined) {
      throw new Error(
        "workbuddy: 凭据已加密，但未找到桌面 App 的解密 helper。"
        + `设置 ${this.helperEnvName} 指向其可执行文件，或直接登录桌面 App。`,
      );
    }
    this.inflight ??= (async () => {
      const payload = parseAtRestPayload(await this.spawn(this.electronPath!));
      if (!payload) throw new Error("workbuddy: 解密 helper 返回的密钥载荷无法识别");
      const key = deriveProtectorKey(payload.atRestSecretKey);
      return { key, keyId: keyIdFor(key) };
    })().finally(() => {
      this.inflight = undefined;
    });
    const resolved = await this.inflight;
    // 请求的 keyId 与解析出的不符：缓存按新 key 更新，让调用方看到真实的
    // 打开失败，而不是无限重试同一个 key。
    this.cache = resolved;
    return resolved.key;
  }
}
