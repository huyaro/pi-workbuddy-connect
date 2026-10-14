# pi-workbuddy-connect

WorkBuddy provider for [pi](https://pi.dev)：在 pi 里直接使用 **WorkBuddy（国内版）** 与 **WorkBuddy AI（国际版）** 桌面 App 的可登录模型。

参考 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（DSH 插件）实现。本仓库是 pi 原生扩展：无 shim、无 loopback 代理，直接注册两个 provider。

## 安装

```bash
pi install git:github.com/icekale/pi-workbuddy-connect
```

或本地加载：

```bash
pi -e /path/to/pi-workbuddy-connect
```

## 两版并存

| provider id | 产品 | chat 接口 | 计费接口 | 桌面认证文件 |
| --- | --- | --- | --- | --- |
| `workbuddy` | WorkBuddy（国内版） | `copilot.tencent.com` | `www.codebuddy.cn` | `workbuddy-desktop.info` |
| `workbuddy-ai` | WorkBuddy AI（国际版） | `www.workbuddy.ai` | `www.workbuddy.ai` | `workbuddy-desktop-ai.info` |

两版的模型、账号与积分**互不混用**；各自只跟随对应桌面 App 的登录状态。只登录一版就只出现该版的分组，两版都登录则两组并存。没登录的那版整组隐藏——不显示一份选了必然报错的兜底列表。

## 登录

两版都**直接复用桌面 App 的登录状态**，无需在 pi 里额外登录：

```
设置 → 模型 → WorkBuddy / WorkBuddy AI → Connect
```

凭据解析优先级：

1. `WORKBUDDY_AUTH_FILE`（国内版）/ `WORKBUDDY_AI_AUTH_FILE`（国际版）指定的文件
2. pi 自存的 `.workbuddy-auth.json`（国内版）/ `.workbuddy-ai-auth.json`（国际版）
3. 桌面 App 的认证文件（macOS / Windows / Linux）

access token 过期前 5 分钟自动续期，续期结果只写插件自有的副本，**绝不写桌面 App 的文件**。

### 加密凭据

WorkBuddy 5.6 起，两版桌面 App 会把 `auth.accessToken` / `auth.refreshToken` 加密落盘（`{$wbEncrypted:1, envelope}` 包装）。插件会自动解密：以 `ELECTRON_RUN_AS_NODE=1` 运行 App 自己的 Electron 二进制，读取其私有绑定 `workbuddyStorage` 的 at-rest 密钥，再用 `AES-256-GCM` 打开信封。

解密 helper 默认按平台路径自动定位，也可显式指定：

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_ELECTRON_BIN` | 国内版 Electron 可执行文件路径 |
| `WORKBUDDY_AI_ELECTRON_BIN` | 国际版 Electron 可执行文件路径 |

## 模型与推理档

模型目录来自 `/v3/config` 产品文档的 `cli` agent 名单——**网关按 User-Agent 分流**，所以国内版保持 CLI 形态 UA，拿到的正是它自己的请求能用的名单。拉取失败时按「实时 → 已保存 → 内置兜底」降级，卡片上标明当前来源。

默认只列出免费模型（倍率为 0）。国内版的倍率写成 `x2.00 credits`（带单位后缀），国际版写成裸的 `x0.00`，插件统一归一化后再判免费。

推理档来自上游声明的 `supportedEfforts`；未声明但支持推理的模型默认给全套 low/medium/high/xhigh/max。

## 设置

- **侧栏 widget** — 账号、token 过期时间、各套餐余量、目录来源与当前模型列表。
- **`/workbuddy`** — 弹出选择菜单：

  ```
  刷新模型与积分
  列出全部模型（含付费）   ← 切换范围，scope 存 ~/.pi/agent/.workbuddy-settings.json
  断开登录
  ```

  也接受参数：`/workbuddy free` · `/workbuddy all` · `/workbuddy logout`。

切换范围后两个 provider 立即重新注册模型，无需 `/reload`。

## 积分

- **个人账号**：`/v2/billing/meter/get-user-resource`，按套餐列出余量。
- **国内版企业账号**（`enterpriseId` 非空）：走 `/v2/billing/meter/get-enterprise-user-usage`，显示单一周期额度；上游 `-1` 是「无上限」标记，显示为「无上限」而不是数字。

积分不自动轮询（每次读取都是真实计费查询），`/workbuddy` 刷新时读取一次。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 国内版认证文件路径 |
| `WORKBUDDY_AI_AUTH_FILE` | 国际版认证文件路径 |
| `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN` | 解密 helper 的可执行文件 |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 国际版产品配置 JSON 路径（兜底目录） |
| `PI_CODING_AGENT_DIR` | pi agent 目录，影响自存凭据与设置文件位置 |

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `extensions/workbuddy.ts` | 扩展入口：注册两个 provider、卡片、命令、payload 规整 |
| `extensions/variants.ts` | 两版的描述符：base URL、认证文件名、区域判定 |
| `extensions/auth.ts` | 凭据解析与存储、续期策略、加密文档的读取 |
| `extensions/desktop-credential-protection.ts` | 加密凭据的分类、密钥解析与 AES-256-GCM 解密 |
| `extensions/catalog.ts` | `/v3/config` 目录解析、倍率归一化与免费判定 |
| `extensions/upstream.ts` | 上游请求：token 续期、目录、积分（含企业额度）、请求头 |

## 自检

```bash
node --experimental-strip-types extensions/workbuddy.ts --self-check
```

## 测试

```bash
node --experimental-strip-types test/variants.test.mts            # 两版注册、base URL、标记头与 payload 隔离
node --experimental-strip-types test/scope.test.mts               # hook 不污染其他 provider 的请求
node --experimental-strip-types test/session-start.test.mts       # session_start 不被网络阻塞
node --experimental-strip-types test/desktop-credential.test.mts  # 加密凭据分类与解密
npx tsc -p tsconfig.json                                          # 类型检查
```

## 与上游的差异

- 直接 `pi.registerProvider`，去掉 DSH 的 shim 与 loopback 端口转发。
- 推理档由 pi-ai 的 `thinkingLevelMap` 驱动，选择器直接读 `getSupportedThinkingLevels`。
- 选 Default（auto）时**不发送** `reasoning_effort`；选具体档位时原样透传。
- Deepseek-V4.1-Flash 的 `max_tokens` 封顶 16k（`FLASH_MAX_TOKENS`）：该模型会陷入 `OK. / Let me write. / Go.` 式推理循环，把 128k 预算烧完才停。
- 发送前剔除 assistant 消息里回放的 `reasoning` / `thinking` / `reasoning_content` 字段。
- 未移植上游的 reasoning-effort 探测（probe）功能：需要联网发真实请求，且当前模型都已声明 `supportedEfforts`，探测无增益。
- 未移植模型显隐与促销徽章：需要宿主设置页支持，pi 的 widget 不承载这类交互。

## License

MIT
