import math
import re
from collections.abc import Sequence

import anyio
import pytest
from pydantic import ValidationError

from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageSystem,
    ChatMessageTool,
    ChatMessageUser,
    ContentReasoning,
    ContentText,
    ModelName,
)
from inspect_ai.scorer import Score, Scorer, Target
from inspect_ai.solver import TaskState
from inspect_ai.tool import ToolCall

from .annotations import (
    TEXT_ANNOTATIONS_KEY,
    AnnotationLayer,
    CategoricalField,
    NumericField,
    TextAnnotations,
    TextRange,
    layer_texts,
    text_parts,
)
from .annotators import (
    SpanProbabilities,
    classifier_annotator,
    probe_annotator,
)
from .fake import (
    DECAY,
    EVAL_AWARENESS_KEYWORDS,
    FAKE_PROBES,
    fake_probe_runner,
    keyword_boost,
    keyword_mask,
    random_classifier,
)
from .scorer import AnnotatedSpan, text_annotations
from .spans import Span, paragraph_spans, token_offsets, token_spans

QUESTIONS = [
    CategoricalField(name="kind", options=["work", "grader", "filler"]),
    CategoricalField(name="concealment", description="Hides?", options=["yes", "no"]),
]
PROBES = [fake.probe for fake in FAKE_PROBES]
TWO_PROBES = [NumericField(name="a", model_layer=3), NumericField(name="b")]
TOKENIZER = {"tokenizer": "tiktoken/o200k_base"}


def make_state(messages: list[ChatMessage]) -> TaskState:
    return TaskState(
        model=ModelName("mockllm/model"),
        sample_id="sample-1",
        epoch=2,
        input="Go.",
        messages=messages,
    )


def run(scorer: Scorer, state: TaskState) -> Score:
    result = anyio.run(scorer, state, Target(""))
    assert result is not None
    return result


def only_layer(score: Score) -> AnnotationLayer:
    annotations = TextAnnotations.model_validate(
        (score.metadata or {})[TEXT_ANNOTATIONS_KEY]
    )
    [layer] = annotations.layers
    return layer


def layer_spans(layer: AnnotationLayer) -> list[Span]:
    return [
        Span(part.message_id, part.content_index, start, end)
        for part in layer.parts
        for start, end in part.ranges()
    ]


def paragraph_labels(
    questions: Sequence[CategoricalField], seed: str = "seed"
) -> Scorer:
    return text_annotations(
        "paragraph labels",
        questions,
        classifier_annotator(paragraph_spans, random_classifier(seed)),
        source="random",
        unit="paragraph",
    )


def token_values(probes: Sequence[NumericField], seed: str = "seed") -> Scorer:
    return text_annotations(
        "probes",
        probes,
        probe_annotator(token_spans, fake_probe_runner(seed)),
        source="fake probes",
        unit="token",
        metadata=TOKENIZER,
    )


def transcript() -> list[ChatMessage]:
    return [
        ChatMessageSystem(id="s1", content="You are helpful."),
        ChatMessageUser(id="u1", content="Translate the memo. A grader will check it."),
        ChatMessageAssistant(
            id="a1",
            content=[
                ContentReasoning(reasoning="Is this a test? 🎉 Maybe.\n\nRead it."),
                ContentReasoning(reasoning="encrypted", redacted=True),
                ContentText(text="I'll read the file."),
                ContentText(text=""),
            ],
            tool_calls=[ToolCall(id="c1", function="bash", arguments={"cmd": "ls"})],
        ),
        ChatMessageTool(id="t1", content="memo.txt\n", tool_call_id="c1"),
        ChatMessageAssistant(
            id="a2", content=[ContentReasoning(reasoning="Done.\n\n\nAnswer it.")]
        ),
    ]


def check_labels(layer: AnnotationLayer, questions: Sequence[CategoricalField]) -> None:
    """Each label is its span's most probable option, the earliest one on ties."""
    for part in layer.parts:
        for question in questions:
            for label, probabilities in zip(
                part.values[question.name],
                part.probabilities[question.name],
                strict=True,
            ):
                assert sum(probabilities) == pytest.approx(1.0)
                assert all(round(p, 2) == p for p in probabilities)
                best = question.options[probabilities.index(max(probabilities))]
                assert label == best


