// 实时探针：真的去读当前已登录的桌面 App 凭据（含 5.6 加密文档解密）、
// 拉 `/v3/config` 实时目录、查计费积分。
//
// 与其它测试不同，这个脚本**会联网**、**会外启 Electron 解密 helper**，
// 所以不进常规自检；它存在的意义是回答"插件到底能不能读到已登录的国内版
// 账号和积分"这个只能靠真实环境回答的问题。
//
//   node --experimental-strip-types test/live-probe.mts            # 两版都探
//   node --experimental-strip-types test/live-probe.mts cn         # 只探国内版
//   node --experimental-strip-types test/live-probe.mts ai         # 只探国际版

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  desktopCandidatesFor,
  readText,
  WorkBuddyCredentialStore,
  type Cred,
} from "../extensions/auth.ts";
import { classifyDesktopAuthDocument } from "../extensions/desktop-credential-protection.ts";
import { WorkBuddyUpstream } from "../extensions/upstream.ts";
import { VARIANTS, type WorkBuddyVariant } from "../extensions/variants.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const which = (process.argv[2] ?? "").trim().toLowerCase();
const targets = VARIANTS.filter((variant) =>
  which === "" || variant.id === `workbuddy-${which}` || variant.region === which
);

/** 不打印 token，只打印足以判断"读到了没有"的指纹。 */
function fingerprint(value: string): string {
  if (value === "") return "(empty)";
  return `len=${value.length} sha256=${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function nowStamp(ms: number): string {
  if (ms <= 0) return "未知";
  return `${new Date(ms).toISOString()} (${Math.round((ms - Date.now()) / 86400000)} 天后)`;
}

async function probeVariant(variant: WorkBuddyVariant): Promise<boolean> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`${variant.displayName}  [${variant.id}]  region=${variant.region}`);
  console.log("=".repeat(72));

  // --- 第 1 步：桌面认证文件在原地的形态 -------------------------------
  console.log("\n[1] 桌面认证文件");
  for (const path of desktopCandidatesFor(variant)) {
    const text = await readText(path);
    if (text === undefined) {
      console.log(`  ✗ 不存在  ${path}`);
      continue;
    }
    const classified = classifyDesktopAuthDocument(text);
    console.log(`  ✓ 存在    ${path}  (${text.length} bytes, ${classified.format})`);
  }

  // --- 第 2 步：凭据解析（含解密 helper）-------------------------------
  console.log("\n[2] 凭据解析（含 5.6 加密文档解密）");
  const upstream = new WorkBuddyUpstream({ variant });
  const store = new WorkBuddyCredentialStore({
    variant,
    agentDir,
    refresh: (cred) => upstream.refreshAccess(cred),
  });
  let cred: Cred;
  try {
    cred = await store.resolve();
  } catch (error) {
    console.log(`  ✗ 解析失败: ${(error as Error).message}`);
    return false;
  }
  console.log(`  ✓ 账号    ${cred.nickname ?? "(无昵称)"}  uid=${cred.uid || "(无)"}`);
  console.log(`  ✓ 来源    ${cred.source}`);
  console.log(`  ✓ 区域    domain=${cred.domain || "(空)"}  enterpriseId=${cred.enterpriseId ?? "(无)"}`);
  console.log(`  ✓ token   access ${fingerprint(cred.accessToken)}`);
  console.log(`            refresh ${fingerprint(cred.refreshToken)}`);
  console.log(`  ✓ 过期    access ${nowStamp(cred.expiresAtMs)}`);
  if (cred.refreshExpiresAtMs !== undefined) {
    console.log(`            refresh ${nowStamp(cred.refreshExpiresAtMs)}`);
  }

  // --- 第 3 步：真实调用上游 -------------------------------------------
  console.log("\n[3] 上游 /v3/config 实时目录");
  try {
    const models = await upstream.fetchModels(cred);
    console.log(`  ✓ 拿到 ${models.length} 个模型`);
    for (const model of models) {
      const tag = model.free ? "免费" : `付费 ${model.credits ?? "?"}`;
      const efforts = model.supportedEfforts?.join("/") ?? (model.supportsReasoning ? "默认全套" : "无推理");
      console.log(
        `    - ${model.id.padEnd(28)} ${tag.padEnd(16)}`
        + ` ctx=${model.contextWindow} max=${model.maxTokens} efforts=${efforts}`,
      );
    }
    const free = models.filter((model) => model.free);
    console.log(`  → 其中免费 ${free.length} 个: ${free.map((m) => m.id).join(", ") || "(无)"}`);
  } catch (error) {
    console.log(`  ✗ 目录拉取失败: ${(error as Error).message}`);
  }

  console.log("\n[4] 积分");
  try {
    const credits = await upstream.fetchCredits(cred);
    console.log(`  ✓ 合计    ${credits.unlimited ? "无上限" : credits.total}`);
    for (const pack of credits.accounts) {
      const right = pack.unlimited ? "无上限" : pack.size > 0 ? `${pack.remain} / ${pack.size}` : String(pack.remain);
      console.log(`    - ${pack.packageName.padEnd(32)} 剩余 ${right}${pack.cycleResetTime ? `  重置 ${pack.cycleResetTime}` : ""}`);
    }
    if (credits.accounts.length === 0) console.log("    (没有套餐条目)");
  } catch (error) {
    console.log(`  ✗ 积分查询失败: ${(error as Error).message}`);
  }
  return true;
}

console.log(`pi agent 目录: ${agentDir}`);
console.log(`平台: ${process.platform}  Node: ${process.version}`);
console.log(`探测变体: ${targets.map((v) => v.id).join(", ")}`);

let anyOk = false;
for (const variant of targets) {
  if (await probeVariant(variant)) anyOk = true;
}
console.log(`\n${"=".repeat(72)}`);
console.log(anyOk ? "结论：至少一版凭据可读。" : "结论：没有任何一版凭据可读。");
