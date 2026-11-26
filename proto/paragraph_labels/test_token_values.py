import math
from collections.abc import Sequence
from typing import Any

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
from inspect_ai.scorer import Target
from inspect_ai.solver import TaskState
from inspect_ai.tool import ToolCall

from .span_labels import TextRange
from .token_scorer import (
    DECAY,
    EVAL_AWARENESS_KEYWORDS,
    FAKE_PROBES,
    TOKEN_VALUES_KEY,
    PartValues,
    fake_probe_runner,
    keyword_boost,
    keyword_mask,
    token_values,
)
from .token_values import (
    TextPart,
    TokenProbe,
    TokenValues,
    TokenValuesPart,
    check_covers,
    text_parts,
    token_offsets,
)

PROBES = [fake.probe for fake in FAKE_PROBES]
TWO_PROBES = [TokenProbe(name="a", layer=3), TokenProbe(name="b", description="B")]


@pytest.mark.parametrize(
    "text",
    [
        "",
        "plain ascii",
        "Party 🎉 time! naïve 日本語 x",
        "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 text",
        "family 👨‍👩‍👧 flag 🇬🇧 é \U0010fffd",
        "  \n\n\tindented\r\n<|endoftext|> after",
    ],
)
def test_token_offsets_cover_text_without_empty_tokens(text: str) -> None:
    offsets = token_offsets(text)
    assert "".join(text[start:end] for start, end in offsets) == text
    assert all(start < end for start, end in offsets)
    check_covers(text, offsets)


def test_token_offsets_merge_tokens_of_one_character() -> None:
    # each of these 4-byte characters is split over several tokens
    text = " 𝔘𝔫"
    offsets = token_offsets(text)
    assert offsets == [(0, 1), (1, 2), (2, 3)]


def test_check_covers_rejects_gaps_and_empty_tokens() -> None:
    with pytest.raises(ValueError, match="doesn't start where"):
        check_covers("abcd", [TextRange(0, 1), TextRange(2, 4)])
    with pytest.raises(ValueError, match="is empty"):
        check_covers("abcd", [TextRange(0, 0), TextRange(0, 4)])
    with pytest.raises(ValueError, match="not at the end"):
        check_covers("abcd", [TextRange(0, 3)])


def make_part(**changes: Any) -> dict[str, Any]:
    part: dict[str, Any] = {
        "message_id": "m1",
        "content_index": 0,
        "starts": [0, 3, 7],
        "ends": [3, 6, 9],
        "values": {"a": [0.1, -2.5, 3.0], "b": [0.0, 0.0, 1.25]},
    }
    return part | changes


def make_values(
    *parts: dict[str, Any], probes: Sequence[TokenProbe] = TWO_PROBES
) -> TokenValues:
    return TokenValues.model_validate(
        {
            "tokenizer": "tiktoken/o200k_base",
            "probes": [probe.model_dump() for probe in probes],
            "parts": list(parts),
        }
    )


def test_token_values_round_trip() -> None:
    values = make_values(make_part(), make_part(message_id="m2", content_index=None))
    dumped = values.model_dump()
    assert list(dumped) == ["version", "unit", "tokenizer", "probes", "parts"]
    assert (dumped["version"], dumped["unit"]) == (0, "token")
    assert list(dumped["probes"][0]) == ["name", "description", "layer"]
    assert list(dumped["parts"][0]) == [
        "message_id",
        "content_index",
        "starts",
        "ends",
        "values",
    ]
    assert dumped["parts"][1]["content_index"] is None
    assert TokenValues.model_validate(dumped) == values
    assert TokenValues.model_validate_json(values.model_dump_json()) == values


