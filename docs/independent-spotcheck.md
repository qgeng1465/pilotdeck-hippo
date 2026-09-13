# 抽检记录：在从未使用过的新 seed 上复核旗舰结论

> **这是什么、不是什么（先说清楚）**：这是一次**我方自跑的、可复现的抽检**，不是第三方独立评审。
> 它回答的唯一问题是：README 里的旗舰数字，**换一批从没参与过任何调参、也没在任何已提交 JSON 里出现过的 seed，还在不在**（§1 事实保留）。§2 的提取精度在修复后改到默认留出基上重测，不再算「换 seed」，原因见该节说明。
> 复核脚本已在仓库里（`benchmarks/holdout.ts`、`benchmarks/extractionPrecision.ts`，均支持 seed base 覆盖），任何人都能一条命令重跑。
> 我们把它附在这里，是因为「换 seed 还成不成立」是「这些数字是不是挑出来的」最直接的证伪方式。

- 原始 JSON：[`benchmarks/results/spotcheck-seeds20261001-2026-09-12.json`](../benchmarks/results/spotcheck-seeds20261001-2026-09-12.json)（2026-09-12 事实标记前缀碰撞修复后重测，见 [评测记录 §4.10](./evaluation.md#410-测量口径修正事实标记的前缀碰撞)）、[`benchmarks/results/extraction-precision-2026-09-12.json`](../benchmarks/results/extraction-precision-2026-09-12.json)（修复后重测；两份旧文件已移入 `benchmarks/results/superseded-pre-fix/`）
- 已用过的 seed：`tune.ts` 用 20260911–13、`ablation.ts` 用 20260911–20、旗舰 holdout 用 20260921–30。
- **本次抽检 seed**：holdout 用 **20261001–20261010**，与上面全部不相交。精度一节（§2）用的是 `benchmark:extraction` 的默认留出基 **20260921–23**——该指标对 seed 弱敏感（§2 的说明），所以这一节不是"换 seed"复核，只用来确认修复后逐格未变。

---

## 1. 事实保留：新 seed 复核（`benchmarks/holdout.ts`）

同样的「shipped default vs upstream（无保留）」，换成 seed 20261001–20261010（n=10，每 seed 自成对照）：

| 场景 | 旗舰（20260921–30） | **本次抽检（20261001–10）** | 抽检 W/T/L | 符号检验 p |
|---|---:|---:|---:|---:|
| 英文 N=80 | 7.4 | **7.2** | 10 / 0 / 0 | 0.002 |
| 英文 N=160 | 15.9 | **16.0** | 10 / 0 / 0 | 0.002 |
| 中文 N=80 | 4.0 | **4.0** | 10 / 0 / 0 | 0.002 |
| 中文 N=160 | 8.0 | **8.0** | 10 / 0 / 0 | 0.002 |

（上游四格在新 seed 上仍全部为 0——「无保留 ⇒ 逐字事实 0 条」是结构性对照，与 seed 无关。两列都取自 2026-09-12 修复后重测的 JSON；修复让两列各格同时降 2.0，配对计数与 p 值不受影响。）

**结论**：四格均值与旗舰**同向、差值 ≤0.2**，且**每一格都是 10 胜 0 平 0 负**。数字会随 seed 小幅抖动（7.4→7.2、15.9→16.0），说明这不是一个被钉死的常数；但方向与显著性完全复现。

> 口径提醒（与 README 一致）：该指标是**假摘要器下的「逐字保留召回代理」**，不是回答正确率。上游的 0 来自假摘要器不吐 FACT 文本的结构性设计，不代表真实摘要能力的上限——真实 QA 对照见 [评测记录 §4.3](./evaluation.md#43-真-llm-闭环两轮记录含敏感性)。

## 2. 提取精度：修复后重测（`benchmarks/extractionPrecision.ts`）

在 `benchmark:extraction` 的默认留出基 **20260921–23**（3 seeds）上重测，逐消息精度表：

| 场景 | 精度 | 召回（中位） | 相对随机基线 |
|---|---:|---:|---:|
| en N=40 | 100.0% | 30.0% | 2.8× |
| en N=80 | 100.0% | 35.0% | 5.7× |
| en N=160 | 100.0% | 80.0% | 11.1× |
| zh N=40 | 100.0% | 20.0% | 2.7× |
| zh N=80 | 100.0% | 20.0% | 5.6× |
| zh N=160 | 88.9% | 40.0% | 10.0× |

**结论**：六格 precision ∈ [88.9%, 100%]、lift ∈ [2.7×, 11.1×]，与旗舰（89–100%、2.7–11.1×）逐格一致。唯一的变动是 en N=160 的 lift 末位 11.0× → 11.1×，来自随机基线 0.091 → 0.090，与召回、精度无关。

**诚实说明**：这张表在修复前后**逐格同值**（唯 en N=160 的 lift 末位差 0.1），不是巧合也不是我们抹平了差异——该指标在**合成转录的固定事实布点**上有很强的结构性、对 seed 弱敏感。所以这一节证明的是**可复现性/确定性**，**不是**「精度对 seed 稳健」这种更强的说法。真正对 seed 敏感、因此更有说服力的复现，是上一节的 holdout。

## 3. 对账表：旗舰数字 → 具体 committed JSON 的哪一行

要问「15.9 和 89–100% 到底存在哪」，照这张表点开即可：

| 数字 | 文件 | 字段 |
|---|---|---|
| 事实保留 15.9 / 20（en160，10 seeds，p=0.002） | `benchmarks/results/holdout-2026-09-12.json` | `rows[]` 中 `variant="shipped default"`、`lang="en"`、`numPairs=160` 的 `mean`；配对行在 `comparisons[]`（`a="shipped default"`、`b="upstream (no retention)"`、`winsA=10,winsB=0,signTestP=0.002`） |
| 中文 8.0 / 20、en80 7.4、zh80 4.0 | 同一文件 | 同上，改 `lang`/`numPairs` |
| 精度 89–100%、2.7–11.1× | `benchmarks/results/extraction-precision-2026-09-12.json` | 每行 `precisionMedian`、`liftOverChance`；召回 `recallMedian` |

复现命令（数字应与上表逐格一致）：

```bash
pnpm benchmark:holdout        # 默认 seed 20260921–30，写入 benchmarks/results/holdout-*.json
pnpm benchmark:extraction     # 默认 seed base 20260921
```

## 4. 你可以自己换 seed 复核

两个脚本都加了 seed base 覆盖（默认值不变），换成**任何**你喜欢的新 seed 都行：

```bash
PILOTDECK_HOLDOUT_SEED_BASE=20270101 pnpm benchmark:holdout
PILOTDECK_EVAL_SEED_BASE=20270101 PILOTDECK_EVAL_SEEDS=5 pnpm benchmark:extraction
```

（脚本自带守卫：holdout seed 必须晚于 `20260920`，防止误把见过 seed 混回留出集。）

## 5. 本记录**不**宣称的

- **不是第三方评审**，是作者自跑；只看「换 seed 还成不成立」，不替代真实 QA 评估。
- 仍是**合成、模板化事实**（假摘要器），离真实长对话噪声与主题漂移仍有距离。
- §2 的同值**不等于**精度对 seed 稳健（见该节说明）。
- 真 LLM 闭环的已知偏差（judge 与摘要器同模型、每格 16 题 × 2 seeds）**未被本抽检消除**，照 [评测记录 §4.3](./evaluation.md#43-真-llm-闭环两轮记录含敏感性) 如实保留。
