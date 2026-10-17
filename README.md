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

国内版 id 取 `workbuddy` 而不是 `workbuddy-cn`，是为了**排在前面**：pi 的模型列表按
provider id 排序（`provider.localeCompare`），不看显示名。`workbuddy-cn` 会排在
`workbuddy-ai` 之后，国内版就被挤到国际版下面了。凭据文件名与 id 无关，仍是
`.workbuddy-cn-auth.json`。

两版的模型、账号与积分**互不混用**；各自只跟随对应桌面 App 的登录状态。只登录一版就只出现该版的分组，两版都登录则两组并存。没登录的那版整组隐藏。

## 登录

两版都**直接复用桌面 App 的登录状态**，无需在 pi 里额外登录：

```
设置 → 模型 → WorkBuddy / WorkBuddy AI → Connect
```

凭据解析优先级：

1. `WORKBUDDY_AUTH_FILE`（国内版）/ `WORKBUDDY_AI_AUTH_FILE`（国际版）指定的文件
2. pi 自存的 `.workbuddy-cn-auth.json`（国内版）/ `.workbuddy-ai-auth.json`（国际版）
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

两版都把最近一次成功拉到的目录落盘到 `$PI_CODING_AGENT_DIR/.workbuddy-catalog-<region>.json`，下次启动先用它注册，实时拉取成功后再覆盖。**没登录**的那版整组隐藏（按凭据判断，不看目录）；**登录了但网络慢/断**时用各自的最小内置兜底清单撑住分组，不会消失。

**名单之差 ≠ 可用性之差。** 国际版桌面 App 的产品配置与 `/v3/config` 的 CLI 名单确实是两份名单，但**不能用"不在 CLI 名单里"来判断一个模型能不能用**：`hy4-preview-f`(x0.00) 只出现在 App 侧名单里，实测 `POST /v2/chat/completions` 返回 **200**，是个能用的免费模型。真正不可用的是兜底清单里的 `gpt-5.6-sol`(x3.47) 与 `gpt-6-astra`(x6.67)，请求返回 400 `model [...] service info not found`——它们由 `UNSERVABLE_FALLBACK_IDS` 剔除。判据始终是"上游认不认"，不是"名单里有没有"。

由此，两版的**离线兜底清单与实时名单不必逐条相同**，这是两份真实名单的差异、不是 bug：国际版在线 19 个、兜底 20 个（离线多出 `hy4-preview-f`，在线多出 `glm-5.3-flash`）。启动时的有界等待只保证"同一次启动的首屏与终态一致、同一网络条件下多次重启一致"，不承诺离线与在线看到同一份名单。

缓存里只有模型名与窗口，不含凭据。

默认只列出免费模型（倍率为 0）。国内版的倍率写成 `x2.00 credits`（带单位后缀），国际版写成裸的 `x0.00`，插件统一归一化后再判免费。

推理档来自上游声明的 `supportedEfforts`；未声明但支持推理的模型默认给全套 low/medium/high/xhigh/max。

## 设置

- **侧栏 widget** — 账号、token 过期时间、各套餐余量、目录来源与当前模型列表。
- **`/workbuddy`** — 免费/付费开关与登录管理。无参数时弹菜单，标题会标出当前范围：

  ```
  WorkBuddy 设置（当前：仅免费）
    刷新模型与积分
    列出全部模型（含付费）   ← 切换：只列免费 / 含付费
    断开登录
  ```

  也接受参数，便于手打或在脚本里用：

  | 命令 | 作用 |
  | --- | --- |
  | `/workbuddy all` | 列出**全部模型（含付费）**；付费模型会消耗积分 |
  | `/workbuddy free` | 回到只列免费模型（默认） |
  | `/workbuddy logout` | 两版都断开登录 |
  | `/workbuddy logout-cn` / `-ai` | 只断开其中一版 |

  切换后会重新注册模型并给出一条回执（含当前数量），无需 `/reload`。范围存在
  `~/.pi/agent/.workbuddy-settings.json` 的 `scope` 字段（`free` / `all`），
  所以也可以直接改文件。