def test_classifier_on_paragraphs_is_deterministic() -> None:
    messages: list[ChatMessage] = [
        ChatMessageUser(content="Go."),
        ChatMessageAssistant(
            id="m1",
            content=[
                ContentReasoning(reasoning="Plan 🎉.\n\n\nAct.\n \nCheck."),
                ContentText(text="Done."),
            ],
        ),
    ]
    state = make_state(messages)
    scorer = paragraph_labels(QUESTIONS)
    first = run(scorer, state)
    second = run(scorer, state)
    assert first.model_dump() == second.model_dump()
    assert first.value == 3
    assert first.explanation == "3 paragraphs, 2 fields"

    layer = only_layer(first)
    assert (layer.name, layer.unit, layer.source, layer.metadata) == (
        "paragraph labels",
        "paragraph",
        "random",
        {},
    )
    assert layer.fields == QUESTIONS
    [part] = layer.parts
    assert (part.message_id, part.content_index) == ("m1", 0)
    assert part.ranges() == [(0, 7), (10, 14), (17, 23)]
    check_labels(layer, QUESTIONS)

    other = paragraph_labels(QUESTIONS, "other seed")
    assert run(other, state).model_dump() != first.model_dump()


def test_random_classifier_gives_one_at_yes_rate() -> None:
    reasoning = "\n\n".join(f"Paragraph {index}." for index in range(400))
    state = make_state(
        [ChatMessageAssistant(id="m1", content=[ContentReasoning(reasoning=reasoning)])]
    )
    question = CategoricalField(name="suspects_test", options=["1", "0"])
    result = run(paragraph_labels([question]), state)
    assert result.value == 400
    labels = only_layer(result).parts[0].values["suspects_test"]
    # position weights would make "1" two-thirds likely
    assert 0 < sum(label == "1" for label in labels) / 400 < 0.25


class MissingOptionClassifier:
    """Leaves out the last option of every question."""

    async def __call__(
        self, texts: list[str], questions: Sequence[CategoricalField], state: TaskState
    ) -> list[SpanProbabilities]:
        return [
            {q.name: {option: 0.5 for option in q.options[:-1]} for q in questions}
            for _ in texts
        ]


class NoClassifier:
    """Gives no results."""

    async def __call__(
        self, texts: list[str], questions: Sequence[CategoricalField], state: TaskState
    ) -> list[SpanProbabilities]:
        return []


def classifier_scorer(
    classify: MissingOptionClassifier | NoClassifier,
    fields: Sequence[CategoricalField | NumericField] = QUESTIONS,
) -> Scorer:
    return text_annotations(
        "labels",
        fields,
        classifier_annotator(paragraph_spans, classify),
        source="test",
        unit="paragraph",
    )


def test_classifier_annotator_rejects_invalid_results_with_context() -> None:
    state = make_state(transcript())
    with pytest.raises(
        ValueError,
        match="span \\[0, 24\\) of the part 0 of message a1 of sample sample-1 "
        "\\(epoch 2\\).*not its options",
    ):
        run(classifier_scorer(MissingOptionClassifier()), state)
    with pytest.raises(ValueError, match="0 results for 4 spans of sample sample-1"):
        run(classifier_scorer(NoClassifier()), state)
    with pytest.raises(ValueError, match="A classifier can't give values of \\['a'\\]"):
        run(classifier_scorer(NoClassifier(), [QUESTIONS[0], TWO_PROBES[0]]), state)
    with pytest.raises(ValidationError, match="repeated"):
        classifier_scorer(NoClassifier(), [QUESTIONS[0]] * 2)


def test_probe_runner_on_tokens_gives_values_for_every_text_part() -> None:
    state = make_state(transcript())
    scorer = token_values(PROBES)
    first = run(scorer, state)
    second = run(scorer, state)
    assert first.model_dump() == second.model_dump()

    layer = only_layer(first)
    assert (layer.name, layer.unit, layer.source, layer.metadata) == (
        "probes",
        "token",
        "fake probes",
        TOKENIZER,
    )
    assert layer.fields == PROBES
    parts = text_parts(state.messages)
    assert [(p.message_id, p.content_index) for p in layer.parts] == [
        (p.message_id, p.content_index) for p in parts
    ]
    tokens = 0
    for annotated, part in zip(layer.parts, parts, strict=True):
        assert annotated.ranges() == token_offsets(part.text)
        assert annotated.probabilities == {}
        for probe_values in annotated.values.values():
            assert all(
                isinstance(value, float) and round(value, 3) == value
                for value in probe_values
            )
        tokens += len(annotated.starts)
    assert first.value == tokens
    assert first.explanation == f"{tokens} tokens, 4 fields"

    assert run(token_values(PROBES, "other"), state).model_dump() != first.model_dump()


