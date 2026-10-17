// WorkBuddy 两个桌面产品的变体描述符。
//
// 国内版（WorkBuddy）与国际版（WorkBuddy AI）是同一套客户端框架在不同区域的
// 发行版：两者把登录写进**同一个** `CodeBuddyExtension` 认证目录，只靠文件
// basename、站点域名、目录接口与显示名区分。凡是两版不同的东西都收在这里，
// 别的模块就不用各自写 `if (international)` 分支。
//
// 对齐参考实现 corrinehu/dsh-workbuddy-connect 的 `src/variants.ts`。

/** 一个 WorkBuddy 产品变体。 */
export interface WorkBuddyVariant {
  /** 注册给 pi 的 provider id。 */
  id: string;
  /** 模型分组与卡片标题名。 */
  displayName: string;
  /** chat 请求的 base URL。 */
  chatBase: string;
  /** 计费接口的 base URL。 */
  billingBase: string;
  /** 该变体所属区域，决定凭据归属判定。 */
  region: "cn" | "global";
  /** 覆盖桌面认证文件位置的env。 */
  env: string;
  /** 桌面 App 自身认证文件的 basename（位于共享认证目录）。 */
  desktopFilename: string;
  /** 插件自留凭据副本的 basename。 */
  ownFilename: string;
  /**
   * 模型目录来源：国际版走产品配置缓存，国内版走 `/v3/config`。
   */
  catalog: "product-config" | "v3-config";
  /** 用于定位解密 helper 的 Electron 二进制路径。 */
  electronPath?: string;
  /** 覆盖 Electron 二进制位置的 env。 */
  electronEnv: string;
}

/** 国内版。 */
export const CN_VARIANT: WorkBuddyVariant = {
  // id 必须排在 `workbuddy-ai` **前面**：pi 的模型列表按 provider id 排序
  // （`provider.localeCompare`），`workbuddy-cn` 会排在 `workbuddy-ai` 之后，
  // 看起来就是"国内版被挤到国际版下面"。用 `workbuddy` 前缀即天然靠前。
  // 注意凭据文件名仍是 `.workbuddy-cn-auth.json`——那与 id 无关，不必跟着改。
  id: "workbuddy",
  displayName: "WorkBuddy",
  chatBase: "https://copilot.tencent.com",
  billingBase: "https://www.codebuddy.cn",
  region: "cn",
  env: "WORKBUDDY_AUTH_FILE",
  desktopFilename: "workbuddy-desktop.info",
  ownFilename: ".workbuddy-cn-auth.json",
  catalog: "v3-config",
  electronPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
  electronEnv: "WORKBUDDY_ELECTRON_BIN",
};

/** 国际版。 */
export const AI_VARIANT: WorkBuddyVariant = {
  id: "workbuddy-ai",
  displayName: "WorkBuddy AI",
  chatBase: "https://www.workbuddy.ai",
  billingBase: "https://www.workbuddy.ai",
  region: "global",
  env: "WORKBUDDY_AI_AUTH_FILE",
  desktopFilename: "workbuddy-desktop-ai.info",
  ownFilename: ".workbuddy-ai-auth.json",
  catalog: "product-config",
  electronPath: "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron",
  electronEnv: "WORKBUDDY_AI_ELECTRON_BIN",
};

/** 两版并存；国内版在前，作为默认。 */
export const VARIANTS: readonly WorkBuddyVariant[] = [CN_VARIANT, AI_VARIANT];

/** 按 provider id 查变体。 */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return VARIANTS.find((variant) => variant.id === id);
}

/**
 * 登录域名所属区域；空域名按国内版处理（与上游工具链一致）。
 *
 * 这是认证文件归属判定的唯一依据：共享认证目录里两版文件靠 basename 区分，
 * 但凭据本身是否属于该变体，看的是它声明的 domain。
 */
export function regionOf(domain: string): "cn" | "global" {
  const lowered = domain.trim().toLowerCase();
  if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
  return "cn";
}

/** 凭据是否属于该变体：区域必须一致。 */
export function credentialMatchesVariant(domain: string, variant: WorkBuddyVariant): boolean {
  // 空域名无从判定，放行——认证文件已按 basename 分离，域名为空是旧版
  // 客户端的正常形态，不能因此把已登录账号判成未登录。
  if (domain.trim() === "") return true;
  return regionOf(domain) === variant.region;
}
