# PilotDeck-Hippo 演示与自证脚本

> 3–5 分钟亲手复核的路径。`demo` 不含任何上报/网络依赖（打分全程本地）；只有真 LLM 评测需要联网，本流程里不跑。

两个入口，按时间分配：

- **入口 A · CLI 大屏 A/B 对比**（约 30 秒）——一条命令，直观看到"保留块把 20 条事实里 16 条逐字捞了回来"。
- **入口 B · Web UI 真实压缩 + 分隔线徽章**（2–3 分钟）——压缩真实发生时，压缩分隔线上冒出一个绿色徽章。**这一眼最值得看**。

## 入口 A：`pnpm benchmark:demo`

```bash
cd <仓库根目录>
pnpm benchmark:demo
```

实测约 2 秒，输出（seed=20260911，EN N=160）：

```
upstream postTokens: 4683   facts=0/20
hippo    postTokens: 5283   facts=16/20
[KEEP] FACT5: BAP1 DESeq2 TCGA-LIHC n=371 freq=0.800 stat=2.54
...（16 条 KEEP + 4 条 FOLD，被折进摘要的正是最旧的 FACT1–FACT4）
```

三句话讲清楚：

1. 上游把前文整体压成一段摘要，**精确事实 0 条**回到上下文。
2. Hippo 多付约 1.13× token，换来 **16/20 条逐字保留**。
3. 这一行是"逐字保留可用"的召回代理，不是回答正确率——真 LLM 下的回答准确率口径见[评测记录 §4.3](./evaluation.md#43-真-llm-闭环两轮记录含敏感性)（中文、摘要预算吃紧时优势稳定）。

## 入口 B：Web UI 真实压缩 + 徽章

1. 启动（未起时）：`cd ui && npm run start`，浏览器打开 `http://localhost:3001`（若被占用会自动滑动端口，看启动日志里的 `[dev-launcher]` 打印）。
2. 选一个已配置的模型（用你自己已配置好的任意模型），新建一个长对话，把上下文谈到接近预算上限。
3. 触发 Compaction（自动触发，或输入框手动触发）。**压缩分隔线上应出现徽章**，形如：
   `Hippo 逐字保留 3 条（1,204 tok）`，悬停显示策略与本次预算。
4. 用早先的问题复问，确认 Agent 能逐字答出（例如"TP53 的突变频率是多少"）。

徽章的渲染逻辑有自动化测试守护（`ui/src/components/chat/view/subcomponents/MessageComponent.retention-badge.test.tsx`，含变异验证），但测试是 jsdom、测不了真实 CSS 与暗色模式——**要看的正是这一眼，别只信测试**。演示前自己跑通一次。

**徽章没出现时的降级**：不临时 debug，直接切到入口 A 讲 `benchmark:demo`。

## 备选：想自己看数据是怎么来的

| 命令 | 耗时 | 何时用 |
|---|---|---|
| `pnpm benchmark:demo` | ~2 s | 主演示 |
| `pnpm benchmark:holdout` | ~109 s | 留出集配对检验（主表来源）。**别干等**：先讲机制，跑完再指表。所有指标逐位重现 |
| `pnpm benchmark:topic-switch` | ~4 s | 话题切换（旧话题列是 harness 假象，见[评测记录 §4.6](./evaluation.md#46-话题切换旧话题还剩多少回答中途换话题)） |
| `pnpm benchmark:extraction` | ~1 s | "怎么保证提取得准"→ 逐消息精/召回，89–100%、2.7–11× |
| `pnpm benchmark:ablation` | ~64 s | 消融原始输出 |
| `pnpm benchmark:no-regression` | CI | 不启用 scorePolicy 时与上游逐字节一致 |

代价口径先说清：Hippo 的 token 是**多付**的（结构基准约 1.11–1.20×），换回的是逐字保留——不要讲成"更省"。

## 端侧 / 断网说明

打分（BM25 / 实体图）全部本地，`demo` 不需要外网；本地 BGE embedding 不占云端额度（设 `PILOTDECK_BGE_MODEL=Xenova/bge-small-zh-v1.5`）。只有真 LLM 评测（`benchmark:real-llm` / `benchmark:real-llm-topic-switch`）需要联网与 API，本流程只引用其已落库的结论，不现跑。

## 录屏（可选）

录屏不是必做项；真机目检徽章比录屏更重要。若要做，录两段、每段 15–20 秒即可：

1. **CLI A/B 表**：录 `pnpm benchmark:demo` 的终端，重点停在"upstream 0/20 → hippo 16/20"那两行。
2. **Web UI 分隔线徽章**：录浏览器窗口，跑长对话触发压缩，等压缩分隔线上的绿色徽章（`逐字保留 N 条（X tok）`，悬停出策略/预算）出现，放大到那条分隔线，然后用原问题复问一次。

在有显示器、有录屏软件的机器上用 OBS 区选捕获剪辑即可，无 OBS 也可用系统自带的录屏。

无显示器的机器若也要出"真·浏览器里徽章"的静态图，可用 Playwright headless（本仓 `ui/` 已带 Playwright 依赖）：`npx playwright install chromium` 之后，起 UI 用其截图徽章渲染。这只能证明真实 CSS/暗色模式下的徽章长这样（正是 jsdom 测不到的那一面），不能替代跑通一次真实对话——**真机目检仍然必做**。