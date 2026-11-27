import { testScore } from "@tsmono/inspect-common/testing";
import type { ChatMessage, Score } from "@tsmono/inspect-common/types";

import { colorScheme, type Palette } from "./schemes";
import { collectAnnotationSets, type ResolvedSet } from "./sets";
import { annotationView, type AnnotationView } from "./view";

// Raw `text_annotations` data for this module's tests: the format is JSON
// read as `unknown`, so builders return plain objects for tests to break.

export const kindField = {
  name: "kind",
  description: "What the paragraph does",
  type: "categorical",
  options: ["task_work", "mapping"],
};

export const suspectsField = {
  name: "suspects_test",
  description: null,
  type: "categorical",
  options: ["yes", "no"],
  negative: ["no"],
};

/** A field whose negative option's name says nothing about it. */
export const findingField = {
  name: "finding",
  description: null,
  type: "categorical",
  options: ["absent", "present"],
  negative: ["absent"],
};

export const probeField = {
  name: "deception",
  description: "Linear probe",
  type: "numeric",
  metadata: { layer: 12, method: "logistic regression" },
};

export const rawPart = (overrides: Record<string, unknown> = {}) => ({
  message_id: "u1",
  content_index: null,
  starts: [0, 6, 10],
  ends: [5, 9, 15],
  values: { deception: [0.5, -1, 2] },
  ...overrides,
});

export const rawSet = (overrides: Record<string, unknown> = {}) => ({
  name: "probes",
  unit: "token",
  source: "test",
  metadata: { tokenizer: "tiktoken/o200k_base" },
  description: null,
  fields: [probeField],
  parts: [rawPart()],
  ...overrides,
});

export const rawAnnotations = (sets: unknown[] = [rawSet()]) => ({
  version: 2,
  sets,
});

export const annotatedScore = (sets: unknown[]): Score =>
  testScore({
    value: 0,
    metadata: { text_annotations: rawAnnotations(sets) },
  });

/** The one annotation set `set` resolves to against `messages`; throws on
 *  any error so a test fails loudly on bad fixtures. */
export const resolvedSet = (
  set: unknown,
  messages: readonly ChatMessage[]
): ResolvedSet => {
  const { sets, errors } = collectAnnotationSets(
    { probes: annotatedScore([set]) },
    messages
  );
  const [resolved] = sets;
  if (!resolved || errors.length > 0) throw new Error(errors.join("; "));
  return resolved;
};

/** The view of field `name` of `set`; throws when it has no such field. */
export const viewOf = (
  set: ResolvedSet,
  name: string,
  highlight: readonly string[] = [],
  palette: Palette = { scheme: colorScheme("default"), dark: false }
): AnnotationView => {
  const field = set.fields.find((f) => f.name === name);
  if (!field) throw new Error(`no field ${name}`);
  return annotationView(set, field, highlight, palette);
};
