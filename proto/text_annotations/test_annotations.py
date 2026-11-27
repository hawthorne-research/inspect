import math
from collections.abc import Sequence
from typing import Any

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
)
from inspect_ai.tool import ToolCall

from .annotations import (
    AnnotatedPart,
    AnnotationLayer,
    CategoricalField,
    ContentType,
    NumericField,
    Role,
    TextAnnotations,
    TextRange,
    layer_texts,
    text_parts,
)
from .spans import (
    PARAGRAPH_BREAK,
    Span,
    check_covers,
    find_spans,
    paragraphs,
    span_texts,
    tokens,
    whole,
)

KIND = CategoricalField(name="kind", options=["work", "grader", "filler"])
SUSPECTS = CategoricalField(
    name="suspects",
    description="Suspects a test?",
    options=["1", "0"],
    negative=["0"],
    metadata={"codebook": "v2"},
)
PROBE = NumericField(name="probe", description="A probe.", metadata={"model_layer": 3})
FIELDS: list[CategoricalField | NumericField] = [KIND, SUSPECTS, PROBE]
METADATA = {
    "tokenizer": "tiktoken/o200k_base",
    "settings": {"layers": [16, 24], "normalised": True, "scale": 0.5, "note": None},
}


def make_part(**changes: Any) -> dict[str, Any]:
    part: dict[str, Any] = {
        "message_id": "m1",
        "content_index": 0,
        "starts": [0, 3, 7],
        "ends": [3, 6, 9],
        "values": {
            "kind": ["work", "grader", "work"],
            "suspects": ["0", "1", "0"],
            "probe": [0.1, -2.5, 3.0],
        },
        "probabilities": {
            "kind": [[0.7, 0.2, 0.1], [0.1, 0.8, 0.1], [0.5, 0.25, 0.25]],
            "suspects": [[0.1, 0.9], [0.6, 0.4], [0.0, 1.0]],
        },
    }
    return part | changes


def with_values(**changes: list[Any]) -> dict[str, Any]:
    return make_part(values=make_part()["values"] | changes)


def with_probabilities(**changes: list[list[float]]) -> dict[str, Any]:
    return make_part(probabilities=make_part()["probabilities"] | changes)


def make_layer(
    *parts: dict[str, Any],
    fields: Sequence[CategoricalField | NumericField] = FIELDS,
    **changes: Any,
) -> dict[str, Any]:
    layer: dict[str, Any] = {
        "name": "labels",
        "unit": "paragraph",
        "source": "random",
        "metadata": {},
        "description": None,
        "fields": [field.model_dump() for field in fields],
        "parts": list(parts),
    }
    return layer | changes