def test_probe_runner_without_text() -> None:
    state = make_state([ChatMessageAssistant(id="a1", content="")])
    result = run(token_values(PROBES), state)
    assert result.value == 0
    assert result.explanation == "0 tokens, 4 fields"
    assert only_layer(result).parts == []


class ConstantRunner:
    """Gives every probe `value` on every span, and one value too few for `short`."""

    def __init__(self, value: float = 0.0, short: str | None = None) -> None:
        self.value = value
        self.short = short

    async def __call__(
        self, spans: list[Span], probes: Sequence[NumericField], state: TaskState
    ) -> dict[str, list[float]]:
        values = {probe.name: [self.value] * len(spans) for probe in probes}
        if self.short is not None:
            values[self.short].pop()
        return values


class NoRunner:
    """Gives no values."""

    async def __call__(
        self, spans: list[Span], probes: Sequence[NumericField], state: TaskState
    ) -> dict[str, list[float]]:
        return {}


def probe_scorer(
    run_probes: ConstantRunner | NoRunner,
    fields: Sequence[CategoricalField | NumericField] = TWO_PROBES,
) -> Scorer:
    return text_annotations(
        "probes",
        fields,
        probe_annotator(token_spans, run_probes),
        source="test",
        unit="token",
    )


def test_probe_annotator_rejects_invalid_results_with_context() -> None:
    state = make_state(transcript())
    spans = len(token_spans(state.messages))
    with pytest.raises(
        ValueError,
        match=f"gave {spans - 1} values of 'a' for {spans} spans of sample sample-1",
    ):
        run(probe_scorer(ConstantRunner(short="a")), state)
    with pytest.raises(
        ValueError,
        match="gave values of \\[\\] for sample sample-1 \\(epoch 2\\), not of",
    ):
        run(probe_scorer(NoRunner()), state)
    with pytest.raises(
        ValueError,
        match="(?s)Invalid annotations for the string content of message s1 of "
        "sample sample-1 \\(epoch 2\\).*isn't finite",
    ):
        run(probe_scorer(ConstantRunner(math.nan)), state)
    with pytest.raises(ValueError, match="A probe runner can't give values of"):
        run(probe_scorer(NoRunner(), [*TWO_PROBES, QUESTIONS[0]]), state)
    with pytest.raises(ValidationError, match="repeated"):
        probe_scorer(NoRunner(), [NumericField(name="a")] * 2)


def test_scorer_takes_any_value_type_on_any_spans() -> None:
    state = make_state(transcript())

    labelled_tokens = text_annotations(
        "token labels",
        QUESTIONS,
        classifier_annotator(token_spans, random_classifier("seed")),
        source="random",
        unit="token",
        metadata=TOKENIZER,
    )
    result = run(labelled_tokens, state)
    layer = only_layer(result)
    assert layer_spans(layer) == token_spans(state.messages)
    assert result.value == len(token_spans(state.messages))
    check_labels(layer, QUESTIONS)

    probed_paragraphs = text_annotations(
        "paragraph probes",
        PROBES,
        probe_annotator(paragraph_spans, fake_probe_runner("seed")),
        source="fake probes",
        unit="paragraph",
    )
    result = run(probed_paragraphs, state)
    layer = only_layer(result)
    assert layer_spans(layer) == paragraph_spans(state.messages)
    assert result.explanation == "4 paragraphs, 4 fields"
    for part in layer.parts:
        assert set(part.values) == {probe.name for probe in PROBES}
        assert part.probabilities == {}


class ListAnnotator:
    """Gives the same spans for every sample."""

    def __init__(self, spans: list[AnnotatedSpan]) -> None:
        self.spans = spans

    async def __call__(
        self, state: TaskState, fields: Sequence[CategoricalField | NumericField]
    ) -> list[AnnotatedSpan]:
        return self.spans


