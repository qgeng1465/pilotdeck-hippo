# docs 索引

本目录的文档分两类：**本条目（Hippo 选择性保留）自己的文档**，以及**随 fork 基线一并带入的上游 PilotDeck 产品文档**。后者描述上游产品本身，不是本仓库的改动，保留原样以便对照上游行为。

## 本条目相关

| 文档 | 说明 |
|---|---|
| [demo.md](demo.md) | 现场 3–5 分钟复现路径：CLI A/B 对比 + Web UI 压缩分隔线徽章。README §7 指向此文件。 |

仓库根目录另有两份与本条目相关的说明（不在 docs/ 下）：`NOTICE`（fork 来源、许可证与 Hippo 改动清单）、`.env.example`（本地 embedding 与真 LLM 评测的环境变量模板）。

## 上游 PilotDeck 产品文档

| 文档 | 说明 |
|---|---|
| [agent-todo-workflow.md](agent-todo-workflow.md) | 上游 Agent `todo_write` 工作流规范：何时建立 todo、编辑规则、进度更新、工作区产物与验收。 |
| [funasr-installation.md](funasr-installation.md) | 上游本地语音转写（FunASR / SenseVoice）运行时的安装、缓存布局与排障。 |
| [dialog-improvement-api.md](dialog-improvement-api.md) | 上游对话框改进后端接口契约：项目文件检索、技能与 slash command、附件上传、会话级模型覆盖。 |
| [trd-dialog-improvement.md](trd-dialog-improvement.md) | 上面对应接口的 TRD（上游状态：Draft）。 |
| [model-pool-settings-api.md](model-pool-settings-api.md) | 上游模型池设置接口文档（`/api/config`）。 |
| [trd/52-model-pool-settings-api.zh.md](trd/52-model-pool-settings-api.zh.md) | 模型池设置接口 TRD：provider/model 配置、批量连接测试、图片能力补录。 |
| [trd/53-router-settings-api.zh.md](trd/53-router-settings-api.zh.md) | 路由设置接口 TRD：路由开关、任务层级、子智能体策略、模型定价。 |
| [trd/54-search-settings-api.zh.md](trd/54-search-settings-api.zh.md) | 智能体搜索设置接口 TRD：`tools.webSearch` 的读写、校验与连通性测试。 |
| [trd/41-background-task.zh.md](trd/41-background-task.zh.md) | 后台任务运行时 TRD：task 生命周期、输出读取与截断、shell 解析。 |
| [trd/anthropic-prompt-cache.zh.md](trd/anthropic-prompt-cache.zh.md) | Anthropic prompt cache 计划 TRD：`system + recent3` 布局、fingerprint、续传重算。 |
| [trd/README.zh.md](trd/README.zh.md) | 设置接口 TRD 索引（仅列 52 / 53 / 54 三篇）。 |
| [onboarding-api.md](onboarding-api.md) | 上游首次使用引导后端接口文档（`/api/v1`）。 |
| [pilotdeck-onboarding-api.openapi.yaml](pilotdeck-onboarding-api.openapi.yaml) | 上面对应的 OpenAPI 3.1 描述。 |
| [onboarding-backend-trd.md](onboarding-backend-trd.md) | 引导后端 TRD（上游状态：Draft）。 |
| [telemetry/receiver-contract.md](telemetry/receiver-contract.md) | 上游匿名使用统计的接收端契约（`analytics.v2`）。描述的是上游遥测通道，与本条目无关；文中另写明出站事件会剥离路径类字段。 |

## 其他

- `skills/` 是上游的技能目录（每个 `SKILL.md` 一个技能），属产品内容而非本条目文档。
