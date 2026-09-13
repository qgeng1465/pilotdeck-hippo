# 上游缺陷修复记录

本文是 [README](../README.md) 的参考细节，收录主 README「顺带修掉的四个上游缺陷」一节的完整记录：四处上游既有缺陷各自的站点清单、症状表、复现与修复证据。这些修复都不计入 Hippo 创新点，正文只保留一句摘要与指针。English: [upstream-fixes.en.md](./upstream-fixes.en.md)

## 顺带修掉的四个上游缺陷

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
  - `fetch.ts`：修复前 `tests/network/fetch.spec.ts` 7 项全部 cancelled → 修复后 7/7；
  - `BackgroundTaskRuntime`：`tests/task/background-task-runtime.spec.ts` 修复前 5/6（第 6 项 "covers timeout, abort, unknown task and kill-all cleanup" 里的超时用例，仅 10 ms 就放弃）→ 修复后 6/6；
  - `streamModel`：新增 `tests/model/streaming/idle-timeout.spec.ts` 6 项；把 `unref()` 加回去重跑，**6 项全部 cancelled**，加回修复后 6/6。
- 影响面：`fetch.ts` 是所有模型 provider / MCP 网络调用的底座；另两处分别是后台任务与流式响应。

**缺陷二：分词器在长重复串上退化为 O(n²)（`src/context/budget/tokenizer.ts`）**

这个是被测试**逼出来**的：`tests/tool/read-file-large.spec.ts` 第 4 项稳定 60 秒超时。它不是环境问题，是真实的性能缺陷——用 CPU profile 抓到 96% 的时间花在 `js-tiktoken` 的 `bytePairMerge` 上，而不是文件 IO：

| 输入（单个重复字符） | js-tiktoken 原实现 | `countTokensFast` | 加速 |
|---:|---:|---:|---:|
| 500 字符 | 60 ms | 3.5 ms | 17× |
| 1,000 字符 | 133 ms | 4.8 ms | 28× |
| 2,000 字符 | 533 ms | 2.6 ms | 209× |
| 4,000 字符 | 2,177 ms | 9.5 ms | 230× |
| 8,000 字符 | 8,999 ms | 9.1 ms | 993× |

原实现每次翻倍涨 **2.2 / 4.0 / 4.1 / 4.1×**——**二次退化**（右列只有 2–10 ms 量级，单次采样噪声明显，只看原实现的增长趋势）。原因是它的合并循环每轮重扫全部候选对、却只合并一对，而 BPE 会把「一整段重复字符」当成**单个** pre-token，于是这正是最坏输入。Python / Rust 版 tiktoken 用堆实现，没有这个问题。

本表由 `pnpm benchmark:tokenizer` 即时生成（结果 JSON：`benchmarks/results/tokenizer-scaling-2026-09-11T13-06-44-566Z.json`）；脚本在计时前先断言两实现在每个长度上取值一致，不一致就拒绝出表，避免拿两个不同的函数比时间。

症状落到用户身上是：`read_file` 读一个 300 行的持久化工具结果要 **79 秒**——足以让任何一个工具调用超时。

- 修复：在 `countTokens` 这一处咽喉换成同一套贪心合并的**堆实现**（取当前相邻对中 rank 最小者，同 rank 取最左——与库的选择规则逐条一致）。合并选择规则相同，结果就相同。
- 证据（同一 fixture）：
  - **可复现的那条**：`pnpm benchmark:tokenizer`（上表）给出逐步加速，且脚本自带两实现一致性断言；
  - 端到端 `read_file`：**79,238 ms → 1,214 ms**（65×）——这是修复当次的单次实测，**未落库**；要重测需把 `countTokens` 换回库原实现（该 path 已不存在于当前代码），所以此处只作为量级参考；
  - 该测试文件：修复前第 4 项挂死、整文件 60 s 超时 3/3 失败 → 修复后 **11/11 通过**（`pnpm test` 里每次都在跑，是这条缺陷的持续回归门）；
  - 等价性：`tests/context/tokenizer-equivalence.spec.ts` 用 **900 例随机输入 + 6 例固定边界（合计 906 次比对）**比对堆实现与库原实现（单字符重复串 70、重复单元 30、10 种字母表随机文本 600、混合文本 200；固定边界含 CJK、emoji、空串、特殊 token 拒绝路径），**0 失配**。
- 影响面：`countTokens` 是所有预算判断的公共底座（`read_file` 文本预算、工具结果预算、micro-compaction、以及 Hippo 自己的 `estimateMessagesTokens`），一处修复全线受益。

