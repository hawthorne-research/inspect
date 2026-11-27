"""Annotations of transcript text, stored in scores.

`TextAnnotations` is the format stored in `Score.metadata["text_annotations"]`:
layers of spans of the messages' text, with the value of some categorical or
numeric fields on each span. `text_annotations` is a scorer that adds one
layer, with the spans and values an `Annotator` gives.

`find_spans` finds spans: it splits the text parts of the roles and kinds
you choose with a `Splitter` (`paragraphs`, `tokens()` or `whole`).
`classifier_annotator` and `probe_annotator` apply a classifier or a probe
runner to the spans; `binary_question` and `probe_field` make their fields.

Fakes and example scripts are in the `examples` subpackage.
"""

from .annotations import (
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationField,
    AnnotationLayer,
    CategoricalField,
    ContentType,
    NumericField,
    Role,
    TextAnnotations,
    TextPart,
    TextRange,
    check_spans_fit,
    layer_texts,
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
    "PARAGRAPH_BREAK",
    "TEXT_ANNOTATIONS_KEY",
    "AnnotatedPart",
    "AnnotatedSpan",
    "AnnotationField",
    "AnnotationLayer",
    "Annotator",
    "CategoricalField",
    "Classifier",
    "ContentType",
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
    "annotation_score",
    "binary_question",
    "check_spans_fit",
    "classifier_annotator",
    "find_spans",
    "layer_texts",
    "paragraphs",
    "probe_annotator",
    "probe_field",
    "span_texts",
    "text_annotations",
    "text_parts",
    "tokens",
    "whole",
]
