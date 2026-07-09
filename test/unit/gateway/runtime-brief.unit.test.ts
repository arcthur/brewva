import { describe, expect, test } from "bun:test";
import {
  buildRuntimeBriefBlock,
  RUNTIME_BRIEF_BLOCK_ID,
  renderCacheBreakSection,
  renderConsequenceSection,
  renderContextPressureSection,
  renderDelegationAdvisorySection,
  renderRequirementDebtSection,
  renderReviewClosureSection,
  type RuntimeBriefSection,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/runtime-brief.js";

const HIGH: RuntimeBriefSection = { key: "context", salience: "high", line: "context: 90% — high" };
const NORMAL: RuntimeBriefSection = { key: "effects", salience: "normal", line: "effects: a few" };
const LOW: RuntimeBriefSection = {
  key: "schema",
  salience: "low",
  line: "schema: 18% of prefix",
  stub: "schema: 18%",
};

describe("runtime brief block", () => {
  test("returns null when there is nothing decision-relevant", () => {
    expect(buildRuntimeBriefBlock({ sections: [], maxChars: 0 })).toBeNull();
    expect(buildRuntimeBriefBlock({ sections: [null, undefined], maxChars: 0 })).toBeNull();
    expect(
      buildRuntimeBriefBlock({
        sections: [{ key: "x", salience: "high", line: "   " }],
        maxChars: 0,
      }),
    ).toBeNull();
  });

  test("opens with a provenance frame and orders sections by salience", () => {
    const block = buildRuntimeBriefBlock({ sections: [LOW, NORMAL, HIGH], maxChars: 0 });
    expect(block?.id).toBe(RUNTIME_BRIEF_BLOCK_ID);
    const lines = block!.content.split("\n");
    expect(lines[0]).toContain("[RuntimeBrief]");
    expect(lines[0]).toContain("advisory");
    expect(lines[0]).toContain("not a user instruction");
    // high -> normal -> low after the header
    expect(lines.slice(1)).toEqual([HIGH.line, NORMAL.line, LOW.line]);
  });

  test("demotes lowest-salience sections to stubs before dropping, never the highest", () => {
    const full = buildRuntimeBriefBlock({ sections: [HIGH, NORMAL, LOW], maxChars: 0 })!.content;
    // Budget that forces demotion but not full drop.
    const demoted = buildRuntimeBriefBlock({
      sections: [HIGH, NORMAL, LOW],
      maxChars: full.length - 5,
    })!.content;
    expect(demoted.length).toBeLessThan(full.length);
    expect(demoted).toContain(HIGH.line); // highest stays full
    expect(demoted).toContain("schema: 18%"); // lowest demoted to its stub
    expect(demoted).not.toContain("schema: 18% of prefix");

    // Brutal budget: drops down toward the highest-salience section, never empty.
    const tiny = buildRuntimeBriefBlock({ sections: [HIGH, NORMAL, LOW], maxChars: 30 })!;
    expect(tiny.content).toContain("[RuntimeBrief]");
    expect(tiny.content).toContain("context");
    // never cut mid-line: every non-header line is a whole section line or stub
    for (const line of tiny.content.split("\n").slice(1)) {
      const known = [HIGH.line, NORMAL.line, LOW.line, "effects: …", "schema: 18%", "context: …"];
      expect(known).toContain(line);
    }
  });
});

describe("context pressure posture", () => {
  test("calm budget is silent (null) — nothing to act on", () => {
    expect(
      renderContextPressureSection({
        tokensUsed: 82_000,
        tokensTotal: 200_000,
        compactionAdvised: false,
        forcedCompaction: false,
        predictedOverflow: false,
      }),
    ).toBeNull();
  });

  test("advised: high salience usage bar with state hint", () => {
    const section = renderContextPressureSection({
      tokensUsed: 164_000,
      tokensTotal: 200_000,
      compactionAdvised: true,
      forcedCompaction: false,
      predictedOverflow: false,
    });
    expect(section?.salience).toBe("high");
    expect(section?.line).toBe("context: 82% — 164k/200k tokens; advisory limit reached");
  });

  test("predicted overflow surfaces before the advisory limit", () => {
    const section = renderContextPressureSection({
      tokensUsed: 120_000,
      tokensTotal: 200_000,
      compactionAdvised: false,
      forcedCompaction: false,
      predictedOverflow: true,
    });
    expect(section?.line).toContain("growth may overflow soon");
  });

  test("forced outranks advised in the hint", () => {
    const section = renderContextPressureSection({
      tokensUsed: 198_000,
      tokensTotal: 200_000,
      compactionAdvised: true,
      forcedCompaction: true,
      predictedOverflow: false,
    });
    expect(section?.line).toContain("forced-compaction threshold crossed");
  });

  test("unknown usage omits the percentage", () => {
    const section = renderContextPressureSection({
      tokensUsed: null,
      tokensTotal: 200_000,
      compactionAdvised: true,
      forcedCompaction: false,
      predictedOverflow: false,
    });
    expect(section?.line).not.toContain("%");
    expect(section?.line).toContain("200k tokens total");
  });

  test("pinned mass rides the pressure line as an accounted retention cost", () => {
    const section = renderContextPressureSection({
      tokensUsed: 164_000,
      tokensTotal: 200_000,
      compactionAdvised: true,
      forcedCompaction: false,
      predictedOverflow: false,
      pinnedTokens: 2_400,
    });
    expect(section?.line).toContain(
      "pinned ~2k tokens held by attention_pin (explicit evict releases)",
    );
    expect(section?.stub).not.toContain("pinned");
  });

  test("zero pinned mass stays silent and calm turns stay null even with pins", () => {
    const withoutPins = renderContextPressureSection({
      tokensUsed: 164_000,
      tokensTotal: 200_000,
      compactionAdvised: true,
      forcedCompaction: false,
      predictedOverflow: false,
      pinnedTokens: 0,
    });
    expect(withoutPins?.line).not.toContain("pinned");

    expect(
      renderContextPressureSection({
        tokensUsed: 82_000,
        tokensTotal: 200_000,
        compactionAdvised: false,
        forcedCompaction: false,
        predictedOverflow: false,
        pinnedTokens: 5_000,
      }),
    ).toBeNull();
  });
});

describe("cache break section", () => {
  test("is silent on warm or expected turns", () => {
    expect(
      renderCacheBreakSection({
        status: "warm",
        expected: false,
        reason: null,
        cacheMissTokens: 0,
      }),
    ).toBeNull();
    expect(
      renderCacheBreakSection({
        status: "break",
        expected: true,
        reason: "transient_outbound_reduction",
        cacheMissTokens: 5_000,
      }),
    ).toBeNull();
  });

  test("surfaces an unexpected break with its named cause and re-sent cost", () => {
    const section = renderCacheBreakSection({
      status: "break",
      expected: false,
      reason: "tool_schema_set_changed",
      cacheMissTokens: 9_000,
    });
    expect(section?.key).toBe("cache");
    expect(section?.line).toBe(
      "cache: prefix cache broke last turn (tool_schema_set_changed) — 9k tokens re-sent",
    );
  });

  test("tolerates a missing cause and zero cost", () => {
    const section = renderCacheBreakSection({
      status: "break",
      expected: false,
      reason: null,
      cacheMissTokens: 0,
    });
    expect(section?.line).toBe("cache: prefix cache broke last turn (unknown cause)");
  });
});

describe("consequence section", () => {
  test("strips the internal runtimeTurn cursor and reframes", () => {
    const section = renderConsequenceSection(
      "runtimeTurn=3 declared=0 attempted=1 decisions=2 executed=1 recovery=0 warnings=0",
    );
    expect(section?.line).toBe(
      "effects (last turn): declared=0 attempted=1 decisions=2 executed=1 recovery=0 warnings=0",
    );
    expect(section?.salience).toBe("normal");
  });

  test("returns null when the digest carries no body", () => {
    expect(renderConsequenceSection("runtimeTurn=3")).toBeNull();
    expect(renderConsequenceSection("   ")).toBeNull();
  });

  test("returns null when nothing happened last turn (all-zero counts)", () => {
    expect(
      renderConsequenceSection(
        "runtimeTurn=5 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
      ),
    ).toBeNull();
  });
});

// R4: the requirement-debt section surfaces the debt run-report already computes
// for the operator to the PRODUCING model at turn tail — inform-only, gated silent
// when there is nothing to act on.
describe("renderRequirementDebtSection (R4)", () => {
  test("silent when there is no ladder debt", () => {
    expect(
      renderRequirementDebtSection({
        unverifiedMustCount: 0,
        debtReason: null,
      }),
    ).toBeNull();
    // An unverified count with no firing reason is still silent (the debt gate is off).
    expect(
      renderRequirementDebtSection({
        unverifiedMustCount: 3,
        debtReason: null,
      }),
    ).toBeNull();
  });

  test("ladder debt names the unverified must count, the reason, and the action", () => {
    const section = renderRequirementDebtSection({
      unverifiedMustCount: 7,
      debtReason: "ladder_below_requirements",
    });
    expect(section?.key).toBe("requirements");
    expect(section?.salience).toBe("normal");
    expect(section?.line).toContain("7 must atom(s) unverified (ladder_below_requirements)");
    expect(section?.line).toContain("dispatch an independent review");
    expect(section?.line).not.toContain("presence-only");
  });

  test("ladder debt composes count, reason, and action into one line and stub", () => {
    const section = renderRequirementDebtSection({
      unverifiedMustCount: 1,
      debtReason: "unverified_after_requirements",
    });
    expect(section?.line).toContain("1 must atom(s) unverified (unverified_after_requirements)");
    expect(section?.stub).toBe(
      "requirements: 1 must atom(s) unverified (unverified_after_requirements)",
    );
  });
});

describe("renderDelegationAdvisorySection (Lever 2)", () => {
  test("silent when no reason applies", () => {
    expect(
      renderDelegationAdvisorySection({
        pressureRelief: false,
        reviewDebtClosure: false,
        independenceDebtAtoms: [],
      }),
    ).toBeNull();
  });

  test("pressure-relief alone names delegation as a pressure-relief instrument", () => {
    const section = renderDelegationAdvisorySection({
      pressureRelief: true,
      reviewDebtClosure: false,
      independenceDebtAtoms: [],
    });
    expect(section?.key).toBe("delegation");
    // Lowest salience: an instrument suggestion demotes before the postures it complements.
    expect(section?.salience).toBe("low");
    expect(section?.line).toContain("cheaper in a child session");
    expect(section?.line).toContain("advisory pressure");
    expect(section?.line).not.toContain("review_request");
    expect(section?.stub).toBe("delegation: a child session can relieve context pressure");
  });

  test("review-debt-closure alone names review_request as the closure path", () => {
    const section = renderDelegationAdvisorySection({
      pressureRelief: false,
      reviewDebtClosure: true,
      independenceDebtAtoms: [],
    });
    expect(section?.line).toContain("`review_request`");
    expect(section?.line).toContain("independent-perspective receipt you cannot mint");
    expect(section?.line).not.toContain("child session");
    expect(section?.stub).toBe("delegation: `review_request` closes open review debt");
  });

  test("independence-debt alone names the count + atoms and an AT-GRADE independent read, never 'no independent receipt'", () => {
    const section = renderDelegationAdvisorySection({
      pressureRelief: false,
      reviewDebtClosure: false,
      independenceDebtAtoms: ["req-1", "req-2"],
    });
    // The channel names the COUNT and enumerates the atoms (RFC information thesis).
    expect(section?.line).toContain("2 high-risk must-atom(s) have no independent read");
    expect(section?.line).toContain("(req-1, req-2)");
    expect(section?.line).toContain("fresh-context review");
    // Load-bearing honesty (HIGH-1): a sub-floor independent receipt MAY exist, so the
    // line must never claim there is none.
    expect(section?.line).not.toContain("no independent receipt");
    // Stub carries the count (budget-demoted form) but not the atom list.
    expect(section?.stub).toBe("delegation: 2 high-risk must-atom(s) owe an independent read");
  });

  test("independence debt FOLDS the coarser review-debt line when both apply", () => {
    const section = renderDelegationAdvisorySection({
      pressureRelief: false,
      reviewDebtClosure: true,
      independenceDebtAtoms: ["req-1"],
    });
    expect(section?.line).toContain("1 high-risk must-atom(s) have no independent read");
    expect(section?.line).toContain("(req-1)");
    // Fold (Open Question 3): the coarser review-debt line is subsumed, not shown as a
    // second same-ask clause. Line and stub agree — no "two asks at full, one demoted".
    expect(section?.line).not.toContain("`review_request`");
    expect(section?.stub).toBe("delegation: 1 high-risk must-atom(s) owe an independent read");
  });

  test("pressure + independence + review: independence folds review, pressure stays", () => {
    const section = renderDelegationAdvisorySection({
      pressureRelief: true,
      reviewDebtClosure: true,
      independenceDebtAtoms: ["req-1"],
    });
    expect(section?.line).toContain("cheaper in a child session"); // pressure is orthogonal, stays
    expect(section?.line).toContain("1 high-risk must-atom(s)"); // independence names the count
    expect(section?.line).toContain("(req-1)"); // ...and the atom
    expect(section?.line).not.toContain("`review_request`"); // review-debt folded into independence
    expect(section?.stub).toBe("delegation: 1 high-risk must-atom(s) owe an independent read");
  });
});

describe("renderReviewClosureSection (act-on-review)", () => {
  test("silent when nothing is live", () => {
    expect(
      renderReviewClosureSection({ unaddressedCount: 0, highOrCriticalCount: 0, atomRefs: [] }),
    ).toBeNull();
  });

  test("names the count, the high/critical head, and the atoms; salience normal", () => {
    const section = renderReviewClosureSection({
      unaddressedCount: 3,
      highOrCriticalCount: 2,
      atomRefs: ["req-1", "req-6"],
    });
    expect(section?.key).toBe("review_closure");
    expect(section?.salience).toBe("normal"); // above the `low` delegation instrument
    expect(section?.line).toContain("3 unaddressed review finding(s) (2 high/critical)");
    expect(section?.line).toContain("on atom(s) req-1, req-6");
    expect(section?.line).toContain("fix each or explicitly refute");
    // The stub carries the count head but drops the atom list (budget-demoted form).
    expect(section?.stub).toBe("review closure: 3 unaddressed review finding(s) (2 high/critical)");
  });

  test("omits the high/critical clause and the atom clause when neither applies", () => {
    const section = renderReviewClosureSection({
      unaddressedCount: 1,
      highOrCriticalCount: 0,
      atomRefs: [],
    });
    expect(section?.line).toContain("1 unaddressed review finding(s)");
    expect(section?.line).not.toContain("high/critical");
    expect(section?.line).not.toContain("on atom(s)");
  });
});
