import type {
  SkillSelection,
  SkillSelectionBreakdownEntry,
  SkillTriggerNegativeRule,
  SkillTriggerPolicy,
  SkillsIndexEntry,
} from "../types.js";

const WORD_RE = /[\p{L}\p{N}_-]+/gu;
const TERM_CHAR_RE = /[\p{L}\p{N}_-]/u;
const SENTENCE_BOUNDARY_RE = /[.!?。！？\n]/u;
const MAX_INTENT_WINDOW_TOKENS = 24;
const IMPERATIVE_PREFIXES = [
  "please",
  "can you",
  "could you",
  "help me",
  "i need to",
  "i want to",
  "i'd like to",
];

const NAME_MATCH_SCORE = 10;
const INTENT_MATCH_SCORE = 8;
const INTENT_BODY_MATCH_SCORE = 4;
const PHRASE_MATCH_SCORE = 7;
const TAG_MATCH_SCORE = 3;
const ANTI_TAG_PENALTY = 3;
const MAX_TAG_MATCHES = 3;

const TOKEN_ALIASES: Record<string, string[]> = {
  review: ["audit", "assess", "evaluate", "quality", "risk", "safety", "readiness"],
  audit: ["review", "assess", "evaluate", "quality", "risk", "safety"],
  assess: ["review", "audit", "evaluate", "quality", "risk"],
  evaluate: ["review", "audit", "assess", "quality", "risk"],
  ready: ["readiness", "review", "assess", "release", "ship", "deploy", "merge"],
  readiness: ["ready", "review", "assess", "release", "ship", "deploy", "merge"],
  ship: ["release", "deploy", "production", "readiness", "review", "merge"],
  release: ["ship", "deploy", "production", "readiness", "review", "merge"],
  deploy: ["ship", "release", "production", "readiness", "review"],
  merge: ["review", "risk", "safety", "readiness", "release"],
  safe: ["safety", "review", "risk"],
  safety: ["safe", "review", "risk"],
};

const EMPTY_TRIGGER_POLICY: SkillTriggerPolicy = {
  intents: [],
  topics: [],
  phrases: [],
  negatives: [],
};

interface PromptRegions {
  intentTokens: string[];
  intentText: string;
  bodyTokens: string[];
  bodyText: string;
  allTokens: string[];
  allText: string;
}

function isAsciiWord(token: string): boolean {
  return /^[a-z0-9_-]+$/u.test(token);
}

function tokenize(input: string): string[] {
  const rawTokens = input.toLowerCase().match(WORD_RE) ?? [];
  return rawTokens.filter((token) => {
    if (token.length === 0) return false;
    if (isAsciiWord(token)) return token.length >= 2;
    return true;
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function costWeight(costHint: SkillsIndexEntry["costHint"] | undefined): number {
  if (costHint === "low") return 1;
  if (costHint === "high") return -1;
  return 0;
}

function normalizeNegativeRules(value: unknown): SkillTriggerNegativeRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      scope: item.scope === "intent" ? ("intent" as const) : ("topic" as const),
      terms: normalizeStringArray(item.terms),
    }))
    .filter((rule) => rule.terms.length > 0);
}

function readEntryTriggers(entry: SkillsIndexEntry): SkillTriggerPolicy {
  const raw = entry.triggers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_TRIGGER_POLICY;
  }
  const rawRecord = raw as unknown as Record<string, unknown>;
  return {
    intents: normalizeStringArray(rawRecord.intents),
    topics: normalizeStringArray(rawRecord.topics),
    phrases: normalizeStringArray(rawRecord.phrases),
    negatives: normalizeNegativeRules(rawRecord.negatives),
  };
}

function hasBoundedSubstring(text: string, term: string): boolean {
  if (term.length === 0) return false;
  let offset = text.indexOf(term);
  while (offset !== -1) {
    const before = offset > 0 ? text[offset - 1] : undefined;
    const afterOffset = offset + term.length;
    const after = afterOffset < text.length ? text[afterOffset] : undefined;
    const beforeBounded = before === undefined || !TERM_CHAR_RE.test(before);
    const afterBounded = after === undefined || !TERM_CHAR_RE.test(after);
    if (beforeBounded && afterBounded) {
      return true;
    }
    offset = text.indexOf(term, offset + 1);
  }
  return false;
}

function hasTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function trimLeadingImperativePrefix(text: string): string {
  const trimmed = text.trimStart();
  for (const prefix of IMPERATIVE_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    let rest = trimmed.slice(prefix.length).trimStart();
    rest = rest.replace(/^[,:;-]+\s*/u, "");
    return rest;
  }
  return trimmed;
}

