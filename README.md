<p align="center">
  <img src="assets/banner.png" alt="PilotDeck-Hippo" width="680"/>
</p>

<p align="center">
  <a href="https://github.com/qgeng1465/pilotdeck-hippo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/qgeng1465/pilotdeck-hippo/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/qgeng1465/pilotdeck-hippo/actions/workflows/docker-build.yml"><img src="https://img.shields.io/github/actions/workflow/status/qgeng1465/pilotdeck-hippo/docker-build.yml?branch=main&label=docker%20build" alt="Docker Build"></a>
  <a href="https://github.com/qgeng1465/pilotdeck-hippo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/qgeng1465/pilotdeck-hippo" alt="License"></a>
</p>

# PilotDeck-Hippo：让压缩后的上下文还能逐字说出早期事实

> PilotDeck 创造计划 · 方向三（Harness / Memory / 架构优化） · [English](README.en.md) · **在线 Demo：<https://qgeng1465.github.io/pilotdeck-hippo/>**

<a href="https://qgeng1465.github.io/pilotdeck-hippo/assets/demo.mp4">
  <img src="https://qgeng1465.github.io/pilotdeck-hippo/assets/demo-poster.png" alt="真实会话里压缩边界上的 Hippo 保留徽章" width="760">
</a>

**60 秒录屏（点图播放）**：前半是 `benchmark:demo` 的真实终端输出——同一份输入，上游保留 0/20 条早期事实，Hippo 16/20；后半是真实 Web UI 里一个**仍在进行**的任务被压缩**两次**，两次压缩边界行都带 `Hippo kept N msgs verbatim` 徽章。只有开头的标题卡是合成的，压缩时刻全部原速。

**一句话。** PilotDeck 在上下文变长时会压缩对话：保留最近一段原文，把更早的内容写成摘要。摘要记得住大意，但容易丢掉那些必须一字不差的事实——文件名、数字、检查点、决策记录。Hippo 在压缩前挑出一小批最相关的消息，让它们的**原文**绕过摘要、直接留在压缩后的上下文里。

## 它解决什么问题

长任务跑了几十轮之后，你想问"前面那个服务的 p99 是多少"。上游压缩后，这类问题的答案往往只剩一句"根据之前的摘要，大约是……"；Hippo 让 Agent 还能拿到原始数字。

| | 上游（只做摘要） | 加了 Hippo |
|---|---|---|
| 压缩后上下文里，20 条早期事实**逐字**还在几条 | 0 | **4–16**（见下表） |
| 压缩后的 token | 基准 | 多付 **1.11–1.20×** |

代价是明摆着的：多的那 11–20% token 不是省出来的，是花钱买的保真。

## 效果

**主结果。** 在**从未参与过任何调参**的 10 个 seed 上重跑（每个 seed 自己和自己的上游版本配对比较），指标是"20 条注入事实里，压缩后上下文里逐字仍在的条数"：

| 场景 | 上游 | Hippo | 胜负 |
|---|---:|---:|---|
| 英文 N=160 | 0 / 20 | **15.9 / 20** | 10 胜 0 平 0 负 |
| 中文 N=160 | 0 / 20 | **8.0 / 20** | 10 胜 0 平 0 负 |
| 英文 N=80 | 0 / 20 | **7.4 / 20** | 10 胜 0 平 0 负 |
| 中文 N=80 | 0 / 20 | **4.0 / 20** | 10 胜 0 平 0 负 |

四个格子全胜（双侧符号检验 p = 0.002）。上游的 0 来自"不生成事实文本的假摘要器"，它是"有损摘要 vs 逐字保留"的结构性对照，**不代表真实摘要模型的能力上限**——真模型的结果见下面两行。

**换真模型（DeepSeek-V4-Flash）之后，优势变成有条件的：**
- 同一个任务跨多次压缩（预算吃紧，1,500 tok）：当前话题答题 **10/16 → 16/16**。
- 中文任务：两轮独立记录里 Hippo 4/4 个格子占优。
- 英文任务：摘要预算宽裕时测不出差异；预算吃紧时才拉开。

**同一个任务跨多次压缩（结构性基准，`corepack pnpm benchmark:long-horizon`）：** 把同一个仍在进行的任务连续压缩 3 轮，每轮拿上一轮的**真实输出**当输入（不是重新模拟），持续注入事实，看压缩后逐字还在几条。80 个 seed 的平均：

| 注入位置 | 上游 | Hippo |
|---|---:|---:|
| 最早的 5 条（第 1 轮之前） | 0.0 | 0.0 |
| 中间的 5 条（第 2 轮之前） | 0.0 | **1.8** |
| 最新的 5 条（第 3 轮之前） | 1.0 | **4.97** |
| 合计 / 15 | 1.0 | **6.8** |

边界同样要一起说：最旧那 5 条两侧最终都几乎剩 0 条（上游 0.00 / Hippo 0.00）。**保留不是记忆**——一个事实跨过几轮压缩之后，再旧也一样会掉，Hippo 没有解决这件事，也不声称解决。

