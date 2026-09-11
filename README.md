<p align="center">
  <img src="assets/banner.png" alt="PilotDeck-Hippo" width="680"/>
</p>

# PilotDeck-Hippo：面向长上下文压缩的选择性记忆

> **PilotDeck 创造计划 · 方向三（Harness / Memory / 架构优化）**

> **提交前必填**：在本文件补充公开仓库链接、参赛分支、最终 commit 的完整 SHA 与现场 Demo 入口（见 [§6](#6-fresh-code-与来源说明队长提交前确认)）。方向三的核心交付是公开 GitHub 仓库、可交互 Demo 和海报；无需把方向一/二的材料误当作必交项。

导航：[核心思路](#核心思路) · [核心作用（真实数据）](#核心作用它到底解决什么) · [评测协议与结果](#4-评测协议与结果) · [快速运行](#3-快速运行源码) · [已知限制](#5-兼容性测试与已知限制) · [上游缺陷修复](#51-顺带修掉的上游缺陷超时定时器被-unref) · [提交清单](#7-方向三提交清单) · [赛事 token 指南（附录 B）](#附录b赛事版指南比赛-token-配置与首次使用)

## 核心思路

上下文压缩是有损的。上游 `CompactionEngine` 在上下文吃紧时保留最近一段（tail）**原文**，把更早的历史**摘要成一段文字**。摘要擅长保留"大意"，却会丢掉低频的**精确事实**——基因名、频率数字、文件路径、检查点、决策记录。而这些恰恰是 Agent 后续任务必须逐字复述的东西。

Hippo 不去做一个"更好的摘要器"——那只是在有损框架里抬高质量上限，而且更贵。Hippo 改的是机制：**让一部分内容根本不进入有损处理。**

在压缩发生前，对即将被摘要掉的消息逐条打分，按一个**固定、有上限**的 token 预算挑出得分最高的若干条，让它们的**原文**与摘要一起进入压缩后的上下文：

```text
S(m) = 0.85 × sim(q, m)          # 与当前待办请求的语义相关度（BM25；可选本地 embedding）
     + 0.15 × position_decay(m)  # 越靠近当前越可能相关
     + 0.00 × idf_pagerank(m)    # 实体共现图核心度；默认权重 0，见 §4.2 的原因
```

三条设计约束，也是它与"再调一次摘要 prompt"的区别：

- **预算是硬的**：保留块预算 = tail 预算的 20%，下限 256 tokens，上限封死。压缩后上下文的大小仍然可控，不会因为"想多记一点"而失控。
- **输出是原文，不是转述**：被保留的消息逐字进入上下文，不受摘要模型能力波动影响。
- **失败即退让**：打分抛错、模型缺失、embedding 加载超时，一律退回纯上游摘要路径，不阻塞对话。

## 核心作用（它到底解决什么）

**一句话：在同样约 1.1–1.2 倍的压缩后 token 下，让压缩后的上下文里"逐字可用的精确事实"从 0 条变成多数条。**

下表的每条数字都来自 `benchmarks/results/*.json`，用**从未参与过任何调参的 seed（20260921–20260930，n=10）** 重新跑过——不是见过 seed 上的最好成绩。指标是 20 条注入事实中，压缩后上下文里**逐字**（而非转述）仍在的条数：

| 场景 | 上游（无保留） | Hippo（当前默认） | 10 个 seed 中 Hippo 胜/平/负 |
|---|---:|---:|---|
| 英文 N=160 | 0 / 20 | **17.9 / 20** | 10 / 0 / 0（符号检验 p=0.002） |
| 中文 N=160 | 0 / 20 | **10.0 / 20** | 10 / 0 / 0（p=0.002） |
| 英文 N=80 | 0 / 20 | **9.4 / 20** | 10 / 0 / 0（p=0.002） |
| 中文 N=80 | 0 / 20 | **6.0 / 20** | 10 / 0 / 0（p=0.002） |

上游的 0 来自"有损摘要 + 不生成 FACT 文本的假摘要器"，是**结构性对照**（有损 vs 逐字），不是真实摘要能力的上限——真 LLM 的对照见 [§4.3](#43-真-llm-闭环两轮记录含敏感性)（该节用 2 seeds/格、自有 seed，与上表不是同一批，两套数字不混用）。真 LLM 闭环里中文任务两轮 4/4 格 Hippo 占优。

**它对你（一个真实用户）意味着什么**：长任务跑了几十轮之后，你问"前面那个 TP53 的频率是多少"，Agent 不该只能说"根据之前的摘要，大约是……"。Hippo 让这类问题仍然能拿到原文数字。

## 评委 1 分钟速览

| 项目 | 内容 |
|---|---|
| 痛点 | 有损摘要在长对话中遗漏早期的精确事实，Agent 后续无法可靠回答。 |
| 改动 | 在 `CompactionEngine` 增加可选 `scorePolicy`，从待摘要消息中选择性保留高分消息。**引擎层**缺省 = 上游路径（逐字节一致，golden fixture 守护）；**App 层**本 fork 默认开启，`agent.compaction.retention: off` 可一键关回上游。 |
| 方法 | `S(m) = 0.85·语义相关 + 0.15·位置衰减 + 0.00·IDF 校正实体图 PageRank`，按 token 预算选取。rank 项权重落 0 是留出集上的结论，原因与取舍见 [4.2](#42-组件消融)。 |
| 当前记录结果 | 结构性基准 N=160：事实保留 0/20 → 17.9/20（**从未参与调参的 10 个 seed 上 10 胜 0 平 0 负，符号检验 p=0.002**，随仓库 JSON 复现）。真 LLM 闭环跑了两个条件（不同端点 × 摘要预算），**中文任务两轮一致占优**（N=160：56.3% vs 31.3%；紧预算轮 81.3% vs 0%），英文任务随摘要预算变化——两轮全表与敏感性分析见 [4.3](#43-真-llm-闭环两轮记录含敏感性)，结论以 `benchmarks/results/*.json` 为准。 |
| 现场路径 | 打开 Web UI（http://localhost:3001，本 fork 中 `agent.compaction.retention` 默认 `hippo`，已启用）→ 创建长对话 → 触发 Compaction → **压缩分隔线上会直接显示保留徽章**（如「Hippo 逐字保留 3 条（1,204 tok）」，悬停给出策略与本次预算）→ 用原问题复问；或直接 `pnpm benchmark:demo`。预计 3–5 分钟。 |

## 1. 问题与设计取舍

上游策略可以概括为"保留最近 tail，其余内容压成摘要"。它对短对话足够有效，但在上下文压力上升时会丢掉不在 tail 中的精确事实。Hippo 只增加一个可开关的保留块：摘要仍负责压缩，保留块负责把少量高价值原文带回上下文。

我们选择本地可计算的特征，避免每次压缩再调用一个大模型：

- **语义相关性**：`sim(q, m)` 中 `q` 是尾部最近一条真实 user 请求。默认 BM25（内部自带 IDF）；设置 `PILOTDECK_BGE_MODEL` 后可切换本地 embedding cosine（`Xenova/bge-small-zh-v1.5`，可离线运行，落在赛事端侧模型额度内）。
- **位置衰减**：当前没有可靠消息时间戳，因此按消息位置计算衰减；它是位置启发式，不等同于真实时间上的艾宾浩斯曲线。
- **实体图核心度**：从消息抽取实体、建共现图、跑 PageRank，再乘 `log(1 + M / df)` 的 IDF，压低在多数消息重复出现的枢纽词。实体抽取双语：ASCII 抽大写驼峰记号，中文用滑动 bigram 免分词抽取 + 高频功能词文档频率剪枝。
- **预算约束**：保留块预算为 `tailTokenBudget × 0.2`，至少 256 tokens；超预算按确定性 tie-break 截断。

默认分数（权重常量 `EBBINGHAUS_DEFAULT_WEIGHTS`，由消融 + 网格搜索重锚，并在**未见 seed** 上复核，见 [4.2](#42-组件消融)）：

```text
S(m) = 0.85 × sim(q, m)
     + 0.15 × position_decay(m)
     + 0.00 × idf_pagerank(m)     # 权重 0，公式项仍保留、可配置
```

第三项默认权重为 **0**：网格搜索的最优点是 `0.85/0.15/0.00`，而 rank 项在留出集上一对一比较 **0 胜 / 33 平 / 3 负**——它在该分布上没有再带来可测量的收益，所以不占权重，但代码与配置项保留，供其他分布启用。该权重是当前合成协议上的调参结果，不能直接视为所有真实任务的全局最优。

没有 query 时 `sim` 退化为常数、不影响排序，保留决策仍由位置与实体图给出。

## 2. 架构与数据流

```mermaid
flowchart LR
  A[CompactionEngine] --> B[待摘要消息]
  B --> C[候选消息抽取]
  C --> D1[BM25 / 本地 embedding]
  C --> D2[位置衰减]
  C --> D3[实体共现图]
  D3 --> D4[PageRank × IDF]
  D1 --> E[加权评分]
  D2 --> E
  D4 --> E
  E --> F[按 token 预算选择 Top-K]
  B --> G[上游 summarizer]
  F --> H[逐字保留块]
  G --> I[摘要块]
  H --> J[合并后的上下文]
  I --> J
```

核心接口（与代码一致）：

```ts
const engine = new CompactionEngine({
  model, // 你的摘要模型适配器
  scorePolicy: buildEbbinghausPageRankPolicy({
    wSim: 0.85, wTime: 0.15, wRank: 0, // 缺省即该值；wRank>0 可重新启用实体图项
  }),
});
const result = await engine.run({ trigger: "auto", messages, keepTailRatio: 0.18 });
```

不传 `scorePolicy` 时走上游路径。App 侧由配置解析成同一个策略，无需改代码：

```ts
// src/context/compaction/retention/EbbinghausPageRankPolicy.ts
resolveRetentionScorePolicy({ retention: "hippo" }) // → EbbinghausPageRankPolicy
resolveRetentionScorePolicy({ retention: "off" })   // → undefined（纯上游）
```

建议在评审时查看以下文件：

- `src/context/compaction/CompactionEngine.ts`：接入开关、候选消息、保留块与合并顺序。
- `src/context/compaction/retention/RetentionTypes.ts`：策略与评分类型。
- `src/context/compaction/retention/MessageText.ts`：统一消息文本化。
- `src/context/compaction/retention/LocalEmbedding.ts`：本地 embedding 与 BM25 fallback。
- `src/context/compaction/retention/EntityGraph.ts`：中英文实体抽取、DF 剪枝、IDF-PageRank。
- `src/context/compaction/retention/EbbinghausScore.ts`、`EbbinghausPageRankPolicy.ts`：评分和预算选择。
- `tests/context/hippo-retention.spec.ts`：专项单测。
- `benchmarks/`：A/B、消融、调参和真 LLM 评测脚本。

## 3. 快速运行（源码）

环境：Node.js `22.13+ <23`、Python 3、`make`、C/C++ 编译器、`ripgrep`。（桌面应用安装包与其他安装方式见[附录 A](#附录a上游-pilotdeck-项目)与[附录 B](#附录b赛事版指南比赛-token-配置与首次使用)。）

```bash
corepack enable
corepack pnpm install --frozen-lockfile
node scripts/bootstrap-pilotdeck-config.mjs   # 生成 ~/.pilotdeck/pilotdeck.yaml
```

在 `~/.pilotdeck/pilotdeck.yaml` 或 Web UI 中配置模型。不要把真实 API Key 写入仓库（环境变量模板见 `.env.example`）：

```yaml
schemaVersion: 1
agent:
  model: custom/<model-id>
  compaction:
    retention: hippo   # 本 fork 默认即 hippo；改为 off 恢复纯上游压缩
model:
  providers:
    custom:
      protocol: openai
      url: https://<接口地址>/v1
      apiKey: ${PILOTDECK_API_KEY}
```

启动 Web UI：

```bash
cd ui && npm run start       # 生产模式（先 vite build），默认 http://localhost:3001
# 开发模式：npm run dev      # 默认 http://localhost:5173
```

若只验证 Hippo，可直接运行：

```bash
corepack pnpm benchmark:no-regression   # scorePolicy 关闭时必须等于上游基线
corepack pnpm benchmark:smoke           # 小规模冒烟
corepack pnpm benchmark                 # 完整 A/B（N=40/80/160 × K=10）
corepack pnpm benchmark:demo            # 大屏 demo
```

真 LLM 评测需要联网，端点解析顺序：① `PILOTDECK_EVAL_URL` + `PILOTDECK_EVAL_KEY` → ② 仓库根 `poliet_deck.txt`（比赛发放网关，密钥不入库）→ ③ `~/deepseek_key.txt`（官方 API）。费用、模型版本、调用参数与 finish_reason 都记录在生成的 JSON 中：

```bash
corepack pnpm benchmark:real-llm
```

## 4. 评测协议与结果

### 4.1 结构性压力测试（fake summarizer）

合成生信对话把 20 条精确事实分散在前 75% 消息，尾部提问要求逐字复述。fake summarizer 不生成 FACT 文本，因此上游 0/20 是"有损摘要 vs 逐字保留"的结构性对照，不能当作真实摘要能力上限。下表为 `pnpm benchmark` 生成的中位数（seed=20260911），出自 `benchmarks/results/2026-09-11T11-16-22-522Z.json`：

| 对话长度 N | 压缩前 tokens | 上游压缩后 | Hippo 压缩后 | 事实保留 /20（上游 → Hippo） |
|---:|---:|---:|---:|---:|
| 40 | 3,906 | 1,153 | 1,381 | 0 → 8 |
| 80 | 8,291 | 2,368 | 2,636 | 0 → 9 |
| 160 | 17,034 | 4,739 | 5,339 | 0 → 18 |

即 Hippo 以约 1.11–1.20× 的压缩后 token 换回逐字事实；全部运行确定性为 `true`。**代价写在明处**：这 11–20% 是多出来的，不是省下来的——Hippo 换的是"压缩后仍能逐字复现事实"，不是"压得更狠"。

### 4.2 组件消融

同一条公式逐项拆开，在相同转录稿上重跑（协议：EN+ZH、N=40/80/160、10 seeds；中位数。出自 `benchmarks/results/ablation-2026-09-11T11-17-30-040Z.json`）：

| 变体 | EN N=160 | EN N=80 | ZH N=160 | ZH N=80 |
|---|---:|---:|---:|---:|
| sim only | 16 | 7 | 8 | 4 |
| time only | 2 | 2 | 2 | 2 |
| rank only（原始 PageRank） | 0 | 0 | 0 | 0 |
| rank only（+IDF） | 0 | 0 | 1.5 | 1 |
| full（旧默认 0.4/0.35/0.25） | 10.5 | 6.5 | 6 | 5 |
| **full（当前默认 0.85/0.15/0.00）** | **18** | **9** | **10** | **6** |

（表内为调参协议下的中位数。"上一版默认 0.7/0.15/0.15" 不在此表——它与当前默认的差异用**留出集**做配对检验，见 §4.5 与下方第 3 条，两套协议的数字不混用。）

消融发现并当场修掉的三个问题：

1. **枢纽稀释**：原始 PageRank 的枢纽是重复噪音（QC、Step 等每条消息出现的记号），事实消息的独有实体反而低分——rank 项单独 0 分。IDF 校正后中文 rank 项恢复信号（ZH N=40：0 → 3.5）。
2. **权重失配**：旧默认让 time/rank 稀释主力 sim 项。`pnpm benchmark:tune` 在 18 配置网格（N=80 × 3 seeds × 2 langs）上重锚，当前默认 **72/120 居首**，且在 §4.2 表的 6 个格子里全部第一。
3. **默认值不是最优解**（留出集复核发现）：上面那张网格的 **argmax 是 `0.85/0.15/0.00`（72/120），而代码里当时常量写的是 `0.7/0.15/0.15`（68/120）**——默认值偏离了调参结果本身。在从未参与调参的 seed 20260921–20260930 上做一对一配对比较（§4.5），rank 项 **7 胜 / 33 平 / 0 负，四个格子无一显著**（p = 1 / 0.5 / 1 / 0.125）。

   **怎么解决的**：把 `EBBINGHAUS_DEFAULT_WEIGHTS` 改为 `{0.85, 0.15, 0}`，与调参 argmax 对齐；rank 项**不删除**，只是权重落 0，公式、实体图代码与 `wRank` 配置项全部保留，需要时一行配置即可重新启用。同时补了一处机制性防护：`holdout.ts` 里「当前默认」一行直接读 `EBBINGHAUS_DEFAULT_WEIGHTS` 常量，而不是抄一份字面量，**默认值再漂移会在留出集表格里直接现形**。

   **诚实边界**：改了权重但**不宣称提升**。留出集上 rank 项 0 负只是说明"去掉它不吃亏"，7 胜 33 平说明效应远小于噪声——真正的依据是它对齐了调参 argmax 且更简单（三项变两项），不是它带来了多少分。相对上游（完全不做保留）的 17.9 / 9.4 / 10.0 / 6.0 才是本文的主效应，四个格子均 10 胜 0 平 0 负、p=0.002。

4. **无 query 时保留退化**（本轮新发现并修掉）：压缩不一定由新用户请求触发——一条超长工具输出撑爆预算同样触发。此时 tail 窗口里没有用户消息，`queryHint` 退化为空串，相似度项归零：留出集 no-query 探针显示当前默认仅保留 **0.00–0.20 / 20** 条事实，而纯 sim 能保留 1–2 条。这不是权重问题——把 rank 权重加回去也救不回主路径（见上）。

   **怎么解决的**：修成因，不加权重。`CompactionEngine` 现在在 tail 找不到真实用户请求时，回退到**全对话中最近的一条真实用户请求**（仍是被压缩消息所服务的那条请求），而不是空串。回归测试 `tests/context/hippo-retention.spec.ts`「retention is still query-conditioned when the tail holds no user request」在撤销该修复后确定性失败（实测策略收到 `""`），修复后通过。顺带说明 rank 项的真实价值位置：它恰在无 query 这个 regime 有信号（中文 no-query 探针 rank+IDF 2.8/20 vs sim-only 1.0/20，英文 0–0.5/20），只是这个 regime 现在从引擎侧被消除了。

### 4.3 真 LLM 闭环（两轮记录，含敏感性）

摘要器与评审员均为 DeepSeek-V4-Flash（temperature 0）；每格 = 2 seeds、共 16 道题。同一模型既生成摘要又评审存在模型偏差，以下数字只作可复现实验记录，不替代独立评审或人工抽检。同一天在两个条件下各跑一轮（端点与摘要 `max_tokens` 不同），**结果差异本身就说明单轮真 LLM 数字不可外推**；两轮 JSON 均随仓库提交（`benchmarks/results/real-llm-*.json`，含端点来源、finish_reason 与 token 计费）。

轮次 A —— 官方 API，摘要 `max_tokens=2200`（偏紧。v4-flash 是推理模型，reasoning token 计入 completion 预算，摘要存在被静默截断的风险；A 轮未记录 finish_reason，截断是事后推断而非实测，见已知限制）：

| lang | N | 上游 | Hippo |
|---|---:|---|---|
| en | 80 | 68.8% (11/16)，2,904 tok | 68.8% (11/16)，3,081 tok |
| en | 160 | 12.5% (2/16)，4,977 tok | **87.5% (14/16)**，5,769 tok |
| zh | 80 | 0% (0/16)，2,340 tok | 18.8% (3/16)，2,319 tok |
| zh | 160 | 0% (0/16)，4,002 tok | **81.3% (13/16)**，4,964 tok |

轮次 B —— 比赛网关，摘要 `max_tokens=4000`（32 次摘要调用中 6 次触顶，已逐格记录）：

| lang | N | 上游 | Hippo |
|---|---:|---|---|
| en | 80 | 100% (16/16)，3,402 tok | 100% (16/16)，3,704 tok |
| en | 160 | 100% (16/16)，5,955 tok | 100% (16/16)，6,278 tok |
| zh | 80 | 0% (0/16)，2,075 tok | **62.5% (10/16)**，2,958 tok |
| zh | 160 | 31.3% (5/16)，4,586 tok | **56.3% (9/16)**，4,912 tok |

两轮合看的三点解读：

1. **中文任务上 Hippo 两轮一致占优（4/4 格）**。v4-flash 写中文摘要时不逐字保留数字事实（上游压缩后 FACT 标记 0/20），Hippo 保留块直接把原文带回上下文。
2. **英文任务的结果由摘要预算调节**。预算紧（A 轮）时上游 N=160 崩到 12.5%；预算放开（B 轮）后上游靠"把检查点逐条抄进更长摘要"回到 100%，摘要 tokens 随之上浮（en N=160：4,977 → 5,955）。即上游要保住精确事实，要么受截断之害，要么为膨胀摘要多付 token；Hippo 用受控预算的逐字保留块达成同样目标。
3. **方差声明**：每格仅 16 题、2 seeds、同模型 judge，官方 API 与比赛网关的服务差异未知。因此只声明方向性结论（中文稳定占优、英文随摘要预算变化），不宣称单一"提升 X 点"。

### 4.4 打分延迟（效率代价）

策略打分是本地计算，中位延迟：EN ≈ 14–50 ms、ZH ≈ 137–369 ms（N=40→160；中文 bigram 实体数约为英文 5–10 倍，图更大）。对比一次真实 LLM 摘要调用（秒级），打分开销 ≈5–15%，且压缩是低频事件。优化路径（每消息实体截断、PageRank 减迭代）已留参数。测量脚本：`pnpm benchmark:ablation`（wall ms 列）；具体机器信息见结果 JSON。

### 4.5 留出集验证（选过参数的 seed 一律不用）

§4.2 的表是在同一批 seed 上选权重、又报同一批 seed 的成绩——那只能说明"拟合得好"，不能说明别的。本节把两件事分开：

- **协议**：`SEEN_SEED_MAX = 20260920`，`HOLDOUT_SEED_BASE = 20260921`。调参/消融只用 ≤ 20260920 的种子；留出集固定取 20260921–20260930 共 10 个种子，**从未参与任何选择**（包括权重、IDF 开关、PageRank 迭代数）。
- **统计**：每个种子与它自己配对（同种子、同转录稿，只换策略），报 per-seed 差值、胜/平/负与**双侧精确符号检验 p**。10 个种子的符号检验最小可能 p 就是 0.002，因此 p=0.002 的含义是"10 战全胜"，不是"效应量很大"。
- **可复核**：`pnpm benchmark:holdout`，本节表格出自 `benchmarks/results/holdout-2026-09-11T11-19-13-567Z.json`（该目录保留了同日更早的若干次运行，本文件是 §4.5 引用的那一份）。

留出集等级表（均值 / 20 条事实，10 seeds）：

| lang | N | 变体 | 保留事实 | sd | 最小 | 最大 | 压缩后 tokens |
|---|---:|---|---:|---:|---:|---:|---:|
| en | 80 | upstream（不做保留） | 0 | 0 | 0 | 0 | 2,362 |
| en | 80 | 旧默认 0.4/0.35/0.25 | 6.6 | 1.35 | 5 | 9 | 2,641 |
| en | 80 | **当前默认 0.85/0.15/0.00** | **9.4** | 0.52 | 9 | 10 | 2,641 |
| en | 160 | upstream（不做保留） | 0 | 0 | 0 | 0 | 4,753 |
| en | 160 | 旧默认 0.4/0.35/0.25 | 10.8 | 0.63 | 10 | 12 | 5,349 |
| en | 160 | **当前默认 0.85/0.15/0.00** | **17.9** | 0.32 | 17 | 18 | 5,355 |
| zh | 80 | upstream（不做保留） | 0 | 0 | 0 | 0 | 2,148 |
| zh | 80 | 旧默认 0.4/0.35/0.25 | 5.1 | 0.57 | 4 | 6 | 2,394 |
| zh | 80 | **当前默认 0.85/0.15/0.00** | **6.0** | 0 | 6 | 6 | 2,392 |
| zh | 160 | upstream（不做保留） | 0 | 0 | 0 | 0 | 4,088 |
| zh | 160 | 旧默认 0.4/0.35/0.25 | 5.9 | 0.57 | 5 | 7 | 4,604 |
| zh | 160 | **当前默认 0.85/0.15/0.00** | **10.0** | 0 | 10 | 10 | 4,610 |

配对比较（同种子互为对照）：

| 比较 | en N=80 | en N=160 | zh N=80 | zh N=160 |
|---|---:|---:|---:|---:|
| 当前默认 vs upstream | +9.4 (10/0/0, p=.002) | +17.9 (10/0/0, p=.002) | +6.0 (10/0/0, p=.002) | +10.0 (10/0/0, p=.002) |
| 旧默认 vs upstream | +6.6 (10/0/0, p=.002) | +10.8 (10/0/0, p=.002) | +5.1 (10/0/0, p=.002) | +5.9 (10/0/0, p=.002) |
| 当前默认 vs 旧默认 | +2.8 (9/1/0, p=.004) | +7.1 (10/0/0, p=.002) | +0.9 (8/2/0, p=.008) | +4.1 (10/0/0, p=.002) |
| 当前默认 vs 上一版默认 0.7/0.15/0.15 | +0.1 (1/9/0, p=1) | +0.2 (2/8/0, p=.5) | 0 (0/10/0, p=1) | +0.5 (4/6/0, p=.125) |

**怎么读这张表，以及不读成什么**：

- 主效应是**第一行**：不做保留 → 逐字保留，四个格子 10 胜 0 平 0 负。这是可以对外声明的结论。
- 第三行（vs 旧默认 0.4/0.35/0.25）也稳，中英文四个格子全胜——旧默认把 0.25 给了 rank 项，让 rank 稀释 sim，是真正的权重失配。
- **第四行必须读成"没有差异"**：7 胜 33 平 0 负，p 值 1 / 0.5 / 1 / 0.125，一个都不显著。改默认权重到 0.85/0.15/0.00 的正当理由是"对齐调参 argmax + 少一项"，**不是"提升了分数"**。任何把它写成"权重优化带来显著提升"的说法都与这张表矛盾。
- zh N=80 / zh N=160 的 sd = 0（10 个种子结果完全一致），这不是精度高，是中文格子里被保留的消息高度集中在同几条典型事实；读中文数字时按 10 个种子看整体方向，不要按小数位比较。

### 4.6 话题切换：旧话题还剩多少（回答"中途换话题"）

前几节的转录稿都是"一路问到底"。真实使用更常见的是**中途换话题**：前半段在聊 A，尾部开始问 B，压缩时只有 B 的请求在手。此时 A 的事实**没有任何 query 相关性可依靠**，只能靠与 query 无关的信号（时近度、实体图核心度）被留存。这正好是衡量"换话题后旧上下文还在不在"的场景。

协议：10 个留出集种子，每个话题 10 条事实（共 20 条），先 A 后 B，压缩时 pending 请求是 B 的。脚本 `pnpm benchmark:topic-switch`，本节表格出自 `benchmarks/results/topic-switch-2026-09-11T11-19-16-507Z.json`。

| 对话长度 | 变体 | 旧话题 A 逐字保留 | 新话题 B 逐字保留 | 压缩后 tokens |
|---:|---|---:|---:|---:|
| 80 | upstream | 0 | 6 | 1,844 |
| 80 | Hippo | **2** | **10** | 2,095 |
| 160 | upstream | 0 | 6 | 3,451 |
| 160 | Hippo | **5.9** | **10** | 3,889 |

三点解读：

1. **上游在换话题后基本保不住旧话题**（0/10，两个长度都是）。它的摘要被尾部请求主导，A 段的内容在摘要里被压成泛泛描述。
2. **Hippo 让旧话题留下来了一部分**（N=160 时 5.9/10），机制是与 query 无关的时近度 + 实体图核心度仍在给 A 段消息打分——这也解释了为什么 rank 项在归一化权重里不占分、却值得保留在代码里。同时新话题 B 从 6/10 提到 10/10。
3. **诚实边界**：这个 harness 用固定文本 stub 摘要器，**摘要本身按构造不可能携带事实**，所以 `summary-only` 两臂都是 0，逐字列就是全部结论。也就是说这张表只回答"逐字保留块里有没有旧话题事实"，不回答"真摘要器下用户能不能答对旧话题问题"——后者要靠 §4.3 的真 LLM 闭环，而 §4.3 没有覆盖话题切换。**这是一个未闭合的实验缺口，我们把它标出来而不是绕过去。**

## 5. 兼容性、测试与已知限制

- 两层开关口径：**引擎层** `scorePolicy` 缺省 = 上游路径，由 `benchmark:no-regression` 与 golden fixture（`benchmarks/baseline-85be774.json`）验证输出逐字节一致；**App 层** 本 fork 默认启用（`agent.compaction.retention: hippo`），`off` 可整体关回上游。
- 每个会话有独立的 CompactionEngine（按 `sessionId` 构造），评分策略无可变跨调用状态、EntityGraph 每次压缩重建——**中途切换会话/项目不会串上下文**。压缩被中断（切走、网络失败、摘要失败）时 transcript 逐字节不变，下次触发重新压缩，这也是上游既有保证。
- 策略评分失败会自动退回纯摘要路径（try/catch 兜底），不让一次打分异常拖垮整个回合。
- 端侧 embedding 按模型路径缓存（同进程只加载一次，多会话共享），单次加载超过 15 秒按失败处理并回退 BM25，避免冷启动/下载卡住压缩。
- **已知限制（上游既有，未修）**：`ui/` 的 `tsc --noEmit` 是红的，125 个文件报错——不是本 fork 引入的，在上游 `ui/src/components/chat/hooks/useChatMessages.ts` 等文件里逐字复现（`msg.reasoningContent` / `msg.userHint` / `Record<string, unknown>` 强转，均在我改动行之外）。根因是依赖图里同时存在 **两份 `@types/react`（18.3.29 与 19.2.15）**，UI 自己解析到 18，其余文件经根 store 解析到 19，于是 19 的 `ReactNode`（含 `bigint`）与 18 的不相容。**UI 本身能构建、能跑**（vite build 通过、514 项测试全绿、Web UI 正常渲染保留徽章），所以这是 typecheck 卫生问题而非运行时故障。修法（统一 `@types/react` 版本）需要动依赖解析并重装，风险大于收益，故如实记录而不在提交前动它。
- 测试数量声明需可复核：当前工作树 2026-09-11 实测全仓 **514 项 = 512 通过 / 0 失败 / 0 cancelled / 2 skipped**（40.0 s，退出码 0）。此前为 481 通过 + 2 cancelled —— 那 2 项 cancelled 不是"满载并发的计时抖动"（早前版本如此解释过，此处撤回），而是 §5.1 缺陷三 的真实缺陷，修掉后取消项归零。

### 5.1 顺带修掉的三个上游缺陷

这三处都不是本 fork 引入的，也都不计入 Hippo 创新点——但都是真实用户会撞到的问题，所以一并修掉、留测试。

**缺陷一：被 `unref()` 掉的超时定时器（一个根因，三处站点）**

`unref()` 的语义是"此定时器不阻止进程退出"。当那个定时器**正是用来 settle 一个被 `await` 的 promise** 时，它就是错的：只要没有别的 libuv 句柄撑着，事件循环会先排空，定时器永远不触发，调用方拿到一个**永不 settle 的 promise**，而不是预期的超时错误。

把全仓 `unref()` 站点逐个按"这个定时器是否在 settle 一个被 await 的 promise"分类后，命中三处：

| 站点 | 症状 |
|---|---|
| `src/network/fetch.ts` | 超时静默失效、重试被跳过；调用方永远等不到 `network_timeout` |
| `src/task/runtime/BackgroundTaskRuntime.ts` `wait()` | `wait(taskId, { timeoutMs })` 永不返回；且该定时器**从不清理**，每次有界等待都留一个悬挂定时器 |
| `src/model/streaming/streamModel.ts` `withIdleTimeout()` | 惰性超时保险失效——流卡死时本该抛 `StreamIdleTimeoutError`，实际是永久挂起 |

其余站点（心跳、空闲清扫、遥测上报、日志轮转等）是**有意**不阻止进程退出的，保留 `unref()`，未改动。

- 证据：三处各自先复现再修，且每个修复都配了一个**在修复前必然失败**的测试：
  - `fetch.ts`：修复前 `tests/network/fetch.spec.js` 7 项全部 cancelled → 修复后 7/7；
  - `BackgroundTaskRuntime`：`tests/task/background-task-runtime.spec.js` 修复前 5/6（第 6 项 `cancelledByParent`，仅 10 ms 就放弃）→ 修复后 6/6；
  - `streamModel`：新增 `tests/model/streaming/idle-timeout.spec.ts` 6 项；把 `unref()` 加回去重跑，**6 项全部 cancelled**，加回修复后 6/6。
- 影响面：`fetch.ts` 是所有模型 provider / MCP 网络调用的底座；另两处分别是后台任务与流式响应。

**缺陷二：分词器在长重复串上退化为 O(n²)（`src/context/budget/tokenizer.ts`）**

这个是被测试**逼出来**的：`tests/tool/read-file-large.spec.js` 第 4 项稳定 60 秒超时。它不是环境问题，是真实的性能缺陷——用 CPU profile 抓到 96% 的时间花在 `js-tiktoken` 的 `bytePairMerge` 上，而不是文件 IO：

| 输入（单个重复字符） | 耗时 |
|---:|---:|
| 500 字符 | 42 ms |
| 1,000 字符 | 136 ms |
| 2,000 字符 | 655 ms |
| 4,000 字符 | 2,424 ms |
| 8,000 字符 | 8,847 ms |

每次翻倍耗时涨约 3.6×——**二次退化**。原因是它的合并循环每轮重扫全部候选对、却只合并一对，而 BPE 会把「一整段重复字符」当成**单个** pre-token，于是这正是最坏输入。Python / Rust 版 tiktoken 用堆实现，没有这个问题。

症状落到用户身上是：`read_file` 读一个 300 行的持久化工具结果要 **79 秒**——足以让任何一个工具调用超时。

- 修复：在 `countTokens` 这一处咽喉换成同一套贪心合并的**堆实现**（取当前相邻对中 rank 最小者，同 rank 取最左——与库的选择规则逐条一致）。合并选择规则相同，结果就相同。
- 证据（本机实测，同一 fixture）：
  - 端到端 `read_file`：**79,238 ms → 1,214 ms**（65×）；
  - 该测试文件：修复前第 4 项挂死、整文件 60 s 超时 3/3 失败 → 修复后 **11/11 通过、2.4 秒**；
  - 等价性：`tests/context/tokenizer-equivalence.spec.ts` 用 **911 例**模糊测试比对堆实现与库原实现（单字符重复串、重复单元、10 种字母表随机文本、混合文本、CJK、emoji、空串、特殊 token 拒绝路径），**0 失配**。
- 影响面：`countTokens` 是所有预算判断的公共底座（`read_file` 文本预算、工具结果预算、micro-compaction、以及 Hippo 自己的 `estimateMessagesTokens`），一处修复全线受益。同样不计入 Hippo 创新点。

**缺陷三："最新事务"的排序键混了逻辑时间与文件 mtime（`src/web/server/replaceLastTurn.ts`）**

启动恢复要判断"哪个替换事务是最新的"，它写的是：

```ts
order: Math.max(preparedAt, backupMtime, journalMtime)   // 修复前
```

`preparedAt` 是事务自己的逻辑时间戳，而两个 mtime 是**文件系统的墙上时钟**。取 `max` 让 mtime 在任何真实场景下都盖过 `preparedAt`，排序实际退化成"哪个文件最后被写"。

而本机文件系统 mtime 粒度是 **1 ms**——实测连续三次写入拿到完全相同的 `mtimeMs`（`...426.997`）。两个事务落在同一毫秒就**并列**，并列则由 `readdirSync` 的返回顺序决定，而那个顺序是任意的。于是恢复会挑中错误的事务：该回滚的报告成已提交。

这正是全量测试里那个偶发失败的真身——`replace-last-turn.spec.js` 的 "startup recovery decides from the newest replacement transaction only" 断言 `rolledBack` 期望 1 实得 0；单独跑 5/5 全过，只有在满载并发下才偶发，所以一直被当成"计时抖动"。

- 修复：`preparedAt` 可解析时**由它单独决定**，mtime 只在 journal 缺失/不可解析时兜底：
  ```ts
  order: Number.isFinite(preparedAt)
    ? preparedAt
    : Math.max(backupMtime ?? 0, journalMtime ?? 0)
  ```
- 证据：新增 `recovery orders transactions by their journal timestamp, not by artifact mtime`——用 `utimes` 把旧事务的文件 mtime 显式推到未来 60 秒（不依赖任何时序），断言恢复仍按 `preparedAt` 选中新事务。把 `Math.max` 改回去重跑，该用例**确定性失败**（1 fail）；修复后 16/16。这样把一个偶发 flake 变成了每次必检的确定性断言。

**同节遗留的一条证据更正**：本 README 早前版本写过"余下 2 项 cancelled 是满载并发的计时抖动"。该说法当时依据的是 `/tmp/pilotdeck-fulltest.log`，而那个文件实际只有 106 字节、没有任何结果——**证据不足，已撤回**。现在的口径是：当时的取消项里，一项的真因是上面的分词器退化、另一项是这里的排序缺陷，两者都已定位并修复，各自有"修复前必然失败"的测试佐证；当前全量结果见 [§5](#5-兼容性测试与已知限制)。

- 真 LLM 轮次 A 未记录 finish_reason，"上游英文崩盘源于摘要截断"是事后推断（依据：B 轮放开预算后上游回到 100%，且 B 轮实测 6/32 次触顶）；该归因尚未被直接测量。
- 未安装 Transformer.js、embedding 模型缺失或加载失败时自动回退 BM25，不报错、不崩溃；模型版本、缓存路径与离线安装说明见 `.env.example`。
- 中文 bigram 会增大实体图（延迟见 4.4）；现场应同时报告硬件与测量脚本。
- 评测主要是合成对话：事实分布偏前且 query 在尾部，time 项在该分布上天然反相关；真实任务的时间特征、噪声和多轮 query 可能改变权重最优点——权重结论以"同分布最优"为口径。
- 真 LLM 结果样本量小（每格 16 题）且摘要器与 judge 同模型；后续应加入独立 judge、人工抽检与未见任务集。
- Hippo 会增加压缩后 token（真 LLM 记录约 +5–24%，视轮次与格子）；展示时应同时给准确率与成本，不能只报准确率。

## 6. Fresh Code 与来源说明（队长提交前确认）

- [ ] Hippo 核心代码、专项测试、benchmark、设计稿和 Demo 在 **2026-09-11 14:00 之后**由参赛队员现场创建。
- [x] 已保留上游基线的仓库链接与改动范围：基线 `https://github.com/OpenBMB/PilotDeck`，基线 commit 前缀 `85be774`（golden fixture 锁定其行为）。
- [ ] 未携带成熟 Demo、商业项目或未报名人员完成的核心代码/设计/调试/文案。
- [ ] 公开开源项目、模型、API 和素材均在本节或 `NOTICE` 中标注来源及许可证。
- [ ] 仓库历史能通过 `git log --stat`、GitHub commit 时间和现场截图复核；所有 benchmark JSON 均脱敏，不含 API Key。

基线信息（本仓库已 git 化，主分支 `main`；完整 SHA 由队长在提交时补全）：

```text
上游仓库：https://github.com/OpenBMB/PilotDeck
基线完整 SHA：85be774…（<full-40-char-sha> 待补，不要只写短前缀）
参赛分支：main
最终提交 SHA：<full-40-char-sha>（提交后回填）
```

仓库卫生：`.gitignore` 已排除 `poliet_deck.txt`（比赛网关凭据）、`*_key.txt`、`.env*`、`node_modules/`、`dist/`；`benchmarks/results/*.json` 已确认不含任何 API Key，随仓库提交以便复核。

## 7. 方向三提交清单

在 2026-09-12 12:00 前由队长提交：

1. 公开 GitHub 代码仓链接（含本 README、测试和 benchmark 结果）。
2. 可交互 Demo 入口：现场 `pnpm benchmark:demo` 与 Web UI（:3001），准备 3–5 分钟复现路径。
3. A3 竖版海报：297×420 mm、300 DPI、3508×4961 px、CMYK、四边 3 mm 出血；正文 ≥10 pt，标题 ≥18 pt，重要文字距边 ≥5 mm——排版由团队完成，文案/版式/数据图索引见 [docs/展位讲解与海报素材.md](docs/展位讲解与海报素材.md)。
4. README 中的改进点、架构/模块、运行方式、性能前后对比、已知限制和技术设计图（即本文件）。
5. 可选加分材料：演示视频、CI/测试输出、`benchmarks/results/` 原始 JSON、独立评审或人工抽检记录。
6. 方向三使用主办方当天公布的额外提交链接；不要误传方向一/二的小程序链路。

## 8. 许可证与上游致谢

本改造基于 [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck)（AGPL-3.0），遵循仓库中的许可证和 NOTICE。最终仓库将保留上游版权声明，并补充 Hippo 改动的作者、日期、基线 SHA 与第三方依赖清单。

## 附录A：上游 PilotDeck 项目

**PilotDeck** 是由清华大学 [THUNLP](https://nlp.csai.tsinghua.edu.cn/) 实验室、[面壁智能](https://modelbest.cn/)、[OpenBMB](https://www.openbmb.cn/) 与 [AI9Stars](https://github.com/AI9Stars) 联合研发的开源 Agent 上下文工程框架：以 WorkSpace 为单位隔离文件、记忆与技能，提供白盒记忆、智能路由、Always-on 等能力，原生支持 [MCP](https://modelcontextprotocol.io/)。本仓库只改动了其上下文压缩模块（见上文），其余能力与上游一致。

- 官网：<https://pilotdeck.openbmb.cn> · 在线体验：<https://pilotdeck.openbmb.cn/pilotdeck.github.io/demo/p/pilotdeck-demo> · 文档：<https://pilotdeck.openbmb.cn/pilotdeck.github.io/docs/en/introduction>
- 一键安装脚本、Docker Compose、插件体系（Extension Protocol）与社区（Discord / 飞书 / 微信）见上游仓库 README：<https://github.com/OpenBMB/PilotDeck>
- 桌面应用安装包：

| Platform | File |
| :--- | :--- |
| macOS (arm64) | [PilotDeck-2026.910.0-mac-arm64.dmg](https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.10/PilotDeck-2026.910.0-mac-arm64.dmg) |
| macOS (x64) | [PilotDeck-2026.910.0-mac-x64.dmg](https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.10/PilotDeck-2026.910.0-mac-x64.dmg) |
| Windows (x64) | [PilotDeck-2026.910.0-win-x64-setup.exe](https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.10/PilotDeck-2026.910.0-win-x64-setup.exe) |

<details>
<summary>macOS 提示「应用已损坏 / 无法验证开发者」</summary>

```bash
xattr -cr /Applications/PilotDeck.app
```

</details>

引用上游：

```bibtex
@misc{pilotdeck2026,
  author       = {PilotDeck Team},
  title        = {PilotDeck: A WorkSpace-Centric Open-Source Agent Operating System},
  howpublished = {\url{https://github.com/OpenBMB/PilotDeck}},
  year         = {2026}
}
```

## 附录B：赛事版指南（比赛 token 配置与首次使用）

> 本附录面向本次赛事选手：赛事 token 配置、网页搜索、Web UI 首次使用与常见问题。

### 配置赛事发放的 token（Web UI 可视化配置，推荐）

本次赛事 token 资源包：

- **价值 400 元的云端大模型 token**：用于接入 PilotDeck 执行任务。提交组队表单后，【接口地址】和【API密钥】将发送到队长邮箱。
- **价值 100 元的端侧模型 token**：可在自己的作品中接入（Hippo 的本地 embedding 即可跑在端侧额度上）；可按需申请额外 200 元额度。

配置步骤：

1. 启动 PilotDeck 并打开 Web UI（默认 `http://localhost:3001`），在 onboarding 面板点击【开始配置】。
2. 使用赛事发放的 token，请点击【自定义】。
3. 填入队长邮箱收到的【接口地址】与【API密钥】。接口地址需要填到 `v1`（形如 `https://api.deepseek.com/v1`）。
4. 在【待选模型】中点选想用的模型并添加（可多选）——出现在【已选用模型】里才算点选成功。
5. 点击【测试连接】，显示绿色即为通过。

本次赛事可选模型包括：**Hy3、DeepSeek-V4-Flash、DeepSeek-V4-Flash-Vision、GLM-5.3、GLM-5.2、GLM-5.3-Flash、MiniMax-M3**（实际模型 ID 可能有前缀）。

等价的配置文件方式（`~/.pilotdeck/pilotdeck.yaml`）：

```yaml
schemaVersion: 1
agent:
  model: custom/<model-id>
model:
  providers:
    custom:
      protocol: openai
      url: https://<赛事接口地址>/v1
      apiKey: <队长邮箱收到的 API Key>
```

### 配置网页搜索

如需【网页搜索】功能，点击左下角【Settings】→【Search】页面选择搜索服务提供商并配置对应的 API Key（一般都有免费额度）：

| Provider 名 | 服务商 | 获取 Key 的网站 |
| :--- | :--- | :--- |
| tavily | Tavily | https://app.tavily.com |
| glm | Z.AI / 智谱 | https://open.bigmodel.cn |
| serper | Serper（Google SERP） | https://serper.dev |
| brave | Brave Search API | https://brave.com/search/api |

### Web UI 使用指南

- **界面概览**：导航包含 Files、Skills、Routing（智能路由）、Memory、Always-On 等模块；左侧为 Projects 项目列表，可在 new conversation 直接创建对话，或进入各项目工作区。
- **创建项目与进入工作区**：每个项目拥有独立的文件系统、记忆、技能与会话历史，项目间互不干扰。
- **发起任务（Ask / Plan 模式）**：在输入框直接用自然语言描述目标；支持 `@文件` 引用工作区文件；可切换 Ask / Plan 模式、设置权限（如 Full Access）、调整上下文。
- **白盒记忆管理**：Memory 模块定期沉淀长期上下文（用户偏好、项目背景、常用路径、关键决策）。可以查看每条记忆的来源与所属 WorkSpace、搜索记忆、修正不准确的记录，必要时直接修改或删除。
- **定时任务与 Always-on**：在输入框直接描述定时任务（例如「每天上午 10 点给我推送最新新闻」），Agent 会自动创建对应的 Cron Job；在 Always-On 页面可查看全部计划与定时任务。

### 赛事 FAQ

| 问题 | 解决方法 |
| :--- | :--- |
| 测试连接失败 | 检查 API Key 是否正确、网络是否可达、Provider 余额是否充足、接口地址是否包含 `/v1` |
| `pilotdeck: command not found` | `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc` |
| 端口冲突（Port 3001/18080 already in use） | `lsof -i :3001 && kill -9 <PID>` |
| `npm install` 失败 | `npm cache clean --force && rm -rf node_modules package-lock.json && npm install --registry=https://registry.npmmirror.com` |
| Windows 报 `npm.ps1` 禁止运行脚本 | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` 后重开 PowerShell，或显式调用 `npm.cmd run dev` |
| 其他问题 | 先尝试刷新页面；仍无法解决可在赛事社群反馈或找现场技术人员 |

## 许可证

AGPL-3.0，详见 [LICENSE](LICENSE)。