function extractPromptRegions(message: string): PromptRegions {
  const allText = message.toLowerCase().trim();
  const allTokens = tokenize(allText);
  if (allText.length === 0) {
    return {
      intentTokens: [],
      intentText: "",
      bodyTokens: [],
      bodyText: "",
      allTokens,
      allText,
    };
  }

  const sentenceBoundary = allText.search(SENTENCE_BOUNDARY_RE);
  const sentenceEnd = sentenceBoundary >= 0 ? sentenceBoundary + 1 : allText.length;
  const rawIntent = allText.slice(0, sentenceEnd);
  const intentText = trimLeadingImperativePrefix(rawIntent);
  const rawBodyText = allText.slice(sentenceEnd).trim();
  const intentTokens = tokenize(intentText).slice(0, MAX_INTENT_WINDOW_TOKENS);
  const bodyText = rawBodyText;
  const bodyTokens = tokenize(bodyText);

  return {
    intentTokens,
    intentText,
    bodyTokens,
    bodyText,
    allTokens,
    allText,
  };
}

function matchesTerm(input: {
  term: string;
  text: string;
  tokenList: string[];
  tokenSet: Set<string>;
}): boolean {
  const normalized = input.term.trim().toLowerCase();
  if (!normalized) return false;

  const termTokens = tokenize(normalized);
  if (termTokens.length === 0) return false;

  if (termTokens.length === 1) {
    const token = termTokens[0]!;
    if (input.tokenSet.has(token)) return true;
    if (!isAsciiWord(token)) return input.text.includes(token);
    if (token.length < 3) return false;
    return hasBoundedSubstring(input.text, token);
  }

  return hasTokenSequence(input.tokenList, termTokens);
}

function hasExplicitTriggers(entry: SkillsIndexEntry): boolean {
  const triggers = readEntryTriggers(entry);
  return (
    triggers.intents.length > 0 ||
    triggers.topics.length > 0 ||
    triggers.phrases.length > 0 ||
    triggers.negatives.length > 0
  );
}

function stemToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("tion")) return token.slice(0, -4);
  if (token.endsWith("sion")) return token.slice(0, -4);
  if (token.endsWith("ment")) return token.slice(0, -4);
  if (token.endsWith("ness")) return token.slice(0, -4);
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function expandTermsWithAliases(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (!normalized) continue;
    expanded.add(normalized);

    const tokens = tokenize(normalized);
    if (tokens.length !== 1) continue;

    const token = tokens[0]!;
    const stemmed = stemToken(token);
    const aliases = TOKEN_ALIASES[token] ?? TOKEN_ALIASES[stemmed] ?? [];
    for (const alias of aliases) {
      const normalizedAlias = alias.trim().toLowerCase();
      if (!normalizedAlias) continue;
      expanded.add(normalizedAlias);
    }
  }
  return [...expanded];
}

function resolveEffectiveTriggers(entry: SkillsIndexEntry): SkillTriggerPolicy {
  const explicitTriggers = readEntryTriggers(entry);
  if (hasExplicitTriggers(entry)) {
    return {
      intents: expandTermsWithAliases(explicitTriggers.intents),
      topics: explicitTriggers.topics,
      phrases: explicitTriggers.phrases,
      negatives: explicitTriggers.negatives,
    };
  }

  return {
    intents: expandTermsWithAliases([entry.name]),
    topics: [],
    phrases: [],
    negatives: [],
  };
}

function findFirstMatchedTerm(input: {
  terms: string[];
  text: string;
  tokenList: string[];
  tokenSet: Set<string>;
}): string | null {
  for (const term of new Set(input.terms.map((value) => value.trim()).filter(Boolean))) {
    if (
      matchesTerm({
        term,
        text: input.text,
        tokenList: input.tokenList,
        tokenSet: input.tokenSet,
      })
    ) {
      return term;
    }
  }
  return null;
}

function findMatchedTerms(input: {
  terms: string[];
  text: string;
  tokenList: string[];
  tokenSet: Set<string>;
  maxMatches?: number;
}): string[] {
  const matches: string[] = [];
  for (const term of new Set(input.terms.map((value) => value.trim()).filter(Boolean))) {
    if (
      matchesTerm({
        term,
        text: input.text,
        tokenList: input.tokenList,
        tokenSet: input.tokenSet,
      })
    ) {
      matches.push(term);
      if (typeof input.maxMatches === "number" && matches.length >= input.maxMatches) {
        break;
      }
    }
  }
  return matches;
}

function findFirstMatchedPhrase(phrases: string[], allTokens: string[]): string | null {
  for (const phrase of new Set(phrases.map((value) => value.trim()).filter(Boolean))) {
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length === 0) continue;
    if (hasTokenSequence(allTokens, phraseTokens)) {
      return phrase;
    }
  }
  return null;
}