**跨轮次这次新加的一条。** 保留原本是每次压缩从头重算的：第 1 轮被逐字留下的消息，到第 2 轮没有任何优待，会因为问题漂移重新落回摘要桶。现在给「上一次被逐字保留过」的消息划一小块**封顶预算**（保留预算的 25%），让它们在下一轮优先占位。这不是加权——候选的排序完全不变，只是给旧消息留了一小块自己的额度，所以挤不掉当前问题真正需要的消息。80 个 seed 上的配对比较（关 → 开）：中间那批 1.36 → **1.80**（27 胜 / 53 平 / 0 负），合计 6.38 → **6.78**（25 / 54 / 1），最新那批 5.00 → 4.97（80 个 seed 里 2 个各少 1 条）。它**没有**保住最旧那批（0.01 → 0.00）——那本来是这个改动的目标，实测没做到，如实写在这里。`PILOTDECK_CARRYOVER=off` 一行关掉，两个臂可以自己对比。

**会不会把一堆没用的东西也塞回来？** 不会。用引擎自曝的保留列表逐消息统计，保留块里 **89–100%** 是当前问题需要的事实（比随机基线高 2.7–11×）。

> 每一条数字的来源、协议、seed 范围与聚合方式，都在 [docs/evaluation.md](docs/evaluation.md)（[English](docs/evaluation.en.md)），并逐条对应仓库里已提交的 `benchmarks/results/*.json`。上面的结论都在那份文件里能对到具体某一行。
>
> 本文全部数字在 2026-09-12 重测过一次：我们自己统计「事实还在不在」时用了子串匹配，`FACT1` 会命中 `FACT10`–`FACT19`、`FACT2` 会命中 `FACT20`，于是每格虚高最多 2 条。已修（`benchmarks/factPresent.ts`），上表是修正后的读数——旧读数与修正原因一并留在 [§4.10](docs/evaluation.md#410-测量口径修正事实标记的前缀碰撞) 和 `benchmarks/results/superseded-pre-fix/` 里。

## 怎么做的

压缩发生前，对即将被摘要掉的消息逐条打分，按一个**固定上限**的 token 预算挑出最高的几条，把原文和摘要一起放回上下文：

```text
S(m) = 0.85 × sim(q, m)          # 和当前待办问题的相关度（BM25，可选本地 embedding）
     + 0.15 × position_decay(m)  # 越靠近当前越可能有用
     + 0.00 × idf_pagerank(m)    # 实体共现图核心度；默认权重 0，代码和配置项都保留
```

三条设计约束，也是它和"再调一次摘要提示词"的区别：

- **预算硬**：保留块最多花 tail 预算的 20%（下限 256 tokens）。压缩后的上下文不会因为"想多记一点"而失控。
- **输出是原文**：逐字进入上下文，不受摘要模型能力波动影响。
- **失败就让开**：打分出错、模型缺失、embedding 加载超时，一律退回纯上游摘要路径，不阻塞对话。

`scorePolicy` 不传就是纯上游路径，输出逐字节一致（由 golden fixture 守护）；本 fork 的 App 层默认开启，`agent.compaction.retention: off` 一行关回上游。

设计细节、架构图与代码阅读入口：[docs/design.md](docs/design.md)（[English](docs/design.en.md)）。

## 30 秒自己复核

仓库公开可读，不需要任何授权：

```bash
git clone https://github.com/qgeng1465/pilotdeck-hippo && cd pilotdeck-hippo
corepack pnpm install --frozen-lockfile
corepack pnpm benchmark:demo        # 约 2 秒；英文 N=160：上游 0/20 → Hippo 16/20
corepack pnpm benchmark:no-regression   # 关掉保留时必须与上游基线逐字节一致
```

想看图、不想装环境：<https://qgeng1465.github.io/pilotdeck-hippo/> 有实机录屏与完整数字。

## 快速运行

环境：Node.js `22.13+ <23`、Python 3、`make`、C/C++ 编译器、`ripgrep`。

```bash
corepack enable
corepack pnpm install --frozen-lockfile
node scripts/bootstrap-pilotdeck-config.mjs   # 生成 ~/.pilotdeck/pilotdeck.yaml
```

在 `~/.pilotdeck/pilotdeck.yaml` 或 Web UI 里配置模型（真实 API Key 不要写进仓库）：

```yaml
schemaVersion: 1
agent:
  model: custom/<model-id>
  compaction:
    retention: hippo   # 本 fork 默认即 hippo；改成 off 即恢复纯上游压缩
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

只看 Hippo 的话，这些命令就够了：

```bash
corepack pnpm benchmark:no-regression   # 关掉 scorePolicy 时必须等于上游基线
corepack pnpm benchmark:smoke           # 小规模冒烟
corepack pnpm benchmark                 # 完整 A/B（N=40/80/160）
corepack pnpm benchmark:extraction      # 逐消息精确率 / 召回率
corepack pnpm benchmark:long-horizon    # 同一个任务连续压缩 3 轮（长程）
corepack pnpm benchmark:tokenizer       # 分词器两实现的时间对比
```

真 LLM 评测需要联网，端点解析顺序：① 环境变量 `PILOTDECK_EVAL_URL` + `PILOTDECK_EVAL_KEY` → ② 仓库根 `poliet_deck.txt`（可选的自备网关，密钥不入库）→ ③ `~/deepseek_key.txt`。

```bash
corepack pnpm benchmark:real-llm                # 单话题闭环
corepack pnpm benchmark:real-llm-topic-switch   # 同一个任务跨多次压缩
```

桌面应用等其它安装方式见[附录 A](#附录a上游-pilotdeck-项目)。

## 已知限制

- **收益是"对当前任务保真"，不是"记住被放弃的旧话题"。** 旧话题那一列的优势经诊断是测试脚本句式共享造成的假象，换成不相关的措辞后就归零了。对外不该说"Hippo 保住了旧话题"。
- **换成真摘要器后，优势是有条件的。** 摘要预算宽裕时测不出差异（同配置重复跑的摆动就有 3–4 题），预算吃紧时才拉得开。
- **默认权重换过，但不当成"优化带来的提升"。** 改权重是因为它对齐了当时的调参结果且少一项；重测修正后留出集上 rank 项的影响远小于噪声（5 胜 35 平 0 负，无显著），且修正后的调参网格也不再支持"当前默认居首"（详见 [§4.2](docs/evaluation.md#42-组件消融)）。默认值这次**没有**跟着改——证据不支持收益，而改动要重测整条流水线。真正的主效应是"逐字保留 vs 不做保留"。
- **评测主要是合成对话**，事实集中在前面、问题在尾部。真实任务的时间特征、噪声和多轮提问可能改变最优权重。
- **真 LLM 部分样本小**（每格 16 题、2 个 seed），而且摘要器和评审员是同一个模型，所以只声明方向，不宣称"提升了 X 个点"。
- **Hippo 会增加压缩后 token**（真 LLM 记录约 +5–24%）。展示时准确率和成本要一起给。

## 顺带修掉的四个上游缺陷

这四处和 Hippo 本身无关，但都是真实用户会撞到的既有问题，所以一并修了，每处都配了"修复前必然失败"的测试：

1. **三处被 `unref()` 掉的超时定时器**：它们本该 settle 一个被 `await` 的 promise，`unref()` 之后调用方拿到的是永不返回的 promise，而不是超时错误。影响 `fetch.ts`（所有模型/MCP 网络调用的底座）、后台任务的 `wait()`、流式响应的空闲超时。
2. **分词器在长重复串上退化成 O(n²)**：`countTokens` 换成同一套贪心合并的堆实现后，8,000 字符 8,999 ms → 9.1 ms（993×），`read_file` 读一个 300 行的工具结果 79.2 s → 1.2 s。等价性由 906 次比对验证，0 失配。
3. **启动恢复的"最新事务"排序键混了逻辑时间和文件 mtime**：本机 mtime 粒度是 1 ms，两个事务落在同一毫秒就并列，恢复会挑错事务——这正是那条偶发失败的测试用例的真身。改成由事务自己的时间戳决定后，偶发变成确定性断言。
4. **摘要失败时，压缩边界标记会作为一条 user 消息被喂给下一次摘要器**：边界标记靠"紧跟其后的摘要"配对，而摘要失败时后面什么都没有，于是标记被留在 live 消息里——摘要器被要求读"用户刚问的是什么"，读到一个 `<compact-boundary/>`；若尾部恰好覆盖它，还会每轮逐字复读。标记本身不含内容，丢掉零损失。

完整证据与复现命令：[docs/upstream-fixes.md](docs/upstream-fixes.md)（[English](docs/upstream-fixes.en.md)）。

## 仓库与来源

- 上游基线：[OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck) `85be774`，fork 起点逐字节可比对（见 `NOTICE`）。
- 本 fork 的改动集中在 `src/context/compaction/`（保留策略与接入）、`benchmarks/`（评测脚本）、`tests/context/`（专项测试）三处。
- 仓库公开始终可读，无需授权即可 clone 复核；所有对外数字都来自仓库里已提交的 `benchmarks/results/*.json`，没有第三方评审。
- 测试与类型检查现状：根套件 `pnpm test` 529 项 / 527 通过 / 0 失败（2 项 skip）；UI 侧 `npx vitest run` 118 个文件 / 922 个用例 / 0 失败；`ui` 的 `tsc --noEmit` 退出码 0。

## 许可证与致谢

AGPL-3.0（继承上游）。上游 PilotDeck 的版权声明与许可证见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

## 附录A：上游 PilotDeck 项目

本项目是 [OpenBMB/PilotDeck](https://github.com/OpenBMB/PilotDeck) 的 fork。PilotDeck 是一个开源的本地 AI Agent 工作台，支持自定义模型端点、工具调用、MCP、长任务与 Web/桌面两种界面；Hippo 只改动了它的上下文压缩路径，其余功能与上游一致。上游的安装说明、功能文档与版本历史请见上游仓库。