**缺陷三："最新事务"的排序键混了逻辑时间与文件 mtime（`src/web/server/replaceLastTurn.ts`）**

启动恢复要判断"哪个替换事务是最新的"，它写的是：

```ts
order: Math.max(preparedAt, backupMtime, journalMtime)   // 修复前
```

`preparedAt` 是事务自己的逻辑时间戳，而两个 mtime 是**文件系统的墙上时钟**。取 `max` 让 mtime 在任何真实场景下都盖过 `preparedAt`，排序实际退化成"哪个文件最后被写"。

而本机文件系统 mtime 粒度是 **1 ms**——实测连续三次写入拿到完全相同的 `mtimeMs`（`...426.997`）。两个事务落在同一毫秒就**并列**，并列则由 `readdirSync` 的返回顺序决定，而那个顺序是任意的。于是恢复会挑中错误的事务：该回滚的报告成已提交。

这正是全量测试里那个偶发失败的真身——`replace-last-turn.spec.ts` 的 "startup recovery decides from the newest replacement transaction only" 断言 `rolledBack` 期望 1 实得 0；该用例单独连跑 5 次均通过（本机实测，未落库），只有在满载并发下才偶发，所以一直被当成"计时抖动"。

- 修复：`preparedAt` 可解析时**由它单独决定**，mtime 只在 journal 缺失/不可解析时兜底：
  ```ts
  order: Number.isFinite(preparedAt)
    ? preparedAt
    : Math.max(backupMtime ?? 0, journalMtime ?? 0)
  ```
- 证据：新增 `recovery orders transactions by their journal timestamp, not by artifact mtime`——用 `utimes` 把旧事务的文件 mtime 显式推到未来 60 秒（不依赖任何时序），断言恢复仍按 `preparedAt` 选中新事务。把 `Math.max` 改回去重跑，该用例**确定性失败**（1 fail）；修复后 16/16。这样把一个偶发 flake 变成了每次必检的确定性断言。

**缺陷四：摘要失败留下的「孤儿压缩边界」会被当成用户发言重新喂回（`CompactionEngine.splitCheckpointPrefix`）**

上游用「边界标记 + 紧随其后的摘要」这一对来切分历史，配对靠**位置**：只要 `messages[i]` 是边界标记、`messages[i+1]` 是摘要包装消息，就算一对。问题出在**摘要失败**的时候——`createBoundaryMarker` 这时写的是 `status="summary_failed"`，后面**没有**摘要消息，于是循环在第一个配不上的边界处停下，把它留在了 `liveMessages` 里。

两个后果，都实测到：

| 后果 | 现象 |
|---|---|
| 被喂给下一次摘要器 | `summarize()` 的 `messages` 数组里多了一条 user 角色的 `<compact-boundary .../>`。摘要器被要求读「用户刚刚问的是什么」，读到的是一个标记；本次修复的回归用例就是断言"孤儿边界不得作为对话内容呈现给摘要器" |
| 永久复读 | 若保留的 tail 恰好覆盖到它，它会每轮都被逐字带回、永远留在上下文里 |

边界标记本身不携带内容——只有 trigger 与 token 计数，而这两项已经通过 `CompactionResult` 和诊断信息报出——所以**丢掉它不会丢任何模型可用的信息**。

- 修复：循环改为「配成对就消费这一对，配不上就丢掉这一条孤儿」，`stablePrefix` 只由成对的部分构成（与旧的 `messages.slice(0, index)` 在成对情形下等价）。
- 证据：`tests/context/compaction-engine.spec.ts` 新增 `an orphan compact boundary is dropped instead of being re-fed as a user turn`。把修复回退后重跑，`not ok 5`，失败行正是 `the orphan boundary must not be presented to the summarizer as conversation`（18/19）；修复后 19/19。
- 同时做的加固：边界标记现在带 `metadata.synthetic: true`（含 `purpose`）。**如实说明**：这条不是 bug 修复——《toolPairIntegrity.ts` 的 `INTERNAL_USER_TEXT_PREFIXES` 里本来就有 `<compact-boundary` / `<snip-boundary`，`isSyntheticPseudoMessage` 早已能识别它们，我们**构造不出**可复现的错误行为。加这个字段是为了让契约变成结构性的，而不是依赖对文本前缀的再解析，防的是将来的新消费者。它配的测试在加字段前会失败，但那验证的是新契约存在，不是旧行为有错。