def make_annotations(*layers: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {"version": 1, "layers": list(layers)} | changes


def test_layer_with_categorical_and_numeric_fields_round_trips() -> None:
    data = make_annotations(
        make_layer(make_part(), make_part(message_id="m2", content_index=None)),
        make_layer(
            make_part(values={"probe": [1, 2, 3]}, probabilities={}),
            name="probes",
            unit="token",
            source="fake probes",
            metadata=METADATA,
            fields=[PROBE],
        ),
    )
    annotations = TextAnnotations.model_validate(data)
    dumped = annotations.model_dump()
    assert list(dumped) == ["version", "layers"]
    assert list(dumped["layers"][0]) == [
        "name",
        "unit",
        "source",
        "metadata",
        "description",
        "fields",
        "parts",
    ]
    assert dumped["layers"][1]["metadata"] == METADATA
    assert dumped["layers"][0]["fields"] == [
        {
            "name": "kind",
            "description": None,
            "type": "categorical",
            "options": ["work", "grader", "filler"],
            "negative": [],
            "metadata": {},
        },
        {
            "name": "suspects",
            "description": "Suspects a test?",
            "type": "categorical",
            "options": ["1", "0"],
            "negative": ["0"],
            "metadata": {"codebook": "v2"},
        },
        {
            "name": "probe",
            "description": "A probe.",
            "type": "numeric",
            "metadata": {"model_layer": 3},
        },
    ]
    assert list(dumped["layers"][0]["parts"][0]) == [
        "message_id",
        "content_index",
        "starts",
        "ends",
        "values",
        "probabilities",
    ]
    # integer values of a numeric field are read as floats
    assert dumped["layers"][1]["parts"][0]["values"] == {"probe": [1.0, 2.0, 3.0]}
    dumped["layers"][1]["parts"][0]["values"] = {"probe": [1, 2, 3]}
    assert dumped == data
    assert TextAnnotations.model_validate(dumped) == annotations
    from_json = TextAnnotations.model_validate_json(annotations.model_dump_json())
    assert from_json == annotations
    # "1" and "0" options stay strings rather than becoming numbers
    assert from_json.layers[0].parts[0].values["suspects"] == ["0", "1", "0"]
    assert [type(field) for field in from_json.layers[0].fields] == [
        CategoricalField,
        CategoricalField,
        NumericField,
    ]
    assert annotations.layers[0].span_count() == 6
    assert annotations.layers[0].parts[0].ranges() == [(0, 3), (3, 6), (7, 9)]


def test_layer_and_field_metadata_and_negative_default_to_empty() -> None:
    layer = make_layer() | {
        "fields": [
            {"name": "kind", "type": "categorical", "options": ["a", "b"]},
            {"name": "probe", "type": "numeric"},
        ]
    }
    del layer["metadata"]
    validated = AnnotationLayer.model_validate(layer)
    assert validated.metadata == {}
    kind, probe = validated.fields
    assert isinstance(kind, CategoricalField)
    assert (kind.description, kind.negative, kind.metadata) == (None, [], {})
    assert (probe.description, probe.metadata) == (None, {})


def test_probabilities_are_optional_for_each_field() -> None:
    without = make_part()
    del without["probabilities"]
    one_field = make_part(message_id="m2")
    del one_field["probabilities"]["suspects"]
    layer = AnnotationLayer.model_validate(make_layer(without, one_field))
    assert layer.parts[0].probabilities == {}
    assert list(layer.parts[1].probabilities) == ["kind"]
    # probabilities may be a little off 1 after rounding
    AnnotatedPart.model_validate(
        with_probabilities(kind=[[0.335, 0.335, 0.335]] * 3, suspects=[[0.5, 0.5]] * 3)
    )


@pytest.mark.parametrize(
    "data, message",
    [
        # spans
        (make_annotations(make_layer(make_part(ends=[3, 6]))), "3 starts but 2 ends"),
        (
            make_annotations(make_layer(make_part(starts=[-1, 3, 7]))),
            "starts before 0",
        ),
        (
            make_annotations(make_layer(make_part(starts=[0, 2, 7]))),
            "overlaps or comes before",
        ),
        (
            make_annotations(make_layer(make_part(starts=[0, 7, 3], ends=[3, 9, 6]))),
            "overlaps or comes before",
        ),
        (
            make_annotations(make_layer(make_part(ends=[3, 3, 9]))),
            "Span 1 \\[3, 3\\) of the part 0 of message m1 is empty",
        ),
        (
            make_annotations(make_layer(make_part(content_index=-1))),
            "negative content index",
        ),
        (
            make_annotations(make_layer(make_part(starts=[0.0, 3, 7]))),
            "valid integer",
        ),
        # values
        (
            make_annotations(make_layer(with_values(kind=["work", "work"]))),
            "Field 'kind' has 2 values for the 3 spans",
        ),
        (
            make_annotations(make_layer(with_values(kind=["work", "other", "work"]))),
            "isn't one of its options",
        ),
        (
            make_annotations(make_layer(with_values(suspects=[0, 1, 0]))),
            "isn't one of its options",
        ),
        (
            make_annotations(make_layer(with_values(probe=["0.1", "0.2", "0.3"]))),
            "aren't numbers",
        ),
        (
            make_annotations(make_layer(with_values(probe=[True, False, True]))),
            "valid",
        ),
        (
            make_annotations(make_layer(with_values(probe=[0.1, math.nan, 3.0]))),
            "finite",
        ),
        (
            make_annotations(make_layer(with_values(probe=[0.1, 0.2, math.inf]))),
            "finite",
        ),
        (
            make_annotations(make_layer(make_part(values={"kind": ["work"] * 3}))),
            "Fields of the part 0 of message m1 are",
        ),
        (
            make_annotations(make_layer(with_values(extra=[0.0, 0.0, 0.0]))),
            "Fields of the part 0 of message m1 are",
        ),
        # probabilities
        (
            make_annotations(make_layer(with_probabilities(kind=[[0.7, 0.2, 0.1]]))),
            "1 probability lists for the 3 spans",
        ),
        (
            make_annotations(
                make_layer(with_probabilities(suspects=[[1.5, -0.5]] * 3))
            ),
            "aren't all in \\[0, 1\\] or don't sum to 1",
        ),
        (
            make_annotations(
                make_layer(with_probabilities(kind=[[0.5, 0.2, 0.1]] * 3))
            ),
            "don't sum to 1",
        ),
        (
            make_annotations(make_layer(with_probabilities(kind=[[0.5, 0.5]] * 3))),
            "one for each of its 3 options",
        ),
        (
            make_annotations(make_layer(with_probabilities(probe=[[1.0]] * 3))),
            "'probe', which isn't a categorical field",
        ),
        (
            make_annotations(make_layer(with_probabilities(extra=[[1.0]] * 3))),
            "'extra', which isn't a categorical field",
        ),
        # fields
        (make_annotations(make_layer(fields=[])), "at least one field"),
        (make_annotations(make_layer(fields=[PROBE, PROBE])), "repeated"),
        (
            make_annotations(
                make_layer(fields=[PROBE.model_copy(update={"name": ""})])
            ),
            "at least 1 character",
        ),
        (
            make_annotations(
                make_layer(fields=[KIND.model_copy(update={"options": ["work"]})])
            ),
            "needs at least two options",
        ),
        (
            make_annotations(
                make_layer(fields=[KIND.model_copy(update={"options": ["a", "a"]})])
            ),
            "repeated options",
        ),
        (
            make_annotations(
                make_layer(fields=[SUSPECTS.model_copy(update={"negative": ["no"]})])
            ),
            "Negative options \\['no'\\] of field 'suspects' aren't among",
        ),
        (
            make_annotations(
                make_layer(
                    fields=[SUSPECTS.model_copy(update={"negative": ["0", "0"]})]
                )
            ),
            "repeated negative options",
        ),
        (
            make_annotations(
                make_layer(
                    fields=[SUSPECTS.model_copy(update={"negative": ["1", "0"]})]
                )
            ),
            "Every option of field 'suspects' is negative",
        ),
        (
            make_annotations(
                make_layer() | {"fields": [{"name": "x", "type": "text"}]}
            ),
            "does not match any of the expected tags",
        ),
        (
            make_annotations(
                make_layer()
                | {"fields": [{"name": "x", "type": "numeric", "model_layer": 3}]}
            ),
            "Extra inputs are not permitted",
        ),
        (
            make_annotations(
                make_layer() | {"fields": [PROBE.model_dump() | {"metadata": None}]}
            ),
            "valid dictionary",
        ),
        # parts and layers
        (
            make_annotations(make_layer(make_part(), make_part())),
            "part 0 of message m1 appears more than once",
        ),
        (
            make_annotations(
                make_layer(make_part(content_index=None), make_part(content_index=None))
            ),
            "string content of message m1 appears more than once",
        ),
        (make_annotations(make_layer(), make_layer()), "Layer names are repeated"),
        (make_annotations(make_layer(name="")), "at least 1 character"),
        (make_annotations(version=0), "Input should be 1"),
        (make_annotations(make_layer(source=None)), "valid string"),
        (make_annotations(make_layer(metadata=None)), "valid dictionary"),
        (make_annotations(make_layer(metadata={"x": {1, 2}})), "metadata.x"),
        (
            make_annotations(make_layer(tokenizer="tiktoken/o200k_base")),
            "Extra inputs are not permitted",
        ),
        (
            make_annotations(make_layer(make_part(probabilites={}))),
            "Extra inputs are not permitted",
        ),
    ],
)
def test_annotations_reject_invalid_data(data: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        TextAnnotations.model_validate(data)


def test_same_message_with_and_without_content_index_are_different_parts() -> None:
    AnnotationLayer.model_validate(
        make_layer(make_part(), make_part(content_index=None))
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
        ChatMessageAssistant(id="a2", content=""),
    ]


def test_text_parts_in_transcript_order() -> None:
    parts = text_parts(transcript())
    assert [p[:4] for p in parts] == [
        ("s1", "system", None, "text"),
        ("u1", "user", None, "text"),
        ("a1", "assistant", 0, "reasoning"),
        ("a1", "assistant", 2, "text"),
        ("t1", "tool", None, "text"),
    ]
    assert parts[2].text == "Is this a test? 🎉 Maybe.\n\nRead it."


def test_text_parts_of_chosen_roles_and_kinds() -> None:
    messages = transcript()

    def keys(
        roles: list[Role] | None, content: list[ContentType]
    ) -> list[tuple[str, int | None]]:
        return [
            (part.message_id, part.content_index)
            for part in text_parts(messages, roles, content)
        ]

    assert keys(["assistant"], ["reasoning"]) == [("a1", 0)]
    assert keys(["assistant"], ["text"]) == [("a1", 2)]
    # string content is text
    assert keys(["user", "tool"], ["reasoning", "text"]) == [("u1", None), ("t1", None)]
    assert keys(None, ["reasoning"]) == [("a1", 0)]
    assert keys([], ["reasoning", "text"]) == []
    # untyped callers can pass anything
    unknown_role: Any = ["bot"]
    unknown_kind: Any = ["reasoning", "image"]
    one_role: Any = "assistant"
    one_kind: Any = "reasoning"
    with pytest.raises(ValueError, match="Unknown roles: \\['bot'\\]"):
        text_parts(messages, unknown_role)
    with pytest.raises(ValueError, match="Unknown content types: \\['image'\\]"):
        text_parts(messages, None, unknown_kind)
    with pytest.raises(TypeError, match="Give roles as a list"):
        text_parts(messages, one_role)
    with pytest.raises(TypeError, match="Give content types as a list"):
        text_parts(messages, None, one_kind)


def test_text_parts_need_unique_message_ids() -> None:
    messages = transcript()
    messages[3].id = None
    with pytest.raises(ValueError, match="tool message with text has no id"):
        text_parts(messages)
    messages[3].id = "u1"
    with pytest.raises(ValueError, match="same id: u1"):
        text_parts(messages)


def spans_of(
    message_id: str, content_index: int | None, ranges: list[tuple[int, int]]
) -> dict[str, Any]:
    return {
        "message_id": message_id,
        "content_index": content_index,
        "starts": [start for start, _ in ranges],
        "ends": [end for _, end in ranges],
        "values": {"probe": [0.0] * len(ranges)},
    }


def test_layer_texts_checks_parts_against_messages() -> None:
    messages = transcript()

    def texts(*parts: dict[str, Any]) -> list[str]:
        layer = AnnotationLayer.model_validate(make_layer(*parts, fields=[PROBE]))
        return layer_texts(layer, messages)

    assert texts(spans_of("u1", None, [(0, 9)]), spans_of("a1", 2, [(0, 4)])) == [
        "Translate the memo. A grader will check it.",
        "I'll read the file.",
    ]
    with pytest.raises(ValueError, match="part 1 of message a1, which isn't a text"):
        texts(spans_of("a1", 1, [(0, 4)]))
    with pytest.raises(ValueError, match="string content of message a2, which isn't"):
        texts(spans_of("a2", None, [(0, 1)]))
    with pytest.raises(ValueError, match="part 0 of message zz, which isn't"):
        texts(spans_of("zz", 0, [(0, 1)]))
    with pytest.raises(ValueError, match="comes before the part before it"):
        texts(spans_of("a1", 2, [(0, 4)]), spans_of("u1", None, [(0, 9)]))
    with pytest.raises(ValueError, match="ends at 99, past the end of its text \\(9"):
        texts(spans_of("t1", None, [(0, 4), (5, 99)]))


def reference_split(text: str) -> list[str]:
    return [piece.strip() for piece in PARAGRAPH_BREAK.split(text) if piece.strip()]


def test_paragraph_offsets_with_emoji_and_surrounding_whitespace() -> None:
    text = "\n  First line\nsame paragraph.  \n\n \t\n  Party 🎉 time!\t\n\n\nLast 😀"
    ranges = paragraphs(text)
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
        "a\n \nb ",
        "\n\nx\n\n\n\ny\n \n",
        "𝔘𝔫𝔦𝔠𝔬𝔡𝔢\n\n    text 🧪 \n\n",
    ],
)
def test_paragraphs_match_reference_split(text: str) -> None:
    ranges = paragraphs(text)
    assert [text[start:end] for start, end in ranges] == reference_split(text)


