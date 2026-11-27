"""Helpers for giving spans the values of probes run on a model's activations.

A probe is a `NumericField`; `probe_field` makes one, recording the model
layer it reads in the field's metadata. `probe_annotator` gives each span
each probe's value, from any `ProbeRunner` and `SpanFinder`.
"""

from collections.abc import Mapping, Sequence
from typing import Protocol

from pydantic import JsonValue

from inspect_ai.solver import TaskState

from .annotations import CategoricalField, NumericField
from .scorer import AnnotatedSpan, Annotator, describe_sample, fields_of_type
from .spans import Span, SpanFinder

DECIMALS = 3
"""Decimals that `probe_annotator` rounds values to by default."""

MODEL_LAYER = "model_layer"
"""Metadata key of the model layer whose activations a probe reads."""


def probe_field(
    name: str,
    description: str | None = None,
    model_layer: int | None = None,
    metadata: Mapping[str, JsonValue] | None = None,
) -> NumericField:
    """A probe's field, with the model layer it reads in its metadata.

    Args:
        name: Name of the field, e.g. "eval_awareness_L24".
        description: What the probe detects.
        model_layer: Layer of the model whose activations the probe reads,
            stored as `metadata["model_layer"]`.
        metadata: Anything else about the probe.

    Raises:
        ValueError: If `model_layer` is given and `metadata` also has a
            "model_layer".
        ValidationError: If `name` is empty or the metadata isn't JSON.
    """
    field_metadata = dict(metadata or {})
    if model_layer is not None:
        if MODEL_LAYER in field_metadata:
            raise ValueError(
                f"Probe '{name}' has a model layer both as an argument and in its "
                "metadata"
            )
        field_metadata[MODEL_LAYER] = model_layer
    return NumericField(name=name, description=description, metadata=field_metadata)


class ProbeRunner(Protocol):
    """Gives each probe's value on each span."""

    async def __call__(
        self, spans: list[Span], probes: Sequence[NumericField], state: TaskState
    ) -> dict[str, list[float]]:
        """Run the probes over the spans of one sample.

        Args:
            spans: Spans of the sample, in transcript order.
            probes: Probes to run.
            state: State of the sample the spans come from.

        Returns:
            Probe name to its value on each span, in the same order.
        """
        ...


def probe_annotator(
    find_spans: SpanFinder, run_probes: ProbeRunner, decimals: int = DECIMALS
) -> Annotator:
    """Give every span each probe's value.

    The fields are the probes, so all must be numeric. Values are rounded to
    `decimals` decimals, which keeps logs small when there are many spans.
    The probe runner isn't called for a sample without spans.

    Args:
        find_spans: Gives the spans of a sample's messages, e.g.
            `find_spans(tokens())`.
        run_probes: Gives each probe's value on each span.
        decimals: Decimals to round values to.
    """

    async def annotate(
        state: TaskState, fields: Sequence[CategoricalField | NumericField]
    ) -> list[AnnotatedSpan]:
        sample = describe_sample(state)
        probes = fields_of_type(fields, NumericField, "A probe runner")
        names = [probe.name for probe in probes]
        spans = find_spans(state.messages)
        values = await run_probes(spans, probes, state) if spans else {}
        if spans and set(values) != set(names):
            raise ValueError(
                f"The probe runner gave values of {sorted(values)} for {sample}, "
                f"not of {names}"
            )
        for name, probe_values in values.items():
            if len(probe_values) != len(spans):
                raise ValueError(
                    f"The probe runner gave {len(probe_values)} values of '{name}' "
                    f"for {len(spans)} spans of {sample}"
                )
        return [
            AnnotatedSpan(
                span, {name: round(values[name][index], decimals) for name in names}
            )
            for index, span in enumerate(spans)
        ]

    return annotate