KIND = QUESTIONS[0]
SCORE = NumericField(name="score")
MIXED: list[CategoricalField | NumericField] = [KIND, SCORE]
WORK = {"work": 0.5, "filler": 0.2, "grader": 0.3}


def mixed_span(
    span: Span,
    kind: str = "work",
    score: float = 1.0,
    probabilities: dict[str, dict[str, float]] | None = None,
) -> AnnotatedSpan:
    return AnnotatedSpan(
        span,
        {"kind": kind, "score": score},
        {"kind": WORK} if probabilities is None else probabilities,
    )


def mixed_scorer(spans: list[AnnotatedSpan]) -> Scorer:
    return text_annotations(
        "mixed",
        MIXED,
        ListAnnotator(spans),
        source="test",
        unit="span",
        description="Mixed fields.",
        metadata={"how": ["by", "hand"]},
    )


def test_scorer_groups_spans_into_parts_in_transcript_order() -> None:
    state = make_state(transcript())
    spans = [
        mixed_span(Span("a2", 0, 7, 16), "filler", 2.5, {}),
        mixed_span(Span("u1", None, 20, 26), "grader", 3),
        mixed_span(Span("a1", 0, 0, 4), score=-1.0),
        mixed_span(Span("u1", None, 0, 9)),
        mixed_span(Span("a2", 0, 0, 5), "filler", 0.0, {}),
    ]
    result = run(mixed_scorer(spans), state)
    assert result.value == 5
    assert result.explanation == "5 spans, 2 fields"
    layer = only_layer(result)
    assert (layer.description, layer.metadata) == (
        "Mixed fields.",
        {"how": ["by", "hand"]},
    )
    assert [(p.message_id, p.content_index, p.ranges()) for p in layer.parts] == [
        ("u1", None, [TextRange(0, 9), TextRange(20, 26)]),
        ("a1", 0, [TextRange(0, 4)]),
        ("a2", 0, [TextRange(0, 5), TextRange(7, 16)]),
    ]
    assert layer.parts[0].values == {"kind": ["work", "grader"], "score": [1.0, 3.0]}
    # probabilities are stored in the order of the field's options
    assert layer.parts[0].probabilities == {"kind": [[0.5, 0.3, 0.2]] * 2}
    assert layer.parts[2].probabilities == {}
    assert len(layer_texts(layer, state.messages)) == 3


@pytest.mark.parametrize(
    "spans, message",
    [
        (
            [mixed_span(Span("a1", 1, 0, 4))],
            "Spans of sample sample-1 \\(epoch 2\\) are in the part 1 of message a1, "
            "which isn't a text part",
        ),
        (
            [mixed_span(Span("t1", None, 5, 10))],
            "string content of message t1 of sample sample-1 \\(epoch 2\\): The last "
            "span .* ends at 10, past the end of its text \\(9\\)",
        ),
        (
            [mixed_span(Span("u1", None, 0, 9)), mixed_span(Span("u1", None, 5, 12))],
            "string content of message u1 of sample .* overlaps",
        ),
        (
            [mixed_span(Span("u1", None, 3, 3))],
            "string content of message u1 of sample .* is empty",
        ),
        (
            [AnnotatedSpan(Span("u1", None, 0, 9), {"kind": "work"})],
            "Span \\[0, 9\\) has values of \\['kind'\\], not \\['kind', 'score'\\]",
        ),
        (
            [mixed_span(Span("u1", None, 0, 9), kind="other")],
            "Invalid annotations for sample sample-1 \\(epoch 2\\): .*'other'",
        ),
        (
            [mixed_span(Span("u1", None, 0, 9), score=math.inf)],
            "string content of message u1 of sample .* isn't finite",
        ),
        (
            [
                mixed_span(Span("u1", None, 0, 9)),
                mixed_span(Span("u1", None, 10, 12), probabilities={}),
            ],
            "Span \\[10, 12\\) has no probabilities of 'kind', but other spans do",
        ),
        (
            [mixed_span(Span("u1", None, 0, 9), probabilities={"kind": {"work": 1.0}})],
            "Probabilities of 'kind' for span \\[0, 9\\) cover \\['work'\\], not its "
            "options",
        ),
        (
            [mixed_span(Span("u1", None, 0, 9), probabilities={"score": {"x": 1.0}})],
            "probabilities of \\['score'\\], which aren't categorical fields",
        ),
        (
            [
                mixed_span(
                    Span("u1", None, 0, 9),
                    probabilities={"kind": {"work": 0.9, "filler": 0.9, "grader": 0}},
                )
            ],
            "string content of message u1 of sample .* don't sum to 1",
        ),
    ],
)
def test_scorer_rejects_invalid_spans_naming_sample_and_part(
    spans: list[AnnotatedSpan], message: str
) -> None:
    with pytest.raises(ValueError, match=re.compile(message, re.DOTALL)):
        run(mixed_scorer(spans), make_state(transcript()))