def test_find_spans_splits_the_chosen_text_parts() -> None:
    assistant = ChatMessageAssistant(
        id="m1",
        content=[
            ContentReasoning(reasoning="Plan.\n\nAct."),
            ContentReasoning(reasoning="secret", redacted=True),
            ContentText(text="Answer.\n\nDone."),
        ],
    )
    messages: list[ChatMessage] = [
        ChatMessageUser(content="Hi.\n\nThere."),
        assistant,
        ChatMessageAssistant(id="m2", content="Plain.\n\nString."),
    ]
    reasoning = find_spans(paragraphs, roles=["assistant"], content=["reasoning"])
    spans = reasoning(messages)
    assert spans == [Span("m1", 0, 0, 5), Span("m1", 0, 7, 11)]
    assert span_texts(spans, messages) == ["Plan.", "Act."]

    def located(spans: list[Span]) -> list[tuple[str, int | None, str]]:
        texts = span_texts(spans, messages)
        return [
            (span.message_id, span.content_index, text)
            for span, text in zip(spans, texts, strict=True)
        ]

    # string content is text
    assert located(find_spans(paragraphs, roles=["assistant"])(messages))[2:] == [
        ("m1", 2, "Answer."),
        ("m1", 2, "Done."),
        ("m2", None, "Plain."),
        ("m2", None, "String."),
    ]
    assert [text for *_, text in located(find_spans(whole)(messages))] == [
        "Hi.\n\nThere.",
        "Plan.\n\nAct.",
        "Answer.\n\nDone.",
        "Plain.\n\nString.",
    ]
    assert find_spans(whole, roles=["tool"])(messages) == []

    messages[0].id = None
    with pytest.raises(ValueError, match="user message with text has no id"):
        reasoning(messages)
    unknown_kind: Any = ["reasoning", "image"]
    with pytest.raises(ValueError, match="Unknown content types: \\['image'\\]"):
        find_spans(paragraphs, content=unknown_kind)


