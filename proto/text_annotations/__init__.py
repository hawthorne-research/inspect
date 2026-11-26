"""Annotations of transcript text, stored in scores.

`TextAnnotations` is the format stored in `Score.metadata["text_annotations"]`:
layers of spans of the messages' text, with the value of some categorical or
numeric fields on each span. `text_annotations` is a scorer that adds one
layer, with the spans and values an `Annotator` gives.

`paragraph_spans` and `token_spans` find spans; `classifier_annotator` and
`probe_annotator` apply a classifier or a probe runner to them.
`random_classifier` and `fake_probe_runner` make up plausible values for
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
from .annotators import (
    Classifier,
    ProbeRunner,
    SpanProbabilities,
    classifier_annotator,
    probe_annotator,
)
from .fake import FAKE_PROBES, FakeProbe, fake_probe_runner, random_classifier
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
    paragraph_ranges,
    paragraph_spans,
    span_texts,
    token_offsets,
    token_spans,
)

__all__ = [
    "ANNOTATION_METRICS",
    "FAKE_PROBES",
    "PARAGRAPH_BREAK",
    "REASONING",
    "TEXT_ANNOTATIONS_KEY",
    "AnnotatedPart",
    "AnnotatedSpan",
    "AnnotationField",
    "AnnotationLayer",
    "Annotator",
    "CategoricalField",
    "Classifier",
    "ContentType",
    "FakeProbe",
    "NumericField",
    "ProbeRunner",
    "Span",
    "SpanFinder",
    "SpanProbabilities",
    "TextAnnotations",
    "TextPart",
    "TextRange",
    "annotation_score",
    "check_spans_fit",
    "classifier_annotator",
    "fake_probe_runner",
    "layer_texts",
    "paragraph_ranges",
    "paragraph_spans",
    "probe_annotator",
    "random_classifier",
    "span_texts",
    "text_annotations",
    "text_parts",
    "token_offsets",
    "token_spans",
]
