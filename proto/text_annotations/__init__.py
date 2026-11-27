"""Annotations of transcript text, stored in scores.

`TextAnnotations` is the format stored in `Score.metadata["text_annotations"]`:
annotation sets of spans of the messages' text, with the value of some
categorical or numeric fields on each span. `text_annotations` is a scorer that
adds one annotation set, with the spans and values an `Annotator` gives.

`find_spans` finds spans: it splits the text parts of the roles and kinds
you choose with a `Splitter` (`paragraphs`, `tokens()` or `whole`).
`classifier_annotator` and `probe_annotator` apply a classifier or a probe
runner to the spans; `binary_question` and `probe_field` make their fields.

`spans_df` reads the annotations of eval logs into a pandas data frame with
one row per span per annotation set per sample, which joins onto `samples_df`
and `messages_df`. `align` puts side by side the fields of annotation sets with
the same spans, and `roll_up` aggregates a set's values over a coarser set's
spans.

Fakes and example scripts are in the `examples` subpackage.
"""

from .analysis import (
    CATEGORICAL_FIELDS,
    Aggregation,
    FieldOptions,
    align,
    roll_up,
    spans_df,
)
from .annotations import (
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationField,
    AnnotationSet,
    CategoricalField,
    ContentType,
    NumericField,
    Role,
    TextAnnotations,
    TextPart,
    TextRange,
    check_spans_fit,
    set_texts,
    text_parts,
)
from .classifiers import (
    Classifier,
    SpanProbabilities,
    binary_question,
    classifier_annotator,
)
from .probes import ProbeRunner, probe_annotator, probe_field
from .scorer import (
    ANNOTATION_METRICS,
    AnnotatedSpan,
    Annotator,
    annotation_score,
    text_annotations,
)
from .spans import (
    PARAGRAPH_BREAK,
    Span,
    SpanFinder,
    Splitter,
    find_spans,
    paragraphs,
    span_texts,
    tokens,
    whole,
)

__all__ = [
    "ANNOTATION_METRICS",
    "CATEGORICAL_FIELDS",
    "PARAGRAPH_BREAK",
    "TEXT_ANNOTATIONS_KEY",
    "AnnotatedPart",
    "Aggregation",
    "AnnotatedSpan",
    "AnnotationField",
    "AnnotationSet",
    "Annotator",
    "CategoricalField",
    "Classifier",
    "ContentType",
    "FieldOptions",
    "NumericField",
    "ProbeRunner",
    "Role",
    "Span",
    "SpanFinder",
    "SpanProbabilities",
    "Splitter",
    "TextAnnotations",
    "TextPart",
    "TextRange",
    "align",
    "annotation_score",
    "binary_question",
    "check_spans_fit",
    "classifier_annotator",
    "find_spans",
    "paragraphs",
    "probe_annotator",
    "probe_field",
    "roll_up",
    "set_texts",
    "span_texts",
    "spans_df",
    "text_annotations",
    "text_parts",
    "tokens",
    "whole",
]
