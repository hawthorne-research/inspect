import { testScore } from "@tsmono/inspect-common/testing";
import type { ChatMessage, Score } from "@tsmono/inspect-common/types";

import { collectAnnotationLayers, type ResolvedLayer } from "./layers";

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
};

export const probeField = {
  name: "deception",
  description: "Linear probe",
  type: "numeric",
  model_layer: 12,
};

export const rawPart = (overrides: Record<string, unknown> = {}) => ({
  message_id: "u1",
  content_index: null,
  starts: [0, 6, 10],
  ends: [5, 9, 15],
  values: { deception: [0.5, -1, 2] },
  ...overrides,
});

export const rawLayer = (overrides: Record<string, unknown> = {}) => ({
  name: "probes",
  unit: "token",
  source: "test",
  tokenizer: "tiktoken/o200k_base",
  description: null,
  fields: [probeField],
  parts: [rawPart()],
  ...overrides,
});

export const rawAnnotations = (layers: unknown[] = [rawLayer()]) => ({
  version: 0,
  layers,
});

export const annotatedScore = (layers: unknown[]): Score =>
  testScore({
    value: 0,
    metadata: { text_annotations: rawAnnotations(layers) },
  });

/** The one layer `layers` resolve to against `messages`; throws on any
 *  error so a test fails loudly on bad fixtures. */
export const resolvedLayer = (
  layer: unknown,
  messages: readonly ChatMessage[]
): ResolvedLayer => {
  const { layers, errors } = collectAnnotationLayers(
    { probes: annotatedScore([layer]) },
    messages
  );
  const [resolved] = layers;
  if (!resolved || errors.length > 0) throw new Error(errors.join("; "));
  return resolved;
};
