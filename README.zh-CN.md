<p align="center">
  <img src="apps/desktop/assets/icon.png" alt="一凡 Fan 图标" width="128" height="128">
</p>

<h1 align="center">一凡 Fan</h1>

<p align="center">
  一款与你共同操作真实可见浏览器的开源桌面 AI 智能体。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/7757/Fan-Browser-Agent/releases/latest">下载</a> ·
  <a href="https://fandcode.com">官方网站</a> ·
  <a href="https://fandcode.com/scenarios">使用场景</a> ·
  <a href="SECURITY.md">安全政策</a> ·
  <a href="LICENSE">MIT 许可证</a>
</p>

> [!IMPORTANT]
> Fan 目前处于早期预览阶段。它能够操作真实网页和本地工具，也会受到网页变化、模型能力与本机环境的影响。建议先从低风险、可复核的任务开始，并在提交、付款、发送或删除等关键动作前保持人工确认。

## 项目介绍

Fan 将 Electron 桌面应用、内嵌 Chromium 浏览器和本地 Python 智能体运行时组合在一个工作区里。你描述目标，Fan 观察真实页面、规划步骤、操作浏览器并整理结果；遇到登录、验证码、敏感输入或重要决策时，它会停下来把控制权交还给你。

它不是一个只能给出建议的聊天窗口，也不要求你为每个网站维护一套固定脚本。任务过程始终发生在可见浏览器中，页面、标签页、执行进度和待确认操作都可以随时检查。

## 产品截图

<p align="center">
  <a href="https://fandcode.com" title="观看 Fan 产品演示">
    <img src="https://dermei.oss-cn-shanghai.aliyuncs.com/website/home/area-v1-poster.jpg" alt="Fan 在真实浏览器中执行任务，并在右侧展示过程与人工接管入口" width="920">
  </a>
</p>

<p align="center">
  点击图片观看产品演示
</p>

