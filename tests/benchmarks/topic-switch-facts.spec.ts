import assert from "node:assert/strict";
import test from "node:test";

import { buildTranscript } from "../../benchmarks/topicSwitch.js";
import { gradeView, questionFor, viewOf } from "../../benchmarks/realLlmTopicSwitch.js";

// `benchmark:real-llm-topic-switch` asks questions about facts produced by
// `topicSwitch.ts`, and the two files have to agree on how a fact is worded.
// They disagree silently, and a wrong agreement does not throw — it produces a
// row of zero questions that prints as "0%": a bug wearing the costume of a
// result. That happened once (the decorrelated wording has its own field
// names), so the round-trip is pinned here instead of being trusted.

const STYLES = ["shared", "decorrelated"] as const;

test("every generated fact is readable in both wordings", () => {
  for (const factStyle of STYLES) {
    const { factsA, factsB } = buildTranscript({ seed: 20260921, pairsPerTopic: 40, factsPerTopic: 4, factStyle });
    assert.equal(factsA.length, 4, `${factStyle}: topic A fact count`);
    assert.equal(factsB.length, 4, `${factStyle}: topic B fact count`);
    for (const [topic, facts] of [["A", factsA], ["B", factsB]] as const) {
      for (const fact of facts) {
        const view = viewOf(factStyle, topic, fact);
        assert.ok(view, `${factStyle}/${topic}: unparsable fact ${fact.text}`);
        assert.match(fact.text, new RegExp(view.gene), `${factStyle}/${topic}: gene must come from the text`);
        assert.match(fact.text, new RegExp(view.value1.replace(".", "\\.")), "value1 must come from the text");
      }
    }
  }
});

test("the two wordings really are decorrelated when they claim to be", () => {
  const shared = buildTranscript({ seed: 20260921, pairsPerTopic: 40, factsPerTopic: 4, factStyle: "shared" });
  const decorrelated = buildTranscript({ seed: 20260921, pairsPerTopic: 40, factsPerTopic: 4, factStyle: "decorrelated" });
  // Same seed, same values: only the surface form changes, so this is a fair
  // rewording rather than a different experiment.
  assert.deepEqual(
    decorrelated.factsA.map((fact) => viewOf("decorrelated", "A", fact)),
    shared.factsA.map((fact) => {
      const view = viewOf("shared", "A", fact)!;
      return { ...view, label1: "reading", label2: "dispersion" };
    }),
  );
  // And the field words no longer overlap between topics.
  const aWords = new Set(decorrelated.factsA[0]!.text.split(/\s+/));
  const bWords = decorrelated.factsB[0]!.text.split(/\s+/).filter((word) => /^[a-z]+$/.test(word));
  for (const word of bWords) {
    assert.ok(!aWords.has(word), `decorrelated wording still shares the word "${word}" between topics`);
  }
});

test("question and grader round-trip on the value the question asks for", () => {
  for (const factStyle of STYLES) {
    const { factsA, factsB } = buildTranscript({ seed: 20260922, pairsPerTopic: 40, factsPerTopic: 4, factStyle });
    for (const [topic, facts] of [["A", factsA], ["B", factsB]] as const) {
      const fact = facts[0]!;
      const view = viewOf(factStyle, topic, fact)!;
      const question = questionFor(fact, view);
      assert.ok(question.includes(fact.marker), "the question must name the checkpoint marker");
      assert.ok(question.includes(view.label1) && question.includes(view.label2), "the question must ask for both fields");

      const answer = `gene=${view.gene} ${view.label1}=${view.value1} ${view.label2}=${view.value2}`;
      assert.equal(gradeView(answer, view), true, `${factStyle}/${topic}: the asked-for answer must grade as correct`);

      // A right answer under the other wording's labels is still wrong: the
      // model has to report the field the question asked for.
      const wrongLabels = `gene=${view.gene} foo=${view.value1} bar=${view.value2}`;
      assert.equal(gradeView(wrongLabels, view), false, "mismatched field labels must not grade as correct");
      assert.equal(gradeView("NOT_IN_CONTEXT", view), false, "an abstention must not grade as correct");

      const wrongValue = `gene=${view.gene} ${view.label1}=${view.value1} ${view.label2}=99999`;
      assert.equal(gradeView(wrongValue, view), false, "a wrong number must not grade as correct");
    }
  }
});