def test_whole_is_one_span_of_a_non_empty_text() -> None:
    assert whole("Party 🎉") == [TextRange(0, 7)]
    assert whole("") == []


@pytest.mark.parametrize(
    "text",
    [
        "",
        "plain ascii",
        "Party 🎉 time! naïve 日本語 x",
        "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 text",
        "family 👨‍👩‍👧 flag 🇬🇧 é \U0010fffd",
        "  \n\n\tindented\r\n<|endoftext|> after",
    ],
)
def test_tokens_cover_text_without_empty_tokens(text: str) -> None:
    offsets = tokens()(text)
    assert "".join(text[start:end] for start, end in offsets) == text
    assert all(start < end for start, end in offsets)
    check_covers(text, offsets)


def test_tokens_merge_tokens_of_one_character() -> None:
    # each of these 4-byte characters is split over several tokens
    text = " 𝔘𝔫"
    offsets = tokens()(text)
    assert offsets == [(0, 1), (1, 2), (2, 3)]


def test_tokens_checks_the_encoding_when_made() -> None:
    with pytest.raises(ValueError, match="Unknown encoding no_such_encoding"):
        tokens("no_such_encoding")


def test_check_covers_rejects_gaps_and_empty_tokens() -> None:
    with pytest.raises(ValueError, match="doesn't start where"):
        check_covers("abcd", [TextRange(0, 1), TextRange(2, 4)])
    with pytest.raises(ValueError, match="is empty"):
        check_covers("abcd", [TextRange(0, 0), TextRange(0, 4)])
    with pytest.raises(ValueError, match="not at the end"):
        check_covers("abcd", [TextRange(0, 3)])


