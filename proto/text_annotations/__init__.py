"""Annotations of transcript text (paragraph labels, per-token values) stored in scores.

`TextAnnotations` is the format stored in `Score.metadata["text_annotations"]`.
`paragraph_labels` and `token_values` are scorers that each add one layer of
it. `random_classifier` and `fake_probe_runner` make up plausible values for
building viewers and tests.
"""

from .annotations import (
    REASONING,
    TEXT_ANNOTATIONS_KEY,
    AnnotatedPart,
    AnnotationField,
    AnnotationLayer,
    CategoricalField,
    ContentType,
    NumericField,
    TextAnnotations,
    TextPart,
    TextRange,
    check_spans_fit,
    layer_texts,
    text_parts,
)
from .fake import FAKE_PROBES, FakeProbe, fake_probe_runner, random_classifier
from .paragraphs import PARAGRAPH_BREAK, message_paragraphs, paragraph_ranges
from .scorers import (
    ANNOTATION_METRICS,
    PartValues,
    ProbeRunner,
    SpanClassifier,
    SpanProbabilities,
    annotation_score,
    paragraph_labels,
    token_values,
)
from .tokens import token_offsets

__all__ = [
    "ANNOTATION_METRICS",
    "FAKE_PROBES",
    "PARAGRAPH_BREAK",
    "REASONING",
    "TEXT_ANNOTATIONS_KEY",
    "AnnotatedPart",
    "AnnotationField",
    "AnnotationLayer",
    "CategoricalField",
    "ContentType",
    "FakeProbe",
    "NumericField",
    "PartValues",
    "ProbeRunner",
    "SpanClassifier",
    "SpanProbabilities",
    "TextAnnotations",
    "TextPart",
    "TextRange",
    "annotation_score",
    "check_spans_fit",
    "fake_probe_runner",
    "layer_texts",
    "message_paragraphs",
    "paragraph_labels",
    "paragraph_ranges",
    "random_classifier",
    "text_parts",
    "token_offsets",
    "token_values",
]
