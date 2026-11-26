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
    TextPart,
    layer_texts,
    text_parts,
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
from .scorers import (
    PartValues,
    SpanProbabilities,
    paragraph_labels,
    token_values,
)
from .tokens import token_offsets

QUESTIONS = [
    CategoricalField(name="kind", options=["work", "grader", "filler"]),
    CategoricalField(name="concealment", description="Hides?", options=["yes", "no"]),
]
PROBES = [fake.probe for fake in FAKE_PROBES]
TWO_PROBES = [NumericField(name="a", model_layer=3), NumericField(name="b")]
TOKENIZER = "tiktoken/o200k_base"


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


def test_paragraph_scorer_labels_paragraphs_deterministically() -> None:
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
    scorer = paragraph_labels(QUESTIONS, random_classifier("seed"), "random")
    first = run(scorer, state)
    second = run(scorer, state)
    assert first.model_dump() == second.model_dump()
    assert first.value == 3
    assert first.explanation == "3 paragraphs, 2 fields"

    layer = only_layer(first)
    assert (layer.name, layer.unit, layer.source, layer.tokenizer) == (
        "paragraph labels",
        "paragraph",
        "random",
        None,
    )
    assert layer.fields == QUESTIONS
    [part] = layer.parts
    assert (part.message_id, part.content_index) == ("m1", 0)
    assert part.ranges() == [(0, 7), (10, 14), (17, 23)]
    for question in QUESTIONS:
        labels = part.values[question.name]
        for label, probabilities in zip(
            labels, part.probabilities[question.name], strict=True
        ):
            assert sum(probabilities) == pytest.approx(1.0)
            assert all(round(p, 2) == p for p in probabilities)
            # the most probable option, the earliest one on ties
            assert label == question.options[probabilities.index(max(probabilities))]

    other = paragraph_labels(QUESTIONS, random_classifier("other seed"), "random")
    assert run(other, state).model_dump() != first.model_dump()


def test_random_classifier_gives_one_at_yes_rate() -> None:
    reasoning = "\n\n".join(f"Paragraph {index}." for index in range(400))
    state = make_state(
        [ChatMessageAssistant(id="m1", content=[ContentReasoning(reasoning=reasoning)])]
    )
    question = CategoricalField(name="suspects_test", options=["1", "0"])
    scorer = paragraph_labels(
        [question], random_classifier("seed", yes_rate=0.1), "random"
    )
    result = run(scorer, state)
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


def test_paragraph_scorer_rejects_invalid_classifier_results_with_context() -> None:
    state = make_state(transcript())
    missing = paragraph_labels(QUESTIONS, MissingOptionClassifier(), "missing")
    with pytest.raises(
        ValueError,
        match="part 0 of message a1 of sample sample-1 \\(epoch 2\\).*not its options",
    ):
        run(missing, state)
    none = paragraph_labels(QUESTIONS, NoClassifier(), "none")
    with pytest.raises(
        ValueError, match="0 results for 4 paragraphs of sample sample-1"
    ):
        run(none, state)
    with pytest.raises(ValidationError, match="repeated"):
        paragraph_labels([QUESTIONS[0]] * 2, NoClassifier(), "none")


def test_token_scorer_gives_values_for_every_text_part_deterministically() -> None:
    state = make_state(transcript())
    scorer = token_values(PROBES, fake_probe_runner("seed"), "fake probes", TOKENIZER)
    first = run(scorer, state)
    second = run(scorer, state)
    assert first.model_dump() == second.model_dump()

    layer = only_layer(first)
    assert (layer.name, layer.unit, layer.source, layer.tokenizer) == (
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

    other = token_values(PROBES, fake_probe_runner("other"), "fake probes", TOKENIZER)
    assert run(other, state).model_dump() != first.model_dump()


def test_token_scorer_without_text() -> None:
    state = make_state([ChatMessageAssistant(id="a1", content="")])
    scorer = token_values(PROBES, fake_probe_runner(), "fake probes", TOKENIZER)
    result = run(scorer, state)
    assert result.value == 0
    assert result.explanation == "0 tokens, 4 fields"
    assert only_layer(result).parts == []


class WrongRunner:
    """Gives one value too few for one probe of the last part."""

    async def __call__(
        self, parts: list[TextPart], probes: Sequence[NumericField], state: TaskState
    ) -> list[PartValues]:
        results = []
        for part in parts:
            offsets = token_offsets(part.text)
            results.append(
                PartValues(offsets, {p.name: [0.0] * len(offsets) for p in probes})
            )
        results[-2].values["a"].pop()
        return results


class ShortRunner:
    """Gives no results."""

    async def __call__(
        self, parts: list[TextPart], probes: Sequence[NumericField], state: TaskState
    ) -> list[PartValues]:
        return []


def test_token_scorer_rejects_invalid_runner_results_with_context() -> None:
    state = make_state(transcript())
    wrong = token_values(TWO_PROBES, WrongRunner(), "wrong", TOKENIZER)
    with pytest.raises(
        ValueError,
        match="string content of message t1 of sample sample-1 \\(epoch 2\\)",
    ):
        run(wrong, state)
    short = token_values(TWO_PROBES, ShortRunner(), "short", TOKENIZER)
    with pytest.raises(
        ValueError, match="0 results for 6 text parts of sample sample-1"
    ):
        run(short, state)
    with pytest.raises(ValidationError, match="repeated"):
        token_values([NumericField(name="a")] * 2, ShortRunner(), "short", TOKENIZER)


def test_both_scorers_on_one_sample_give_two_valid_scores() -> None:
    state = make_state(transcript())
    scores = [
        run(paragraph_labels(QUESTIONS, random_classifier("seed"), "random"), state),
        run(
            token_values(PROBES, fake_probe_runner("seed"), "fake probes", TOKENIZER),
            state,
        ),
    ]
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
    part = TextPart(
        message_id="a1",
        role="assistant",
        content_index=None,
        content_type="text",
        text=text,
    )
    [result] = anyio.run(fake_probe_runner("seed"), [part], PROBES, state)
    for fake in FAKE_PROBES:
        mask = keyword_mask(text, result.offsets, fake.keywords)
        values = result.values[fake.probe.name]
        on = [v for v, hit in zip(values, mask, strict=True) if hit]
        off = [v for v, hit in zip(values, mask, strict=True) if not hit]
        assert len(on) >= 20
        assert sum(on) / len(on) - sum(off) / len(off) > fake.strength / 2
        # the baseline is negative on average but not everywhere
        assert min(off) < 0 < max(off)