def test_find_spans_tokens_cover_every_text_part_in_order() -> None:
    messages = transcript()
    spans = find_spans(tokens())(messages)
    parts = text_parts(messages)
    keys = [(part.message_id, part.content_index) for part in parts]
    assert list(dict.fromkeys((s.message_id, s.content_index) for s in spans)) == keys
    for key, part in zip(keys, parts, strict=True):
        ranges = [
            (s.start, s.end) for s in spans if (s.message_id, s.content_index) == key
        ]
        assert ranges == tokens()(part.text)
    assert "".join(span_texts(spans, messages)) == "".join(p.text for p in parts)


def test_span_texts_rejects_spans_outside_text_parts() -> None:
    messages = transcript()
    assert span_texts([Span("a1", 0, 16, 17), Span("t1", None, 0, 4)], messages) == [
        "🎉",
        "memo",
    ]
    with pytest.raises(ValueError, match="part 1 of message a1 isn't a text part"):
        span_texts([Span("a1", 1, 0, 1)], messages)
    with pytest.raises(ValueError, match="empty or outside its text of length 9"):
        span_texts([Span("t1", None, 5, 10)], messages)
    with pytest.raises(
        ValueError, match="\\[3, 3\\) of the string content of message t1"
    ):
        span_texts([Span("t1", None, 3, 3)], messages)