### 为什么没有图形开关

pi 与 Pi Agent Desktop 目前都**不支持扩展自带设置界面**：pi 的 `ExtensionAPI` 只有
TUI 类接口（widget/status/footer），没有 settings schema；Desktop 的插件页只有
安装/更新/移除/整包启用停用与版本、资源列表。Desktop 的「设置 → 模型」虽然会给每个
provider 画 checkbox 并写入 `enabledModels`，但那只影响会话与选择器范围，**不影响模型
可见性**（实测勾掉后 `--list-models` 仍列出该模型）。

所以付费开关做成了上面的命令形式——这是当前唯一能真正切换模型集合的入口，而且
**在 Pi Agent Desktop 的斜杠命令里同样可用**。

## 积分

- **个人账号**：`/v2/billing/meter/get-user-resource`，按套餐列出余量。
- **国内版企业账号**（`enterpriseId` 非空）：走 `/v2/billing/meter/get-enterprise-user-usage`，显示单一周期额度；上游 `-1` 是「无上限」标记，显示为「无上限」而不是数字。

积分不自动轮询（每次读取都是真实计费查询），`/workbuddy` 刷新时读取一次。

## 打包

本仓库按 pi package 格式发布（`keywords` 含 `pi-package`，`package.json` 的 `pi.extensions` 指向 `./extensions`）。

```bash
npm pack --dry-run   # 确认 tarball 内容
```

要点：

- `files` 只白名单 `extensions` / `README.md` / `LICENSE`，测试与 tsconfig 不进包。
- 宿主提供的 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 声明在 `peerDependencies`（`"*"`），**不**放进 `dependencies`，也不打包——物理副本会绕过 pi 的扩展模块映射，产生重复的类与注册表。
- `typescript` 仅在 `devDependencies`，不随包分发。


## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 国内版认证文件路径 |
| `WORKBUDDY_AI_AUTH_FILE` | 国际版认证文件路径 |
| `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN` | 解密 helper 的可执行文件 |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 国际版产品配置 JSON 路径（兜底目录） |
| `PI_CODING_AGENT_DIR` | pi agent 目录，影响自存凭据、设置文件与目录缓存的位置 |
| `PI_OFFLINE` / `pi --offline` | `1`/`true`/`yes` 时插件自己也不联网，只用落盘缓存或内置兜底（与 pi 判定一致） |

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
node --experimental-strip-types test/variants.test.mts            # 两版注册、base URL、标记头、可用性闸门与 payload 隔离
node --experimental-strip-types test/scope.test.mts               # hook 不污染其他 provider 的请求
node --experimental-strip-types test/session-start.test.mts       # session_start 不被网络阻塞
node --experimental-strip-types test/desktop-credential.test.mts  # 加密凭据分类与解密
npx tsc -p tsconfig.json                                          # 类型检查
```

### 实时探针

上面几个测试都是离线的：它们只断言"注册出来的东西对不对"，不问"pi 到底显不显示"。
后者必须在真机上验，所以另有一个**会联网、会外启 Electron 解密 helper** 的探针：

```bash
node --experimental-strip-types test/live-probe.mts        # 两版都探
node --experimental-strip-types test/live-probe.mts cn     # 只探国内版
```

它按真实链路走一遍：读桌面认证文件（含 5.6 的加密文档解密）→ 打印账号与 token
指纹（不打印 token 本身）→ 拉 `/v3/config` 实时目录 → 查积分。任何一步失败都会
打印原因，所以"读不到已登录账号"这类问题一眼能定位。

## 排查：模型列表里没有 WorkBuddy

pi 只有在 provider 声明了 `apiKey` 或 `oauth` 时才认为它"已配置"，未配置的
provider 会被**整组**从可用模型快照里剔除——模型选择器与 `--list-models` 读的
都是这份快照。扩展注册了 provider 却没给 `apiKey` 时，症状正是"重启后只剩腾讯云"。
`test/variants.test.mts` 现在有一条断言专门钉住这一点。

先用真实运行时确认模型是否可见（`PI_CODING_AGENT_DIR` 指向一个隔离目录，
避免动到日常配置）：

```bash
mkdir -p /tmp/fv
printf '{"packages":["/absolute/path/to/pi-workbuddy-connect"]}\n' > /tmp/fv/settings.json
env PI_CODING_AGENT_DIR=/tmp/fv pi --list-models
env PI_CODING_AGENT_DIR=/tmp/fv pi --provider workbuddy --model hy3 -p "say OK"      # hy3 免费
```

实时目录会落盘缓存到 `$PI_CODING_AGENT_DIR/.workbuddy-catalog-<region>.json`（两版各
一份，不含凭据）。**注册前**先用它；没有缓存时启动会**等一次实时结果**（上限 2.5 秒），
免得注册出一份几毫秒后就被替换的清单。有缓存或未登录时不等待，日常重启很快。

两版都有一份**最小内置兜底清单**（国内版：`hy3`、`step-5-preview`），所以**已登录**时
网络慢或断，分组依然可用；**未登录**时整组隐藏。判"是否登录"只读本地凭据文件、
**绝不联网**，并把三种情况分开：

- 读出了凭据 → 显示（能不能续期是另一回事，由真正发请求时处理）。
- **有**凭据文件但本机解不开（5.6 加密文档 + 解密 helper 起不来，例如
  `WORKBUDDY_ELECTRON_BIN` 指错）→ **仍显示**。它不是"未登录"；藏起来只会让人
  看到"插件坏了"却查不出原因。
- 压根没有凭据 → 隐藏。

要点：

- 兜底清单是"实测能用"的最小集，不是猜的；实时拉取成功后会整体替换，卡片上标明来源
  （「实时」/「已保存」/「内置兜底」）。
- 预算到点会**中止**这次目录拉取，网络不通时启动最多多花 2.5 秒（实测 2.8–3.1s vs 无
  插件 0.25s）。这条**同样覆盖续期**：启动期需要续期时，续期请求也受同一个截止信号约束，
  所以"token 已过期 + 网络不可达"同样在 2.5 秒量级（实测 2.8s）。真正发聊天请求时若需要
  续期，则按上游自己的超时（30s）走——那条路本来就在等模型回复，不受启动预算约束。
- **列表在会话期内可能变化**：首屏用的是缓存/兜底，之后 `session_start` 那次刷新若拉到
  新目录会再次注册。这是动态目录的正常行为。
- 拿不到实时结果时，首屏清单与在线名单**可能不同**（国际版在线 19 个、兜底 20 个），
  这是两份真实名单的差异。

两条实测边界，避免误解：

- **网络持续慢于 2.5 秒时，看到的是兜底清单，不是完整目录。** 兜底那两条能正常对话，
  但完整名单（国内版 scope=all 有 18 个）要等一次成功的实时拉取。实测：3 秒延迟下
  `scope=all` 只显示 2 个兜底档。
- **缓存只在拉取成功后才写，且一次性命令不一定写得成。** 3 秒延迟下连跑多次
  `pi --list-models` 都不会写缓存（每次都在预算内被中止）；而一次真实的 `pi -p` 会话
  通常会成功落盘（实测 3 次里 2 次），之后就走快路径。网络恢复后自然也会写。

拉取失败时卡片标「已保存」而不是「实时」，来源始终可见。

`PI_OFFLINE`（`1` / `true` / `yes`，与 pi 自己的判定一致；`pi --offline` 等价）下插件
自己也不联网：有缓存就用缓存，没有就退回内置兜底，绝不会偷偷发请求。注意 `PI_OFFLINE=0`
**不是**离线。

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