| 真实场景 | Fan 完成的任务 | 演示 |
|---|---|---|
| 韩国签证申请 | 选择签证类型、填写表单、上传资料并在关键步骤等待确认 | [查看案例](https://fandcode.com/scenarios/enterprise) |
| PubMed 文献检索 | 跨多个标签页筛选并核对论文信息，整理成可复查结果 | [查看案例](https://fandcode.com/scenarios/fullstack) |
| UPS 包裹追踪 | 从失效入口恢复到有效页面，核对状态、地点与日期 | [查看案例](https://fandcode.com/scenarios/frontend) |

## 为什么使用 Fan

Fan 最初来自一个很个人的需求：做一款足够简单的桌面 AI 助手，专注 browser use 和 computer use，先解决自己每天面对的真实网页任务。

当时许多 browser agent 更像完全自动运行的脚本或聊天演示，但真实任务里经常需要人参与：登录和验证码应该由用户处理，表单提交前应该允许检查，付款、发送、删除和方案选择也不应该被静默越过。因此，Fan 从一开始就把 human-in-the-loop 当作核心交互，而不是失败后的补救措施。

另一个问题是 token 消耗。把完整页面 DOM 和大量底层工具直接交给模型，会让一次任务不断重复“看一眼、走一步”。Fan 将浏览器能力收敛为少量面向目标的接口，在内部编排连续操作，并对历史页面上下文做剪枝，尽可能把模型调用留给真正需要理解和决策的节点。

这形成了 Fan 的几个设计选择：

- **真实可见。** Agent 使用嵌入式浏览器工作，不在不可见的远程环境里替你操作。
- **人可以随时加入。** 登录、验证码、敏感输入和高风险动作能够自然交还给用户。
- **过程可以复查。** 页面状态、标签页、任务步骤与结果保留在同一个工作区里。
- **本地优先。** 配置、会话、Skills 和任务历史默认保存在本机，不依赖 Fan 产品账号。
- **模型可以替换。** 你可以选择内置 Provider，也可以连接自己的 OpenAI 兼容端点。
- **能力可以沉淀。** Skills、MCP、插件和定时任务让高频工作流逐步复用，而不必每次从零开始。

Fan 最先是为了帮助作者自己完成工作而开发的。现在把它开源，希望需要可见浏览器、人工确认和本地工具协作的人，可以直接使用、修改，并一起讨论浏览器智能体应该如何工作。

## 快速开始

### 下载桌面应用

请从 [GitHub Releases](https://github.com/7757/Fan-Browser-Agent/releases/latest) 下载最新版本：

| 平台 | 安装包 |
|---|---|
| macOS Apple Silicon | `Fan-0.4.3-mac-arm64.dmg` |
| macOS Intel | `Fan-0.4.3-mac-x64.dmg` |
| Windows x64 | 推荐 `Fan-0.4.3-win-x64.exe`，也提供 MSI |
| Linux x64 | AppImage、DEB 或 RPM |

0.4.3 是尚未进行商业代码签名的早期预览版，macOS Gatekeeper 或 Windows SmartScreen 可能提示未知开发者。请只从本仓库 Release 页面下载，并使用 `SHA256SUMS.txt` 核对文件。安装版后续也会从同一个 GitHub Releases 源检查更新。

### 从源码启动

环境要求：

| 组件 | 版本 |
|---|---|
| Python | 3.11–3.13 |
| Node.js | 22.12 或更高版本 |
| Python 包管理器 | `uv` |
| Node.js 包管理器 | `npm` |
| 操作系统 | macOS、Windows 或 Linux |

从源码启动：

```bash
git clone https://github.com/7757/Fan-Browser-Agent.git
cd Fan-Browser-Agent
npm run dev
```

首次运行会安装锁定的 Python 和 Node.js 依赖，然后启动桌面应用。请始终从仓库根目录执行命令。

如果只想安装依赖而不启动：

```bash
npm run setup
```

开发版数据默认保存在 `~/.dev_fan`。如需使用其他目录，可在启动前设置 `FAN_HOME`。

## 配置模型 Provider

首次打开 Fan 时会出现模型 Provider 配置窗口。选择 Provider、填写 API Key 并通过连通性验证后，即可开始对话。之后也可以在“设置 → 偏好”中切换或更新配置。

| Provider | 当前内置模型 | 需要配置 |
|---|---|---|
| DeepSeek（推荐） | `deepseek-v4-flash`、`deepseek-v4-pro` | DeepSeek API Key |
| Alibaba Bailian / DashScope | `qwen3-vl-plus`、`qwen3.7-max` | DashScope API Key |
| Alibaba Cloud Coding Plan | `qwen3-vl-plus`、`qwen3.7-max` | Coding Plan 或 DashScope API Key |
| Ollama Cloud | `nemotron-3-nano:30b` | Ollama API Key |
| 自定义端点 | 由你指定 | OpenAI 兼容 Base URL、模型 ID，以及端点需要的 Key |

如果选择 DeepSeek：

1. 打开“设置 → 偏好”中的模型 Provider 卡片。
2. 选择 **DeepSeek**。
3. 填写 DeepSeek API Key。
4. 选择模型并保存；Fan 会先验证连接，再将配置写入本机。

Provider 选择和模型名称保存在 `$FAN_HOME/config.yaml`，API Key 保存在 `$FAN_HOME/.env`。界面和本地 API 不会返回完整 Key。

## 核心功能

- 浏览、搜索、点击、输入、填写表单、上传文件、截图和保存 PDF。
- 在操作后重新检查真实页面状态，而不是假设点击已经成功。
- 同时运行多个任务，并在工作区中查看进度、结果和待处理状态。
- 在登录、验证码、CAPTCHA、敏感输入和关键动作前请求用户接管或确认。
- 使用本地文件、终端、代码、图片、记忆和产物工作区。
- 创建本地定时任务，暂停、恢复或立即执行，并保留本地执行历史。
- 管理本地 Skills，连接 MCP Server，并通过插件扩展能力。
- 使用子代理拆分可以并行推进的复杂任务。

## 本地数据与网络边界

开源版不要求注册或登录 Fan 产品账号。Electron、Python 后端和浏览器运行时之间使用仅限本机回环地址的能力令牌通信，这些令牌用于隔离本机进程，不是用户账号系统。

| 数据或请求 | 默认行为 |
|---|---|
| 模型 API Key | 保存在本机 `$FAN_HOME/.env` |
| 模型与应用配置 | 保存在本机 `$FAN_HOME/config.yaml` |
| 会话、Skills、定时任务和日志 | 保存在本机 `$FAN_HOME` 目录下 |
| 模型请求 | 直接发送给你配置的 Provider 或自定义端点 |
| 浏览器网络 | 仅在你或 Agent 打开网页、下载资源或执行网页任务时发生 |
| MCP、插件和外部工具 | 仅在你配置或启用对应能力后连接其目标服务 |
| 应用更新 | 从本仓库公开的 GitHub Releases 源检查 |
| 产品分析、支持对话和诊断包 | 开源版不会自动上传到 Fan 运营的服务 |

Fan 可以执行终端命令、读写本地文件并操作已登录的网页，因此它应被视为拥有当前操作系统用户权限的本地应用，而不是安全沙箱。

## 工作原理

```text
React 界面 + Electron
        ↕ 本机鉴权 HTTP / WebSocket
Python 网关 → 智能体循环 → 工具、Skills、MCP、记忆
        ↕ 浏览器 RPC
内嵌 Chromium 浏览器
```

Electron 负责窗口、标签页、浏览器视图、原生输入和浏览器运行时；Python 负责模型调用、会话状态、工具执行、审批和持久化。

面向模型的浏览器接口保持精简：

- `browser_snapshot`：读取紧凑、带编号的页面快照。
- `browser_run`：通过 `fan.*` 浏览器 API 执行有边界的连续操作。
- `browser_handoff`：将浏览器控制权交还给用户。

这种设计避免把每一个底层浏览器动作都暴露为独立模型工具，也减少在长任务中重复发送完整页面内容。

## 项目结构

| 路径 | 用途 |
|---|---|
| `apps/desktop/` | Electron 主进程、React 界面、浏览器运行时和打包配置 |
| `agent/` | 智能体循环、上下文管理、模型传输和提示词 |
| `fan_cli/` | 配置、本地后端、会话和命令入口 |
| `tools/` | 浏览器、终端、文件、记忆、MCP、审批和工作流工具 |
| `tui_gateway/` | 桌面端使用的鉴权 JSON-RPC/WebSocket 桥接层 |
| `skills/`、`plugins/`、`providers/` | 内置工作流与扩展入口 |
| `cron/` | 本地定时任务调度与执行 |
| `tests/` | Python 单元测试和集成测试 |
| `testbed/` | 浏览器工作流使用的本地测试页面 |
| `scripts/` | 开发、检查、构建和开源打包脚本 |

## 开发与贡献

安装依赖并检查常用入口：

```bash
npm run setup
npm --prefix apps/desktop run type-check
npm --prefix apps/desktop run lint
.venv/bin/python -m pytest
.venv/bin/python -m fan_cli.main --help
```

桌面安装包通过 `apps/desktop` 中的 `dist:mac`、`dist:win` 或 `dist:linux` 构建。正式构建需要 Git commit，以便准确标识安装包对应的源码。

欢迎通过 [Issues](https://github.com/7757/Fan-Browser-Agent/issues) 报告问题或提出功能建议，也欢迎提交 Pull Request。提交代码时，请说明修改目的、影响范围以及你完成的检查；涉及界面变化时请附截图或录屏。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，使用帮助与问题分流见 [SUPPORT.md](SUPPORT.md)，维护者发版步骤见 [docs/RELEASING.md](docs/RELEASING.md)。

## 联系作者

如果你在使用 Fan 时遇到问题，或者对 browser agent、computer use、human-in-the-loop 交互和本地 AI 工具有好的想法，欢迎提交 Issue，也可以添加作者微信直接交流。

添加时请备注 **Fan Browser Agent**。

<p align="center">
  <img src="logo/wechat-7757.png" alt="Fan 作者 7757 的微信二维码" width="360">
</p>

## 故障排除

### 首次启动停留在依赖安装

确认 Python 和 Node.js 版本符合要求，然后在仓库根目录重新运行：

```bash
npm run setup
npm run dev
```

### 提示尚未配置模型或 Provider 不受支持

打开“设置 → 偏好”，重新选择一个受支持的 Provider 并保存。旧版本留下的 Provider 配置不会被当作有效凭据继续使用。

### 修改代码后界面或 Skills 加载异常

仅刷新页面可能不会重启 Electron 主进程和 Python 后端。请完全退出 Fan，再从仓库根目录运行：

```bash
npm run dev
```

### 后端返回“Frontend not built”

开发环境应通过仓库根目录的 `npm run dev` 启动。直接启动 Python 后端时，需要先构建桌面前端。

### 在哪里查看日志

桌面和 Agent 日志位于 `$FAN_HOME/logs/`。开发环境默认可在 `~/.dev_fan/logs/` 下查看。

## 安全

Fan 使用启动它的用户权限执行本地工具。终端、Skills、插件和 MCP Server 都不是安全沙箱。启用扩展前请先审查来源，需要隔离时应使用操作系统级沙箱或容器。

请不要在公开 Issue 中提交 API Key、登录 Cookie、私有网页内容或包含个人数据的日志。安全模型、影响范围和漏洞私下报告方式见 [SECURITY.md](SECURITY.md)。

## 致谢与上游

Fan 的 Agent 运行时基于 Nous Research 的开源项目 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 开发，并针对可见桌面浏览器、human-in-the-loop 交互和本地模型 Provider 配置进行了定制。感谢 Nous Research 与 Hermes Agent 的贡献者为通用 Agent 循环、工具系统、Skills、记忆和任务调度奠定的基础。

Hermes Agent 采用 MIT License 发布，版权所有 © 2025 Nous Research。上游许可证全文见 [NousResearch/hermes-agent/LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)。本项目在根目录 `LICENSE` 中保留了适用的上游版权与许可声明。

## 许可证

Fan 源代码采用 [MIT License](LICENSE)。第三方软件及外部模型/API 服务适用各自的条款。

版权所有 © 2025–2026 [Xingfan Technology](https://xingfan.com)。
