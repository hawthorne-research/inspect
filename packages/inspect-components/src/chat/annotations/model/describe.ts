import type { AnnotationField, AnnotationMetadata } from "./format";

/** A number of spans with the layer's unit, e.g. "10,226 tokens". */
export const spanCountLabel = (count: number, unit: string): string =>
  `${count.toLocaleString()} ${count === 1 ? unit : `${unit}s`}`;

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
