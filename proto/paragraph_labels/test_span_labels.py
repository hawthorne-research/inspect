import anyio
import pytest
from pydantic import ValidationError

from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageUser,
    ContentReasoning,
    ContentText,
    ModelName,
)
from inspect_ai.scorer import Target
from inspect_ai.solver import TaskState

from .scorer import SPAN_LABELS_KEY, random_classifier, span_labels
from .span_labels import (
    PARAGRAPH_BREAK,
    LabelledSpan,
    LabelQuestion,
    SpanLabels,
    message_paragraphs,
    paragraph_ranges,
)

QUESTIONS = [
    LabelQuestion(name="kind", options=["work", "grader", "filler"]),
    LabelQuestion(name="concealment", description="Hides?", options=["yes", "no"]),
]


def reference_split(text: str) -> list[str]:
    return [piece.strip() for piece in PARAGRAPH_BREAK.split(text) if piece.strip()]


def test_paragraph_offsets_with_emoji_and_surrounding_whitespace() -> None:
    text = "\n  First line\nsame paragraph.  \n\n \t\n  Party 🎉 time!\t\n\n\nLast 😀"
    ranges = paragraph_ranges(text)
    assert [text[start:end] for start, end in ranges] == [
        "First line\nsame paragraph.",
        "Party 🎉 time!",
        "Last 😀",
    ]
    # offsets count code points, so each emoji is one character
    assert ranges == [(3, 29), (38, 51), (55, 61)]


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   \n\n  \n",
        "one",
        "a\r\n\r\nb",
        "a\n \nb ",
        "\n\nx\n\n\n\ny\n \n",
        "𝔘𝔫𝔦𝔠𝔬𝔡𝔢\n\n    text 🧪 \n\n",
    ],
)
def test_paragraphs_match_reference_split(text: str) -> None:
    ranges = paragraph_ranges(text)
    assert [text[start:end] for start, end in ranges] == reference_split(text)


def test_message_paragraphs_reads_assistant_parts() -> None:
    assistant = ChatMessageAssistant(
        id="m1",
        content=[
            ContentReasoning(reasoning="Plan.\n\nAct."),
            ContentReasoning(reasoning="secret", redacted=True),
            ContentText(text="Answer.\n\nDone."),
        ],
    )
    messages: list[ChatMessage] = [ChatMessageUser(content="Hi.\n\nThere."), assistant]
    assert [
        (p.content_index, p.start, p.end, p.text) for p in message_paragraphs(messages)
    ] == [
        (0, 0, 5, "Plan."),
        (0, 7, 11, "Act."),
    ]
    both = message_paragraphs(messages, ("reasoning", "text"))
    assert [(p.message_id, p.content_index, p.text) for p in both][2:] == [
        ("m1", 2, "Answer."),
        ("m1", 2, "Done."),
    ]
    assistant.id = None
    with pytest.raises(ValueError, match="no id"):
        message_paragraphs(messages)


def make_span(start: int, end: int, kind: str = "work") -> LabelledSpan:
    return LabelledSpan(
        message_id="m1",
        content_index=0,
        start=start,
        end=end,
        labels={"kind": kind, "concealment": "no"},
        probabilities={
            "kind": {"work": 0.7, "grader": 0.2, "filler": 0.1},
            "concealment": {"yes": 0.05, "no": 0.95},
        },
    )


def test_span_labels_round_trip() -> None:
    labels = SpanLabels(
        unit="paragraph",
        classifier="random",
        questions=QUESTIONS,
        spans=[make_span(0, 5), make_span(7, 11)],
    )
    dumped = labels.model_dump()
    assert list(dumped) == ["version", "unit", "classifier", "questions", "spans"]
    assert dumped["version"] == 0
    assert SpanLabels.model_validate(dumped) == labels
    assert SpanLabels.model_validate_json(labels.model_dump_json()) == labels


def test_span_labels_rejects_invalid_spans() -> None:
    with pytest.raises(ValidationError, match="overlaps"):
        SpanLabels(
            unit="paragraph",
            classifier="random",
            questions=QUESTIONS,
            spans=[make_span(0, 5), make_span(4, 11)],
        )
    with pytest.raises(ValidationError, match="isn't an option"):
        SpanLabels(
            unit="paragraph",
            classifier="random",
            questions=QUESTIONS,
            spans=[make_span(0, 5, kind="other")],
        )
    bad = make_span(0, 5).model_dump()
    bad["probabilities"]["kind"] = {"work": 1.0}
    with pytest.raises(ValidationError, match="not its options"):
        SpanLabels(
            unit="paragraph",
            classifier="random",
            questions=QUESTIONS,
            spans=[LabelledSpan.model_validate(bad)],
        )
    with pytest.raises(ValidationError, match="invalid range"):
        make_span(3, 3)


def test_scorer_labels_paragraphs_deterministically() -> None:
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
    state = TaskState(
        model=ModelName("mockllm/model"),
        sample_id="s1",
        epoch=2,
        input="Go.",
        messages=messages,
    )
    scorer = span_labels(QUESTIONS, random_classifier("seed"), "random")
    first = anyio.run(scorer, state, Target(""))
    second = anyio.run(scorer, state, Target(""))
    assert first is not None and second is not None
    assert first.model_dump() == second.model_dump()
    assert first.explanation == "3 paragraphs labelled by random"
    labels = SpanLabels.model_validate((first.metadata or {})[SPAN_LABELS_KEY])
    assert [(s.start, s.end) for s in labels.spans] == [(0, 7), (10, 14), (17, 23)]
    assert isinstance(first.value, dict)
    assert list(first.value) == ["work", "grader", "filler"]
    assert sum(first.value.values()) == 3
    for span in labels.spans:
        for name, probabilities in span.probabilities.items():
            assert sum(probabilities.values()) == pytest.approx(1.0)
            assert all(round(p, 2) == p for p in probabilities.values())
            assert span.labels[name] == max(
                probabilities, key=probabilities.__getitem__
            )

    other = span_labels(QUESTIONS, random_classifier("other seed"), "random")
    third = anyio.run(other, state, Target(""))
    assert third is not None
    assert third.model_dump() != first.model_dump()


def test_random_classifier_gives_one_at_yes_rate() -> None:
    reasoning = "\n\n".join(f"Paragraph {index}." for index in range(400))
    state = TaskState(
        model=ModelName("mockllm/model"),
        sample_id="s1",
        epoch=1,
        input="Go.",
        messages=[
            ChatMessageAssistant(
                id="m1", content=[ContentReasoning(reasoning=reasoning)]
            )
        ],
    )
    question = LabelQuestion(name="suspects_test", options=["1", "0"])
    scorer = span_labels([question], random_classifier("seed", yes_rate=0.1), "random")
    result = anyio.run(scorer, state, Target(""))
    assert result is not None and isinstance(result.value, dict)
    assert sum(result.value.values()) == 400
    # position weights would make "1" two-thirds likely
    assert 0 < result.value["1"] / 400 < 0.25
