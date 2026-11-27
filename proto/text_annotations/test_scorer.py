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
    AnnotationSet,
    CategoricalField,
    NumericField,
    TextAnnotations,
    TextRange,
    set_texts,
    text_parts,
)
from .classifiers import SpanProbabilities, binary_question, classifier_annotator
from .examples.fake import FAKE_PROBES, fake_probe_runner, random_classifier
from .probes import probe_annotator, probe_field
from .scorer import AnnotatedSpan, text_annotations
from .spans import Span, find_spans, paragraphs, tokens

QUESTIONS = [
    CategoricalField(name="kind", options=["work", "grader", "filler"]),
    binary_question("concealment", description="Hides?"),
]
PROBES = [fake.probe for fake in FAKE_PROBES]
TWO_PROBES = [probe_field("a", model_layer=3), probe_field("b")]
TOKENIZER = {"tokenizer": "tiktoken/o200k_base"}
REASONING_PARAGRAPHS = find_spans(
    paragraphs, roles=["assistant"], content=["reasoning"]
)
TOKENS = find_spans(tokens())


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


def only_set(score: Score) -> AnnotationSet:
    annotations = TextAnnotations.model_validate(
        (score.metadata or {})[TEXT_ANNOTATIONS_KEY]
    )
    [annotation_set] = annotations.sets
    return annotation_set


def set_spans(annotation_set: AnnotationSet) -> list[Span]:
    return [
        Span(part.message_id, part.content_index, start, end)
        for part in annotation_set.parts
        for start, end in part.ranges()
    ]


def paragraph_labels(
    questions: Sequence[CategoricalField], seed: str = "seed"
) -> Scorer:
    return text_annotations(
        "paragraph labels",
        questions,
        classifier_annotator(REASONING_PARAGRAPHS, random_classifier(seed)),
        source="random",
        unit="paragraph",
    )


def token_values(probes: Sequence[NumericField], seed: str = "seed") -> Scorer:
    return text_annotations(
        "probes",
        probes,
        probe_annotator(TOKENS, fake_probe_runner(seed)),
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


def check_labels(
    annotation_set: AnnotationSet, questions: Sequence[CategoricalField]
) -> None:
    """Each label is its span's most probable option, the earliest one on ties."""
    for part in annotation_set.parts:
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

    annotation_set = only_set(first)
    assert (
        annotation_set.name,
        annotation_set.unit,
        annotation_set.source,
        annotation_set.metadata,
    ) == (
        "paragraph labels",
        "paragraph",
        "random",
        {},
    )
    assert annotation_set.fields == QUESTIONS
    [part] = annotation_set.parts
    assert (part.message_id, part.content_index) == ("m1", 0)
    assert part.ranges() == [(0, 7), (10, 14), (17, 23)]
    check_labels(annotation_set, QUESTIONS)

    other = paragraph_labels(QUESTIONS, "other seed")
    assert run(other, state).model_dump() != first.model_dump()


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
        classifier_annotator(REASONING_PARAGRAPHS, classify),
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

    annotation_set = only_set(first)
    assert (
        annotation_set.name,
        annotation_set.unit,
        annotation_set.source,
        annotation_set.metadata,
    ) == (
        "probes",
        "token",
        "fake probes",
        TOKENIZER,
    )
    assert annotation_set.fields == PROBES
    parts = text_parts(state.messages)
    assert [(p.message_id, p.content_index) for p in annotation_set.parts] == [
        (p.message_id, p.content_index) for p in parts
    ]
    token_count = 0
    for annotated, part in zip(annotation_set.parts, parts, strict=True):
        assert annotated.ranges() == tokens()(part.text)
        assert annotated.probabilities == {}
        for probe_values in annotated.values.values():
            assert all(
                isinstance(value, float) and round(value, 3) == value
                for value in probe_values
            )
        token_count += len(annotated.starts)
    assert first.value == token_count
    assert first.explanation == f"{token_count} tokens, 4 fields"

    assert run(token_values(PROBES, "other"), state).model_dump() != first.model_dump()


def test_probe_runner_without_text() -> None:
    state = make_state([ChatMessageAssistant(id="a1", content="")])
    result = run(token_values(PROBES), state)
    assert result.value == 0
    assert result.explanation == "0 tokens, 4 fields"
    assert only_set(result).parts == []


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
        probe_annotator(TOKENS, run_probes),
        source="test",
        unit="token",
    )