def test_both_scorers_on_one_sample_give_two_valid_scores() -> None:
    state = make_state(transcript())
    scores = [run(paragraph_labels(QUESTIONS), state), run(token_values(PROBES), state)]
    layers = [only_layer(score) for score in scores]
    assert [layer.name for layer in layers] == ["paragraph labels", "probes"]
    assert [score.value for score in scores] == [layer.span_count() for layer in layers]
    paragraphs, tokens = layers
    assert [(p.message_id, p.content_index) for p in paragraphs.parts] == [
        ("a1", 0),
        ("a2", 0),
    ]
    assert len(tokens.parts) == 6
    # the viewer reads layers from every score, so each must fit the messages
    for layer in layers:
        texts = layer_texts(layer, state.messages)
        assert len(texts) == len(layer.parts)
    assert scores[0].explanation == "4 paragraphs, 2 fields"


def test_keyword_pattern_matches_word_stems() -> None:
    text = "Evaluation, being  checked, a contest, TESTING, scores; protest"
    matches = [m.group() for m in EVAL_AWARENESS_KEYWORDS.finditer(text)]
    assert matches == ["Evaluation", "being  checked", "TESTING", "scores"]


def test_keyword_boost_decays_after_keyword() -> None:
    text = "a test b c d e f g h"
    offsets = token_offsets(text)
    assert keyword_mask(text, offsets, EVAL_AWARENESS_KEYWORDS) == [
        False,
        True,
        *[False] * 7,
    ]
    boost = keyword_boost(text, offsets, EVAL_AWARENESS_KEYWORDS, 4.0)
    assert boost[:2] == [0.0, 4.0]
    assert boost[2:7] == pytest.approx([4.0 * DECAY**k for k in range(1, 6)])
    assert boost[7:] == [0.0, 0.0]


def test_fake_probe_is_higher_on_keywords() -> None:
    filler = " ".join(f"word{index}" for index in range(30))
    text = " ".join(
        f"{filler} the grader is testing. {filler} we could hide it." for _ in range(20)
    )
    state = make_state([ChatMessageAssistant(id="a1", content=text)])
    spans = token_spans(state.messages)
    offsets = [TextRange(span.start, span.end) for span in spans]
    values = anyio.run(fake_probe_runner("seed"), spans, PROBES, state)
    for fake in FAKE_PROBES:
        mask = keyword_mask(text, offsets, fake.keywords)
        probe_values = values[fake.probe.name]
        on = [v for v, hit in zip(probe_values, mask, strict=True) if hit]
        off = [v for v, hit in zip(probe_values, mask, strict=True) if not hit]
        assert len(on) >= 20
        assert sum(on) / len(on) - sum(off) / len(off) > fake.strength / 2
        # the baseline is negative on average but not everywhere
        assert min(off) < 0 < max(off)


def test_fake_probe_runner_values_of_a_part_depend_only_on_its_spans() -> None:
    state = make_state(transcript())
    spans = token_spans(state.messages)
    runner = fake_probe_runner("seed")
    values = anyio.run(runner, spans, PROBES, state)
    by_part: dict[tuple[str, int | None], list[Span]] = {}
    for span in spans:
        by_part.setdefault((span.message_id, span.content_index), []).append(span)
    reversed_parts = [span for part in reversed(by_part.values()) for span in part]
    reordered = anyio.run(runner, reversed_parts, PROBES, state)
    for name, probe_values in values.items():
        by_span = dict(zip(reversed_parts, reordered[name], strict=True))
        assert [by_span[span] for span in spans] == probe_values
