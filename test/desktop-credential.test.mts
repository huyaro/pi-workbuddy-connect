// 加密凭据的分类与解密：用合成密钥验证 `{$wbEncrypted:1, envelope}` 的读写
// 往返、AAD 构造、以及非加密/畸形文档的判定。不读取任何真实凭据。
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  buildAuthenticatedContextAad,
  classifyDesktopAuthDocument,
  deriveProtectorKey,
  openAuthField,
  parseAtRestPayload,
  unwrapDesktopAuthDocument,
  WorkBuddyAtRestKeyProvider,
  type WorkBuddyEnvelope,
} from "../extensions/desktop-credential-protection.ts";

/** 按生产格式密封一个字段（与参考实现的 sealAuthFieldForTest 同构）。 */
function sealField(key: Buffer, plaintext: string): { $wbEncrypted: 1; envelope: string } {
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAuthenticatedContextAad(keyId, 1));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const inner = {
    suite: 1,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(inner), "utf8").toString("base64") };
}

// 与 App 一致的密钥派生：sha256(secret) 的 hex 前 16 位即 keyId。
const secret = randomBytes(32).toString("base64");
const key = deriveProtectorKey(secret);

const document = {
  account: { uid: "u1", nickname: sealField(key, "someone@example.com") },
  auth: {
    accessToken: sealField(key, "access-token-value"),
    refreshToken: sealField(key, "refresh-token-value"),
    domain: "www.codebuddy.cn",
    expiresAt: 1_800_000_000_000,
  },
};

// 分类：有包装字段即为 encrypted。
const classified = classifyDesktopAuthDocument(JSON.stringify(document));
if (classified.format !== "encrypted") throw new Error(`expected encrypted, got ${classified.format}`);
if (classified.wrapped.fields.length !== 3) {
  throw new Error(`expected 3 wrapped fields, got ${classified.wrapped.fields.length}`);
}

// 解密后重建的文档必须是常规解析器能读的明文形态。
const plain = unwrapDesktopAuthDocument(classified, (field) => openAuthField(key, field.envelope));
const rebuilt = JSON.parse(plain);
if (rebuilt.auth.accessToken !== "access-token-value") throw new Error("access token round-trip");
if (rebuilt.auth.refreshToken !== "refresh-token-value") throw new Error("refresh token round-trip");
if (rebuilt.account.nickname !== "someone@example.com") throw new Error("nickname round-trip");
if (rebuilt.auth.domain !== "www.codebuddy.cn") throw new Error("untouched field preserved");

// 错误的密钥必须打不开，且返回 undefined 而不是抛错。
const wrongKey = deriveProtectorKey(randomBytes(32).toString("base64"));
if (openAuthField(wrongKey, classified.wrapped.fields[0].envelope) !== undefined) {
  throw new Error("wrong key must not open a field");
}
// 篡改密文同样打不开。
const tampered: WorkBuddyEnvelope = {
  ...classified.wrapped.fields[0].envelope,
  ciphertext: Buffer.from("tampered", "utf8"),
};
if (openAuthField(key, tampered) !== undefined) throw new Error("tampered envelope must not open");

// 明文文档保持 plaintext；空文件 absent；非法 JSON unrecognized。
const plaintextDoc = classifyDesktopAuthDocument(JSON.stringify({
  auth: { accessToken: "plain", refreshToken: "plain-r", domain: "www.workbuddy.ai" },
  account: { uid: "u", nickname: "n" },
}));
if (plaintextDoc.format !== "plaintext") throw new Error("plaintext document misclassified");
if (classifyDesktopAuthDocument("").format !== "absent") throw new Error("empty document must be absent");
if (classifyDesktopAuthDocument("{not json").format !== "unrecognized") throw new Error("bad json must be unrecognized");
// 字段存在却是本插件不认识的加密方案：不能当成明文放过去。
if (classifyDesktopAuthDocument(JSON.stringify({
  auth: { accessToken: { $wbEncrypted: 2, envelope: "x" } },
})).format !== "unrecognized") throw new Error("unknown scheme must be unrecognized");

// 载荷校验：只接受 version 1 与规范的 32 字节非全零密钥。
if (!parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: secret }))) {
  throw new Error("valid payload rejected");
}
if (parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: secret }))) {
  throw new Error("wrong version accepted");
}
if (parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: randomBytes(16).toString("base64") }))) {
  throw new Error("short secret accepted");
}
if (parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32).toString("base64") }))) {
  throw new Error("all-zero secret accepted");
}

// key provider：注入的 helper 结果被解析并缓存；keyId 变化时重新解析。
let spawns = 0;
const provider = new WorkBuddyAtRestKeyProvider({
  electronPath: "/nonexistent/Electron",
  spawn: async () => { spawns += 1; return JSON.stringify({ version: 1, atRestSecretKey: secret }); },
});
const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
const resolved = await provider.protectorKeyFor([keyId]);
if (!resolved.equals(key)) throw new Error("provider returned the wrong key");
if (spawns !== 1) throw new Error(`expected 1 spawn, got ${spawns}`);
await provider.protectorKeyFor([keyId]);
if (spawns !== 1) throw new Error("matching keyId must reuse the cached key");
await provider.protectorKeyFor(["0000000000000000"]);
if (spawns !== 2) throw new Error("a different keyId must re-resolve");

// 没有 helper 路径时给出可诊断错误，而不是静默返回空密钥。
const unavailable = new WorkBuddyAtRestKeyProvider({ electronPath: undefined, helperEnvName: "TEST_ELECTRON_BIN" });
let threw = false;
try {
  await unavailable.protectorKeyFor([keyId]);
} catch (error) {
  threw = true;
  if (!(error as Error).message.includes("TEST_ELECTRON_BIN")) {
    throw new Error("unavailable helper error must name the env var");
  }
}
if (!threw) throw new Error("missing helper must throw");

console.log("OK: encrypted credential classification, AES-256-GCM round-trip, key caching, and payload validation");
