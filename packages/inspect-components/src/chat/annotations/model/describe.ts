import type { AnnotationField, AnnotationMetadata } from "./format";

/** What one span of an annotation set is called: its unit, e.g.
 *  "paragraph", or "span" when it has none. The unit is only ever shown. */
export const spanNoun = (unit: string | null): string => unit ?? "span";

/** A number of spans of an annotation set with the `unit`, e.g. "10,226
 *  tokens" (see `spanNoun`). */
export const spanCountLabel = (count: number, unit: string | null): string => {
  const noun = spanNoun(unit);
  return `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`;
};

/** A metadata value as text: strings as they are, other values as JSON. */
export const metadataText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Each metadata entry as `key: value`, in the metadata's order. */
export const metadataEntries = (metadata: AnnotationMetadata): string[] =>
  Object.entries(metadata).map(
    ([key, value]) => `${key}: ${metadataText(value)}`
  );

/** What a reader learns about a field beyond its name: its description,
 *  then its metadata entries. */
export const fieldDetails = (field: AnnotationField): string[] => [
  ...(field.description ? [field.description] : []),
  ...metadataEntries(field.metadata),
];

/** A field's name and details, one per line, e.g. for a tooltip. */
export const fieldTitle = (field: AnnotationField): string =>
  [field.name, ...fieldDetails(field)].join("\n");