def test_probe_annotator_rejects_invalid_results_with_context() -> None:
    state = make_state(transcript())
    spans = len(TOKENS(state.messages))
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
        classifier_annotator(TOKENS, random_classifier("seed")),
        source="random",
        unit="token",
        metadata=TOKENIZER,
    )
    result = run(labelled_tokens, state)
    annotation_set = only_set(result)
    assert set_spans(annotation_set) == TOKENS(state.messages)
    assert result.value == len(TOKENS(state.messages))
    check_labels(annotation_set, QUESTIONS)

    probed_paragraphs = text_annotations(
        "paragraph probes",
        PROBES,
        probe_annotator(REASONING_PARAGRAPHS, fake_probe_runner("seed")),
        source="fake probes",
        unit="paragraph",
    )
    result = run(probed_paragraphs, state)
    annotation_set = only_set(result)
    assert set_spans(annotation_set) == REASONING_PARAGRAPHS(state.messages)
    assert result.explanation == "4 paragraphs, 4 fields"
    for part in annotation_set.parts:
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
    # without a unit, the explanation calls the spans "spans"
    assert result.explanation == "5 spans, 2 fields"
    annotation_set = only_set(result)
    assert (
        annotation_set.unit,
        annotation_set.description,
        annotation_set.metadata,
    ) == (None, "Mixed fields.", {"how": ["by", "hand"]})
    assert [
        (p.message_id, p.content_index, p.ranges()) for p in annotation_set.parts
    ] == [
        ("u1", None, [TextRange(0, 9), TextRange(20, 26)]),
        ("a1", 0, [TextRange(0, 4)]),
        ("a2", 0, [TextRange(0, 5), TextRange(7, 16)]),
    ]
    assert annotation_set.parts[0].values == {
        "kind": ["work", "grader"],
        "score": [1.0, 3.0],
    }
    # probabilities are stored in the order of the field's options
    assert annotation_set.parts[0].probabilities == {"kind": [[0.5, 0.3, 0.2]] * 2}
    assert annotation_set.parts[2].probabilities == {}
    assert len(set_texts(annotation_set, state.messages)) == 3


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
    sets = [only_set(score) for score in scores]
    assert [annotation_set.name for annotation_set in sets] == [
        "paragraph labels",
        "probes",
    ]
    assert [score.value for score in scores] == [
        annotation_set.span_count() for annotation_set in sets
    ]
    labels, values = sets
    assert [(p.message_id, p.content_index) for p in labels.parts] == [
        ("a1", 0),
        ("a2", 0),
    ]
    assert len(values.parts) == 6
    # the viewer reads the annotation sets of every score, so each must fit the messages
    for annotation_set in sets:
        texts = set_texts(annotation_set, state.messages)
        assert len(texts) == len(annotation_set.parts)
    assert scores[0].explanation == "4 paragraphs, 2 fields"


def test_binary_question_marks_its_negative_answer() -> None:
    assert binary_question("suspects", "Suspects a test?").model_dump() == {
        "name": "suspects",
        "description": "Suspects a test?",
        "type": "categorical",
        "options": ["yes", "no"],
        "negative": ["no"],
        "metadata": {},
    }
    question = binary_question("flag", positive="1", negative="0")
    assert (question.options, question.negative) == (["1", "0"], ["0"])
    with pytest.raises(ValidationError, match="repeated options"):
        binary_question("flag", positive="x", negative="x")


def test_probe_field_keeps_its_model_layer_in_metadata() -> None:
    probe = probe_field("p", "A probe.", model_layer=24, metadata={"sae": "x"})
    assert probe.model_dump() == {
        "name": "p",
        "description": "A probe.",
        "type": "numeric",
        "metadata": {"sae": "x", "model_layer": 24},
    }
    assert probe_field("p").metadata == {}
    with pytest.raises(ValueError, match="model layer both as an argument and in"):
        probe_field("p", model_layer=3, metadata={"model_layer": 4})