@pytest.mark.parametrize(
    "part, message",
    [
        (make_part(ends=[3, 6]), "3 starts but 2 ends"),
        (make_part(values={"a": [0.1, 0.2], "b": [0, 0, 0]}), "2 values for the 3"),
        (make_part(starts=[0, 2, 7]), "overlaps or comes before"),
        (make_part(starts=[0, 7, 3], ends=[3, 9, 6]), "overlaps or comes before"),
        (make_part(starts=[0, 3, 7], ends=[3, 3, 9]), "is empty"),
        (make_part(starts=[-1, 3, 7]), "starts before 0"),
        (make_part(content_index=-1), "negative content index"),
        (make_part(values={"a": [0.1, math.nan, 3.0], "b": [0, 0, 0]}), "finite"),
        (make_part(values={"a": [0.1, 0.2, math.inf], "b": [0, 0, 0]}), "finite"),
    ],
)
def test_token_values_part_rejects_invalid_tokens(
    part: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        TokenValuesPart.model_validate(part)


def test_token_values_rejects_invalid_probes_and_parts() -> None:
    with pytest.raises(ValidationError, match="Probes of the part 0 of message m1"):
        make_values(make_part(values={"a": [0.1, 0.2, 0.3]}))
    with pytest.raises(ValidationError, match="Probes of the"):
        make_values(make_part(values={"a": [0, 0, 0], "b": [0, 0, 0], "c": [0, 0, 0]}))
    with pytest.raises(ValidationError, match="repeated"):
        make_values(probes=[TokenProbe(name="a"), TokenProbe(name="a")])
    with pytest.raises(ValidationError, match="at least one probe"):
        make_values(probes=[])
    with pytest.raises(ValidationError, match="empty name"):
        TokenProbe(name="")
    with pytest.raises(ValidationError, match="more than once"):
        make_values(make_part(), make_part())
    with pytest.raises(ValidationError, match="string content of message m1"):
        make_values(make_part(content_index=None), make_part(content_index=None))
    # the same message with and without a content index are different parts
    make_values(make_part(), make_part(content_index=None))


def transcript() -> list[ChatMessage]:
    return [
        ChatMessageSystem(id="s1", content="You are helpful."),
        ChatMessageUser(id="u1", content="Translate the memo. A grader will check it."),
        ChatMessageAssistant(
            id="a1",
            content=[
                ContentReasoning(reasoning="Is this a test? 🎉 Maybe."),
                ContentReasoning(reasoning="encrypted", redacted=True),
                ContentText(text="I'll read the file."),
                ContentText(text=""),
            ],
            tool_calls=[ToolCall(id="c1", function="bash", arguments={"cmd": "ls"})],
        ),
        ChatMessageTool(id="t1", content="memo.txt\n", tool_call_id="c1"),
        ChatMessageAssistant(id="a2", content=""),
    ]


def make_state(messages: list[ChatMessage]) -> TaskState:
    return TaskState(
        model=ModelName("mockllm/model"),
        sample_id="sample-1",
        epoch=2,
        input="Go.",
        messages=messages,
    )


def test_text_parts_in_transcript_order() -> None:
    parts = text_parts(transcript())
    assert [(p.message_id, p.content_index) for p in parts] == [
        ("s1", None),
        ("u1", None),
        ("a1", 0),
        ("a1", 2),
        ("t1", None),
    ]
    assert parts[2].text == "Is this a test? 🎉 Maybe."


def test_text_parts_need_unique_message_ids() -> None:
    messages = transcript()
    messages[3].id = None
    with pytest.raises(ValueError, match="tool message with text has no id"):
        text_parts(messages)
    messages[3].id = "u1"
    with pytest.raises(ValueError, match="same id: u1"):
        text_parts(messages)


def test_scorer_gives_values_for_every_text_part_deterministically() -> None:
    state = make_state(transcript())
    scorer = token_values(PROBES, fake_probe_runner("seed"), "tiktoken/o200k_base")
    first = anyio.run(scorer, state, Target(""))
    second = anyio.run(scorer, state, Target(""))
    assert first is not None and second is not None
    assert first.model_dump() == second.model_dump()

    values = TokenValues.model_validate((first.metadata or {})[TOKEN_VALUES_KEY])
    assert values.probes == PROBES
    assert [(p.message_id, p.content_index) for p in values.parts] == [
        ("s1", None),
        ("u1", None),
        ("a1", 0),
        ("a1", 2),
        ("t1", None),
    ]
    parts = text_parts(state.messages)
    tokens = 0
    for value_part, part in zip(values.parts, parts, strict=True):
        assert [(s, e) for s, e in zip(value_part.starts, value_part.ends)] == [
            tuple(offset) for offset in token_offsets(part.text)
        ]
        for probe_values in value_part.values.values():
            assert all(round(value, 3) == value for value in probe_values)
        tokens += len(value_part.starts)
    assert first.explanation == f"{tokens} tokens, 4 probes"

    assert isinstance(first.value, dict)
    assert list(first.value) == [probe.name for probe in PROBES]
    for probe in PROBES:
        all_values = [v for p in values.parts for v in p.values[probe.name]]
        assert first.value[probe.name] == pytest.approx(sum(all_values) / tokens)

    other = token_values(PROBES, fake_probe_runner("other"), "tiktoken/o200k_base")
    third = anyio.run(other, state, Target(""))
    assert third is not None
    assert third.model_dump() != first.model_dump()


def test_scorer_gives_zero_means_without_text() -> None:
    state = make_state([ChatMessageAssistant(id="a1", content="")])
    scorer = token_values(PROBES, fake_probe_runner(), "tiktoken/o200k_base")
    result = anyio.run(scorer, state, Target(""))
    assert result is not None
    assert result.value == {probe.name: 0.0 for probe in PROBES}
    assert result.explanation == "0 tokens, 4 probes"


class WrongRunner:
    """Gives one value too few for one probe of the last part."""

    async def __call__(
        self, parts: list[TextPart], probes: Sequence[TokenProbe], state: TaskState
    ) -> list[PartValues]:
        results = []
        for part in parts:
            offsets = token_offsets(part.text)
            results.append(
                PartValues(offsets, {p.name: [0.0] * len(offsets) for p in probes})
            )
        results[-1].values["a"].pop()
        return results


class ShortRunner:
    """Gives no results."""

    async def __call__(
        self, parts: list[TextPart], probes: Sequence[TokenProbe], state: TaskState
    ) -> list[PartValues]:
        return []


def test_scorer_rejects_invalid_runner_results_with_context() -> None:
    state = make_state(transcript())
    wrong = token_values(TWO_PROBES, WrongRunner(), "tiktoken/o200k_base")
    with pytest.raises(
        ValueError,
        match="string content of message t1 of sample sample-1 \\(epoch 2\\)",
    ):
        anyio.run(wrong, state, Target(""))
    short = token_values(TWO_PROBES, ShortRunner(), "tiktoken/o200k_base")
    with pytest.raises(
        ValueError, match="0 results for 5 text parts of sample sample-1"
    ):
        anyio.run(short, state, Target(""))
    with pytest.raises(ValidationError, match="repeated"):
        token_values([TokenProbe(name="a")] * 2, ShortRunner(), "tiktoken/o200k_base")


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
    part = TextPart("a1", None, text)
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
