from pathlib import Path

import anyio
import pytest

from inspect_ai.log import read_eval_log
from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageUser,
    ContentReasoning,
    ContentText,
    ModelName,
)
from inspect_ai.scorer import Score, Target
from inspect_ai.solver import TaskState

from .. import (
    TEXT_ANNOTATIONS_KEY,
    AnnotationLayer,
    CategoricalField,
    Span,
    TextAnnotations,
    TextRange,
    binary_question,
    classifier_annotator,
    find_spans,
    paragraphs,
    text_annotations,
    tokens,
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
from .make_demo import make_demo
from .make_table_fixture import FIXTURE_DIR, SAMPLE_FILE, SPANS_FILE, table_fixture

PROBES = [fake.probe for fake in FAKE_PROBES]
TOKENS = find_spans(tokens())


def make_state(messages: list[ChatMessage]) -> TaskState:
    return TaskState(
        model=ModelName("mockllm/model"),
        sample_id="sample-1",
        epoch=2,
        input="Go.",
        messages=messages,
    )


def labels_of(question: CategoricalField, paragraph_count: int) -> list[str]:
    """`random_classifier`'s labels for `question` on a reasoning of many paragraphs."""
    reasoning = "\n\n".join(f"Paragraph {index}." for index in range(paragraph_count))
    state = make_state(
        [ChatMessageAssistant(id="m1", content=[ContentReasoning(reasoning=reasoning)])]
    )
    scorer = text_annotations(
        "paragraph labels",
        [question],
        classifier_annotator(find_spans(paragraphs), random_classifier("seed")),
        source="random",
        unit="paragraph",
    )
    score: Score | None = anyio.run(scorer, state, Target(""))
    assert score is not None
    annotations = TextAnnotations.model_validate(
        (score.metadata or {})[TEXT_ANNOTATIONS_KEY]
    )
    [layer] = annotations.layers
    return [str(label) for label in layer.parts[0].values[question.name]]


@pytest.mark.parametrize(
    "question",
    [
        binary_question("suspects_test", positive="1", negative="0"),
        binary_question("found", positive="present", negative="absent"),
        binary_question("first_is_negative", positive="no", negative="yes"),
    ],
)
def test_random_classifier_gives_the_positive_answer_at_yes_rate(
    question: CategoricalField,
) -> None:
    labels = labels_of(question, 400)
    positive = question.options[0]
    # position weights would make the first option two-thirds likely
    assert 0 < labels.count(positive) / len(labels) < 0.25


def test_random_classifier_uses_position_weights_without_a_negative() -> None:
    labels = labels_of(CategoricalField(name="flag", options=["yes", "no"]), 400)
    assert labels.count("yes") / len(labels) > 0.5


def test_keyword_pattern_matches_word_stems() -> None:
    text = "Evaluation, being  checked, a contest, TESTING, scores; protest"
    matches = [m.group() for m in EVAL_AWARENESS_KEYWORDS.finditer(text)]
    assert matches == ["Evaluation", "being  checked", "TESTING", "scores"]


def test_keyword_boost_decays_after_keyword() -> None:
    text = "a test b c d e f g h"
    offsets = tokens()(text)
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
    spans = TOKENS(state.messages)
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
    state = make_state(
        [
            ChatMessageUser(id="u1", content="Translate the memo. A grader checks it."),
            ChatMessageAssistant(
                id="a1",
                content=[
                    ContentReasoning(reasoning="Is this a test? 🎉 Maybe."),
                    ContentText(text="I'll read the file."),
                ],
            ),
        ]
    )
    spans = TOKENS(state.messages)
    runner = fake_probe_runner("seed")
    values = anyio.run(runner, spans, PROBES, state)
    by_part: dict[tuple[str, int | None], list[Span]] = {}
    for span in spans:
        by_part.setdefault((span.message_id, span.content_index), []).append(span)
    assert len(by_part) == 3
    reversed_parts = [span for part in reversed(by_part.values()) for span in part]
    reordered = anyio.run(runner, reversed_parts, PROBES, state)
    for name, probe_values in values.items():
        by_span = dict(zip(reversed_parts, reordered[name], strict=True))
        assert [by_span[span] for span in spans] == probe_values


def test_fake_probes_record_their_model_layer() -> None:
    assert [probe.metadata for probe in PROBES] == [
        {"model_layer": 16},
        {"model_layer": 24},
        {"model_layer": 32},
        {"model_layer": 24},
    ]


def test_demo_log_has_both_layers(tmp_path: Path) -> None:
    output = tmp_path / "demo.eval"
    make_demo(output)
    [sample] = read_eval_log(str(output)).samples or []
    layers: dict[str, AnnotationLayer] = {
        name: TextAnnotations.model_validate(
            (score.metadata or {})[TEXT_ANNOTATIONS_KEY]
        ).layers[0]
        for name, score in (sample.scores or {}).items()
    }
    labels, values = layers["paragraph_labels"], layers["probe_values"]
    assert labels.unit == "paragraph" and labels.span_count() == 9
    shortcut = [
        label
        for part in labels.parts
        for label in part.values["kind"]
        if label == "weighing_shortcut"
    ]
    assert shortcut == ["weighing_shortcut"]
    assert values.unit == "token" and values.span_count() > 0
    assert values.metadata == {"tokenizer": "tiktoken/o200k_base"}


def test_table_fixture_is_up_to_date() -> None:
    files = [FIXTURE_DIR / SAMPLE_FILE, FIXTURE_DIR / SPANS_FILE]
    if not all(path.exists() for path in files):
        pytest.skip(
            "The viewer submodule's proto/paragraph-labels branch isn't checked out"
        )
    fixture = table_fixture()
    assert [path.read_bytes() for path in files] == [
        fixture.sample.encode(),
        fixture.spans.encode(),
    ], "Run python -m proto.text_annotations.examples.make_table_fixture"
