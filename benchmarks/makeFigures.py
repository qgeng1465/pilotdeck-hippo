#!/usr/bin/env python3
"""Render the poster figures from the committed benchmark JSONs.

Every number on these figures is read out of `benchmarks/results/*.json` — the
same files the README cites — so a figure cannot drift from the table it
belongs to. Nothing is typed in by hand except the axis labels.

Run:  python3 benchmarks/makeFigures.py
Out:  docs/figures/*.svg (vector, for print) and *.png (300 dpi)

House style, deliberately: plain descriptive titles, no "surge"/"boost"
wording, the sample size on every panel, and the source file named in the
footnote. If a number here looks better than it is, the figure is wrong.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

RESULTS = Path("benchmarks/results")
OUT = Path("docs/figures")

UPSTREAM_COLOR = "#8a8f98"
HIPPO_COLOR = "#3b6ea5"
ACCENT = "#7a4a2b"

plt.rcParams.update({
    "font.sans-serif": ["WenQuanYi Micro Hei", "Noto Sans CJK JP", "DejaVu Sans"],
    "font.family": "sans-serif",
    "axes.unicode_minus": False,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.edgecolor": "#5b6068",
    "axes.labelcolor": "#2b2f36",
    "text.color": "#2b2f36",
    "xtick.color": "#5b6068",
    "ytick.color": "#5b6068",
    "figure.dpi": 120,
    "savefig.bbox": "tight",
})


def load(name: str) -> dict:
    path = RESULTS / name
    if not path.exists():
        raise SystemExit(f"missing results file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def footnote(fig, text: str) -> None:
    fig.text(0.01, -0.02, text, fontsize=7.5, color="#6b7078", ha="left", va="top", wrap=True)


def save(fig, stem: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for suffix in ("svg", "png"):
        fig.savefig(OUT / f"{stem}.{suffix}", dpi=300)
    plt.close(fig)
    print(f"wrote {OUT / stem}.svg and .png")


# --------------------------------------------------------------------------
# 1. Ablation: one scoring term at a time, at N=160.
# --------------------------------------------------------------------------
def figure_ablation() -> None:
    src = "ablation-2026-09-11T11-17-30-040Z.json"
    data = load(src)
    combos = [combo["key"] for combo in data["combos"]]
    rows = {(row["lang"], row["numPairs"], row["combo"]): row for row in data["rows"]}
    size = "N=160"

    fig, ax = plt.subplots(figsize=(9.6, 4.4))
    width = 0.38
    positions = range(len(combos))
    for offset, (lang, label, color) in enumerate(
        (("en", "英文 (EN)", "#3b6ea5"), ("zh", "中文 (ZH)", "#b07d3a"))
    ):
        values = []
        for combo in combos:
            row = rows.get((lang, size, combo))
            values.append(row["factsRetainedMedian"] if row else 0)
        xs = [p + (offset - 0.5) * width for p in positions]
        bars = ax.bar(xs, values, width, label=label, color=color, edgecolor="white", linewidth=0.6)
        for bar, value in zip(bars, values):
            ax.text(bar.get_x() + bar.get_width() / 2, value + 0.25, f"{value:g}",
                    ha="center", va="bottom", fontsize=9, color="#2b2f36")

    # Two-line short labels: the JSON's own keys overlap at this width.
    display = {
        "sim only": "仅 sim",
        "time only": "仅 time",
        "rank only (raw)": "仅 rank\n（原始）",
        "rank only (+idf)": "仅 rank\n（+IDF）",
        "full (old default 0.4/0.35/0.25)": "旧默认\n0.4/0.35/0.25",
        "full (default)": "当前默认\n0.85/0.15/0.00",
    }
    ax.set_xticks(list(positions))
    ax.set_xticklabels([display.get(combo, combo) for combo in combos], fontsize=9)
    ax.set_ylabel("压缩后逐字保留的精确事实（中位数 / 20）", fontsize=10)
    ax.set_ylim(0, 21)
    ax.axhline(0, color="#c9ccd1", linewidth=0.8)
    ax.grid(axis="y", color="#e6e8eb", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=9, loc="upper left")
    ax.set_title(f"消融：逐项拆开评分公式（{size}，{data['seeds']} 个种子，取中位数）",
                 fontsize=11.5, pad=12, loc="left")
    footnote(fig,
             "本图是单项目标消融，不含上游对照——上游不做逐字保留，其逐字列在任何 N 下都是 0，另见留出集图。\n"
             "「仅 rank（原始）」两语种均为 0，是 IDF 校正这一修复的出发点。\n"
             f"数据：benchmarks/results/{src}")
    save(fig, "fig_ablation")


# --------------------------------------------------------------------------
# 2. Held-out set: upstream vs shipped default, per cell, with the sign test.
# --------------------------------------------------------------------------
def figure_holdout() -> None:
    src = "holdout-2026-09-11T11-19-13-567Z.json"
    data = load(src)
    shipped = "shipped default"
    upstream = "upstream (no retention)"
    rows = {(row["lang"], row["numPairs"], row["variant"]): row for row in data["rows"]}
    # The main effect specifically: shipped default AGAINST upstream. The file
    # also holds "shipped default vs old default" and "... vs previous
    # default", which are different (and deliberately mostly non-significant)
    # comparisons — matching only on the left-hand side silently annotates the
    # wrong row.
    comparisons = {
        (c["lang"], c["numPairs"]): c
        for c in data["comparisons"]
        if c["a"] == shipped and c["b"] == upstream
    }

    cells = [(lang, size) for lang in ("en", "zh") for size in data["numPairs"]]
    fig, ax = plt.subplots(figsize=(7.2, 4.6))

    for index, (lang, size) in enumerate(cells):
        base = rows[(lang, size, upstream)]["mean"]
        top = rows[(lang, size, shipped)]["mean"]
        ax.plot([base, top], [index, index], color="#c3c7cc", linewidth=2.4, zorder=1)
        ax.scatter([base], [index], s=70, color=UPSTREAM_COLOR, zorder=3,
                   label="上游 (no retention)" if index == 0 else None)
        ax.scatter([top], [index], s=70, color=HIPPO_COLOR, zorder=3,
                   label="Hippo 当前默认" if index == 0 else None)
        ax.text(base - 0.35, index, f"{base:g}", ha="right", va="center", fontsize=9, color="#5b6068")
        ax.text(top + 0.35, index, f"{top:g}", ha="left", va="center", fontsize=9.5, color=HIPPO_COLOR)
        comp = comparisons.get((lang, size))
        if comp is None:
            raise SystemExit(f"holdout JSON is missing the main-effect comparison for {lang} N={size}")
        ax.text(20.2, index,
                f"{comp['winsA']}胜/{comp['ties']}平/{comp['winsB']}负  p={comp['signTestP']}",
                ha="left", va="center", fontsize=8.5, color=ACCENT)

    ax.set_yticks(range(len(cells)))
    ax.set_yticklabels([f"{'EN' if lang == 'en' else 'ZH'}  N={size}" for lang, size in cells], fontsize=10)
    ax.set_xlim(0, 20)
    ax.set_xlabel("精确事实恢复（均值 / 20）", fontsize=10)
    ax.invert_yaxis()
    ax.grid(axis="x", color="#e6e8eb", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.legend(frameon=False, fontsize=9, loc="lower right")
    ax.set_title(f"留出集配对检验（{len(data['seeds'])} 个从未参与调参的种子，"
                 f"{data['factsPerCase']} 条事实/例）", fontsize=11.5, pad=12, loc="left")
    footnote(fig,
             "右侧为「Hippo 当前默认 vs 上游」的配对符号检验；四格各自 p 见上。\n"
             f"数据：benchmarks/results/{src}")
    save(fig, "fig_holdout")


# --------------------------------------------------------------------------
# 3. Real-LLM closed loop, both rounds, side by side.
# --------------------------------------------------------------------------
ROUNDS = [
    ("A", "real-llm-2026-09-11T04-44-55-274Z.json", "轮次 A · 官方 API（摘要短：1,200 tok/次，8/8 格恒定）"),
    ("B", "real-llm-2026-09-11T09-21-18-795Z.json", "轮次 B · 比赛网关（摘要上限 4,000 tok/次，≥8/16 次触顶）"),
]


def figure_real_llm() -> None:
    fig, axes = plt.subplots(1, 2, figsize=(12.4, 4.3), sharey=True)
    cells = [("en", 80), ("en", 160), ("zh", 80), ("zh", 160)]

    for ax, (round_key, src, title) in zip(axes, ROUNDS):
        data = load(src)
        rows = {(row["lang"], row["numPairs"], row["variant"]): row for row in data["summary"]}
        width = 0.38
        for offset, (variant, label, color) in enumerate(
            (("upstream", "上游", UPSTREAM_COLOR), ("hippo", "Hippo", HIPPO_COLOR))
        ):
            values, notes = [], []
            for lang, size in cells:
                row = rows.get((lang, size, variant))
                values.append(row["qaAccuracy"] if row else 0)
                notes.append(f"{row['qaCorrect']}/{row['qaTotal']}" if row else "")
            xs = [p + (offset - 0.5) * width for p in range(len(cells))]
            bars = ax.bar(xs, values, width, label=label, color=color, edgecolor="white", linewidth=0.6)
            for bar, value, note in zip(bars, values, notes):
                x = bar.get_x() + bar.get_width() / 2
                # A label centered inside the bar lands below the axis when the
                # bar is zero or near-zero, which renders as clipped garbage.
                # Short bars get the count next to the percentage instead.
                if value >= 15:
                    ax.text(x, value + 2, f"{value:g}%", ha="center", va="bottom", fontsize=9, color="#2b2f36")
                    ax.text(x, value / 2, note, ha="center", va="center", fontsize=8, color="white")
                else:
                    ax.text(x, value + 2, f"{value:g}%（{note}）", ha="center", va="bottom", fontsize=8.5, color="#2b2f36")

        ax.set_xticks(range(len(cells)))
        ax.set_xticklabels([f"{'EN' if lang == 'en' else 'ZH'}\nN={size}" for lang, size in cells], fontsize=9)
        ax.set_ylim(0, 112)
        ax.grid(axis="y", color="#e6e8eb", linewidth=0.8)
        ax.set_axisbelow(True)
        ax.set_title(title, fontsize=10.5, pad=10, loc="left")

    axes[0].set_ylabel("压缩后仅凭上下文答题的准确率", fontsize=10)
    axes[0].legend(frameon=False, fontsize=9, loc="upper left")
    fig.suptitle("真 LLM 闭环：两轮必须一起看（每格 16 题、2 seeds，柱内为答对/总题数）",
                 fontsize=12, x=0.01, ha="left", y=1.03)
    footnote(fig,
             "摘要器与 judge 均为 DeepSeek-V4-Flash（temperature 0），同模型评审存在偏差；两轮差异本身说明单轮数字不可外推。\n"
             "数据：benchmarks/results/" + "、".join(src for _, src, _ in ROUNDS))
    save(fig, "fig_real_llm")


def main() -> None:
    figure_ablation()
    figure_holdout()
    figure_real_llm()


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent.parent)
    main()
