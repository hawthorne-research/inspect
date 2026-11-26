"""Splitting text into tokens with tiktoken, as code-point ranges."""

from collections.abc import Sequence
from itertools import pairwise

import tiktoken

from .annotations import TextRange


def check_covers(text: str, offsets: Sequence[TextRange]) -> None:
    """Check that tokens are non-empty and cover `text` exactly, in order.

    Then `"".join(text[start:end] for start, end in offsets) == text`.

    Raises:
        ValueError: If a token is empty or doesn't start where the one
            before it ends, or the tokens don't start at 0 and end at the
            end of the text.
    """
    position = 0
    for index, (start, end) in enumerate(offsets):
        if start != position or end <= start:
            raise ValueError(
                f"Token {index} [{start}, {end}) is empty or doesn't start where "
                f"the token before it ends ({position})"
            )
        position = end
    if position != len(text):
        raise ValueError(
            f"Tokens end at {position}, not at the end of the text ({len(text)})"
        )


def token_offsets(text: str, encoding_name: str = "o200k_base") -> list[TextRange]:
    """Where each token of `text` lies in it, using a tiktoken encoding.

    tiktoken gives each token the offset of the character its first byte
    belongs to, so when one character is split over several tokens, those
    tokens share a start. They are merged into one token, so that no token
    is empty. Special-token text such as "<|endoftext|>" is encoded as
    ordinary text.

    Args:
        text: Text to tokenise.
        encoding_name: Name of the tiktoken encoding.

    Raises:
        ValueError: If the tokens don't decode to `text` (e.g. it has lone
            surrogates) or don't cover it exactly.
    """
    encoding = tiktoken.get_encoding(encoding_name)
    decoded, starts = encoding.decode_with_offsets(
        encoding.encode(text, disallowed_special=())
    )
    if decoded != text:
        raise ValueError(
            f"Tokens of a text of length {len(text)} decode to a different text"
        )
    bounds = [*dict.fromkeys(starts), len(text)]
    offsets = [TextRange(start, end) for start, end in pairwise(bounds)]
    check_covers(text, offsets)
    return offsets
