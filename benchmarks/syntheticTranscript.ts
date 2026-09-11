import type { CanonicalMessage } from "../src/model/index.js";

export type SyntheticFact = {
  id: string;
  marker: string;
  text: string;
};

export type SyntheticTranscript = {
  messages: CanonicalMessage[];
  facts: SyntheticFact[];
  seed: number;
  numPairs: number;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENES = [
  "TP53", "CTNNB1", "TERT", "ARID1A", "RB1", "KRAS", "NRAS", "PIK3CA",
  "ALB", "APOB", "AXIN1", "BAP1",
];

const METHODS = [
  "Wasserstein", "TransDANN", "CoxPH", "KM", "LOOCV", "Concordance",
  "PCA", "UMAP", "DESeq2", "EdgeR",
];

const USER_NOISE = [
  "Inspect the intermediate QC table and reconcile sample annotations before the next stage.",
  "Run the expression normalization step and write the result into the batch queue.",
  "Check whether the clinical covariates are aligned with the mutation matrix row order.",
  "Recompute the survival fold split and store the fold file under the staging directory.",
  "Verify the manifest checksums and report any mismatch before model training.",
  "Inspect the cluster assignment drift between the source and target cohorts.",
  "Trim low-confidence records and rerun the phenotype summary for the clinical table.",
  "Refresh the cached mutation counts after the latest genotype call update.",
];

const ASSISTANT_NOISE = [
  "QC table read; 3 anomalies logged, matched pairs resolved, manifest checksum OK.",
  "Normalization completed and written; column order preserved, 2 warnings ignored.",
  "Clinical covariate order matches matrix rows; no remap required.",
  "Fold split written; seed fixed, class balance verified across all folds.",
  "Manifest checksums verified; staging artifact updated to latest revision.",
  "Cluster drift detected in 1 subgroup; source/target distance recorded for review.",
  "Low-confidence records removed; phenotype summary regenerated with stable counts.",
  "Mutation counts refreshed; index table rebuilt and cache invalidated.",
];

const NOISE_SUFFIX = [
  "expected_value=0.87 p_value=0.021 fold=3 reference_path=/staging/artifacts/survival/latest.tsv",
  "residuals=0.33 sample_count=184 batch_version=9 mutation_matrix=refs/heads/feature/cohort",
  "conditioner=0.74 pseudocount=2 cohort_lookup=/raw/clinical/samples.csv",
  "kernel_bandwidth=1.25 split_signature=sha256-9f3c source=target_distribution_note",
  "learning_rate=0.0003 optimizer=adam epochs=50 seed=7 checkpoint=/staging/checkpoints/fold-2.pt",
  "calibration_score=0.91 rank_correlation=0.44 phenotype_table=/raw/clinical/pheno-2026.tsv",
  "imputation_iterations=12 qc_threshold=0.8 gdc_manifest=/staging/manifests/manifest-latest.tsv",
  "covariate_shift=0.12 batch_effect=0.05 umap_components=2 pca_variance=0.67",
];

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function pairIndexForFact(index: number, count: number, numPairs: number): number {
  const prefixSpan = Math.max(1, Math.floor(numPairs * 0.75));
  return Math.floor((prefixSpan * index) / Math.max(1, count));
}

function factFor(index: number, random: () => number): SyntheticFact {
  const gene = pick(random, GENES);
  const method = pick(random, METHODS);
  const frequency = (Math.floor(random() * 90) + 5) / 100;
  const stat = Math.round((random() * 3.5 + 0.1) * 100) / 100;
  const cohort = "TCGA-LIHC";
  const n = 371;
  const marker = `FACT${index}`;
  const text = `${marker}: ${gene} ${method} ${cohort} n=${n} freq=${frequency.toFixed(3)} stat=${stat.toFixed(2)}`;
  return { id: String(index), marker, text };
}

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

export function generateTranscript(options: {
  numPairs: number;
  seed: number;
  factsCount?: number;
}): SyntheticTranscript {
  const random = mulberry32(options.seed);
  const numPairs = options.numPairs;
  const factsCount = Math.min(options.factsCount ?? 20, numPairs);
  const messages: CanonicalMessage[] = [];
  const facts: SyntheticFact[] = [];

  for (let index = 0; index < numPairs; index += 1) {
    const factIndex = facts.length;
    const shouldInject = index === pairIndexForFact(factIndex, factsCount, numPairs) && facts.length < factsCount;
    let userText: string;
    if (shouldInject) {
      const fact = factFor(factIndex + 1, random);
      userText = `${fact.text} Record this exact value as a checkpoint.`;
      facts.push(fact);
    } else {
      userText = `${pick(random, USER_NOISE)} Step ${index + 1}: sample batch row=${random() < 0.5 ? 1 : 2} block=${Math.floor(random() * 8) + 1} gene=${pick(random, GENES)} metric=${Math.round(random() * 9000 + 1000)} ${pick(random, NOISE_SUFFIX)}`;
    }
    messages.push(textMessage("user", userText));
    messages.push(textMessage("assistant", `${pick(random, ASSISTANT_NOISE)} reply=${Math.floor(random() * 100000)} ${pick(random, NOISE_SUFFIX)}`));
  }

  messages.push(textMessage(
    "user",
    "Answer the TCGA-LIHC n/frequency/statistic questions from exact FACT values stored in the conversation.",
  ));

  return { messages, facts, seed: options.seed, numPairs };
}

const ZH_USER_NOISE = [
  "请先检查中间质控表，把样本注释和批次信息核对一遍再进入下一阶段。",
  "运行表达归一化步骤，把结果写入待处理队列，注意保持列顺序一致。",
  "确认临床协变量和突变矩阵的行顺序是对齐的，如有偏移需要重映射。",
  "重新计算生存分析的折拆分，固定随机种子后把折文件写入暂存目录。",
  "核对清单校验和，若有不一致的地方在模型训练前上报。",
  "观察源队列和目标队列之间的聚类漂移，把距离指标记录下来供评审。",
  "裁剪低置信度记录，重新生成临床表的表型汇总，保持计数稳定。",
  "基因型调用更新后刷新缓存的突变计数，并重建索引表使缓存失效。",
];

const ZH_ASSISTANT_NOISE = [
  "质控表已读取，记录了 3 处异常，配对样本已解析，清单校验和正常。",
  "归一化已完成并写入，列顺序保持不变，忽略了 2 条警告。",
  "临床协变量顺序与矩阵行一致，无需重映射，可以进入下一阶段。",
  "折拆分已写入，随机种子固定，所有折的类别平衡均已验证。",
  "清单校验和验证通过，暂存产物已更新到最新修订版本。",
  "在 1 个亚群中检测到聚类漂移，源目标距离已记录待复核。",
  "低置信度记录已剔除，表型汇总已重新生成，计数保持稳定。",
  "突变计数已刷新，索引表已重建，缓存已失效处理。",
];

function zhFactFor(index: number, random: () => number): SyntheticFact {
  const gene = pick(random, GENES);
  const method = pick(random, METHODS);
  const frequency = (Math.floor(random() * 90) + 5) / 100;
  const stat = Math.round((random() * 3.5 + 0.1) * 100) / 100;
  const marker = `FACT${index}`;
  const text = `${marker}: 在 TCGA-LIHC 肝癌队列 n=371 中，${gene} 的突变频率为 ${frequency.toFixed(3)}，${method} 统计量为 ${stat.toFixed(2)}。`;
  return { id: String(index), marker, text };
}

export function generateZhTranscript(options: {
  numPairs: number;
  seed: number;
  factsCount?: number;
}): SyntheticTranscript {
  const random = mulberry32(options.seed);
  const numPairs = options.numPairs;
  const factsCount = Math.min(options.factsCount ?? 20, numPairs);
  const messages: CanonicalMessage[] = [];
  const facts: SyntheticFact[] = [];

  for (let index = 0; index < numPairs; index += 1) {
    const factIndex = facts.length;
    const shouldInject = index === pairIndexForFact(factIndex, factsCount, numPairs) && facts.length < factsCount;
    let userText: string;
    if (shouldInject) {
      const fact = zhFactFor(factIndex + 1, random);
      userText = `${fact.text}请把这个精确数值作为检查点记住。`;
      facts.push(fact);
    } else {
      userText = `${pick(random, ZH_USER_NOISE)}第 ${index + 1} 步：样本批次 row=${random() < 0.5 ? 1 : 2} block=${Math.floor(random() * 8) + 1}，重点基因=${pick(random, GENES)}，指标值=${Math.round(random() * 9000 + 1000)}。`;
    }
    messages.push(textMessage("user", userText));
    messages.push(textMessage("assistant", `${pick(random, ZH_ASSISTANT_NOISE)}（回复编号 ${Math.floor(random() * 100000)}）`));
  }

  messages.push(textMessage(
    "user",
    "请根据对话中记录的检查点，准确回答关于 TCGA-LIHC 队列的 n、突变频率和统计量的问题。",
  ));

  return { messages, facts, seed: options.seed, numPairs };
}