function shouldFilterByNegativeRules(input: {
  triggers: SkillTriggerPolicy;
  regions: PromptRegions;
  intentSet: Set<string>;
  allSet: Set<string>;
}): boolean {
  for (const rule of input.triggers.negatives) {
    for (const term of rule.terms) {
      const matched =
        rule.scope === "intent"
          ? matchesTerm({
              term,
              text: input.regions.intentText,
              tokenList: input.regions.intentTokens,
              tokenSet: input.intentSet,
            })
          : matchesTerm({
              term,
              text: input.regions.allText,
              tokenList: input.regions.allTokens,
              tokenSet: input.allSet,
            });
      if (matched) return true;
    }
  }
  return false;
}

function rankAndTake(scored: SkillSelection[], k: number): SkillSelection[] {
  return scored
    .toSorted((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, k));
}

function summarizeBreakdown(breakdown: SkillSelectionBreakdownEntry[]): string {
  return breakdown.map((entry) => `${entry.signal}:${entry.term}`).join(",");
}

export function selectTopKSkills(
  message: string,
  index: SkillsIndexEntry[],
  k: number,
): SkillSelection[] {
  const regions = extractPromptRegions(message);
  const intentSet = new Set(regions.intentTokens);
  const bodySet = new Set(regions.bodyTokens);
  const allSet = new Set(regions.allTokens);

  const scored: SkillSelection[] = [];

  for (const entry of index) {
    const triggers = resolveEffectiveTriggers(entry);
    const tags = expandTermsWithAliases(normalizeStringArray(entry.tags));
    const antiTags = normalizeStringArray(entry.antiTags);

    if (
      shouldFilterByNegativeRules({
        triggers,
        regions,
        intentSet,
        allSet,
      })
    ) {
      continue;
    }

    const breakdown: SkillSelectionBreakdownEntry[] = [];

    const nameTerm = findFirstMatchedTerm({
      terms: [entry.name],
      text: regions.allText,
      tokenList: regions.allTokens,
      tokenSet: allSet,
    });
    if (nameTerm) {
      breakdown.push({
        signal: "name_match",
        term: nameTerm,
        delta: NAME_MATCH_SCORE,
      });
    }

    const intentTerm = findFirstMatchedTerm({
      terms: triggers.intents,
      text: regions.intentText,
      tokenList: regions.intentTokens,
      tokenSet: intentSet,
    });
    if (intentTerm) {
      breakdown.push({
        signal: "intent_match",
        term: intentTerm,
        delta: INTENT_MATCH_SCORE,
      });
    } else {
      const intentBodyTerm = findFirstMatchedTerm({
        terms: triggers.intents,
        text: regions.bodyText,
        tokenList: regions.bodyTokens,
        tokenSet: bodySet,
      });
      if (intentBodyTerm) {
        breakdown.push({
          signal: "intent_body_match",
          term: intentBodyTerm,
          delta: INTENT_BODY_MATCH_SCORE,
        });
      }
    }

    const phrase = findFirstMatchedPhrase(triggers.phrases, regions.allTokens);
    if (phrase) {
      breakdown.push({
        signal: "phrase_match",
        term: phrase,
        delta: PHRASE_MATCH_SCORE,
      });
    }

    const matchedTags = findMatchedTerms({
      terms: tags,
      text: regions.allText,
      tokenList: regions.allTokens,
      tokenSet: allSet,
      maxMatches: MAX_TAG_MATCHES,
    });
    for (const tag of matchedTags) {
      breakdown.push({
        signal: "tag_match",
        term: tag,
        delta: TAG_MATCH_SCORE,
      });
    }

    for (const antiTag of new Set(antiTags.map((value) => value.trim()).filter(Boolean))) {
      if (
        matchesTerm({
          term: antiTag,
          text: regions.allText,
          tokenList: regions.allTokens,
          tokenSet: allSet,
        })
      ) {
        breakdown.push({
          signal: "anti_tag_penalty",
          term: antiTag,
          delta: -ANTI_TAG_PENALTY,
        });
      }
    }

    const weight = costWeight(entry.costHint);
    if (weight !== 0) {
      breakdown.push({
        signal: "cost_adjustment",
        term: entry.costHint ?? "medium",
        delta: weight,
      });
    }

    if (breakdown.length === 0) {
      continue;
    }

    const score = breakdown.reduce((sum, item) => sum + item.delta, 0);
    if (score <= 0) {
      continue;
    }

    scored.push({
      name: entry.name,
      score,
      reason: summarizeBreakdown(breakdown),
      breakdown,
    });
  }

  return rankAndTake(scored, k);
}
