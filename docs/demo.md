# PilotDeck-Hippo 现场 Demo 脚本

> 给评委的 3–5 分钟复现路径。`demo` 不含任何上报/网络依赖（打分全程本地）；只有真 LLM 评测需要联网，现场不跑。

两个入口，按时间分配：

- **入口 A · CLI 大屏 A/B 对比**（约 30 秒）——一条命令，直观看到"保留块把 20 条事实里 18 条逐字捞了回来"。
- **入口 B · Web UI 真实压缩 + 分隔线徽章**（2–3 分钟）——评委亲眼看到压缩发生时，压缩分隔线上冒出一个绿色徽章。**这是台上最该展示的一眼**。

## 入口 A：`pnpm benchmark:demo`

```bash
cd <仓库根目录>
pnpm benchmark:demo
```

实测约 2 秒，输出（seed=20260911，EN N=160）：

```
upstream postTokens: 4683   facts=0/20
hippo    postTokens: 5283   facts=18/20
[KEEP] FACT1: KRAS Concordance TCGA-LIHC n=371 freq=0.540 stat=0.46
...（18 条 KEEP + 2 条 FOLD）
```

对评委的三句话：

1. 上游把前文整体压成一段摘要，**精确事实 0 条**回到上下文。
2. Hippo 多付约 1.13× token，换来 **18/20 条逐字保留**。
3. 这一行是"逐字保留可用"的召回代理，不是回答正确率——真 LLM 下的回答准确率口径见 README §4.3（中文、摘要预算吃紧时优势稳定）。

## 入口 B：Web UI 真实压缩 + 徽章

1. 启动（未起时）：`cd ui && npm run start`，浏览器打开 `http://localhost:3001`（若被占用会自动滑动端口，看启动日志里的 `[dev-launcher]` 打印）。
2. 选一个已配置的模型（见 README 附录 B 配置 token），新建一个长对话，把上下文谈到接近预算上限。
3. 触发 Compaction（自动触发，或输入框手动触发）。**压缩分隔线上应出现徽章**，形如：
   `Hippo 逐字保留 3 条（1,204 tok）`，悬停显示策略与本次预算。
4. 用早先的问题复问，确认 Agent 能逐字答出（例如"TP53 的突变频率是多少"）。

徽章的渲染逻辑有自动化测试守护（`ui/src/components/chat/view/subcomponents/MessageComponent.retention-badge.test.tsx`，含变异验证），但测试是 jsdom、测不了真实 CSS 与暗色模式——**台上要展示的正是这一眼，别只信测试**。演示前自己跑通一次。

**徽章没出现时的降级**：不现场 debug，直接切到入口 A 讲 `benchmark:demo`。

## 备选：评委要看数据怎么来的

| 命令 | 耗时 | 何时用 |
|---|---|---|
| `pnpm benchmark:demo` | ~2 s | 主演示 |
| `pnpm benchmark:holdout` | ~109 s | 留出集配对检验（主表来源）。**别让评委干等**：先讲机制，跑完再指表。所有指标逐位重现 |
| `pnpm benchmark:topic-switch` | ~4 s | 话题切换（旧话题列是 harness 假象，见 README §4.6） |
| `pnpm benchmark:extraction` | ~1 s | "怎么保证提取得准"→ 逐消息精/召回，88–100%、2.7–11× |
| `pnpm benchmark:ablation` | ~64 s | 消融原始输出 |
| `pnpm benchmark:no-regression` | CI | 不启用 scorePolicy 时与上游逐字节一致 |

代价口径先说清：Hippo 的 token 是**多付**的（结构基准约 1.11–1.20×），换回的是逐字保留——不要讲成"更省"。

## 端侧 / 断网说明

打分（BM25 / 实体图）全部本地，`demo` 不需要外网；端侧 100 元额度足够本地 BGE embedding（设 `PILOTDECK_BGE_MODEL=Xenova/bge-small-zh-v1.5`）。只有真 LLM 评测（`benchmark:real-llm` / `benchmark:real-llm-topic-switch`）需要联网与 API，现场只引用其落库结论、不现场跑。