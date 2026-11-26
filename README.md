# Inspect: Hawthorne Research fork

This is a fork of [Inspect](https://github.com/UKGovernmentBEIS/inspect_ai), the framework for large language model evaluations from the UK AI Security Institute. For Inspect itself, see the [original README](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/README.md) and the [documentation](https://inspect.aisi.org.uk/).

The fork adds **text annotations**: values attached to spans of a transcript's text, stored in the eval log and shown in Inspect View. For example:

- a classifier's labels for each paragraph of a model's reasoning, with the probability of each label;
- per-token values from linear probes, at one or more model layers.

A span is any range of a message's text: a token, a sentence, a paragraph or a whole message. A value is either categorical (one of a list of options) or numeric. Spans of every size are stored and shown the same way.

This is a prototype. The format and the API may change, and none of it is in upstream Inspect.

## What the viewer shows

In a sample's **Messages** tab:

- Annotated messages show their raw text, with each span tinted by its value. Categorical options each get a colour. Numeric values are blue below zero and red above, stronger further from zero; full colour is set automatically at the 99th percentile of |value| in the sample.
- A legend above the messages has a layer picker, a **Color by** picker for the field to colour by, and either the options with their counts (click one to highlight it) or a colour bar. Under it, a strip shows the whole transcript; click a segment to jump to that span.
- Hovering a span shows every field's value, with a bar for each option's probability or for each numeric value.

## Setup

You need [uv](https://docs.astral.sh/uv/) 0.13.4 or later, Node.js 22.13 or later and [pnpm](https://pnpm.io/) 11.

```bash
git clone https://github.com/hawthorne-research/inspect.git
cd inspect
uv sync
```

The viewer changes are on a branch of the viewer submodule (`src/inspect_ai/_view/ts-mono`). The fork doesn't change which submodule commit is checked out, so check that branch out yourself:

```bash
git submodule update --init src/inspect_ai/_view/ts-mono
cd src/inspect_ai/_view/ts-mono
git remote add hawthorne https://github.com/hawthorne-research/inspect.git
git fetch hawthorne ts-mono/proto/paragraph-labels
git switch -c proto/paragraph-labels hawthorne/ts-mono/proto/paragraph-labels
pnpm install
cd -
```

Afterwards `git status` shows the submodule as modified. That is expected.

## View annotated logs

The viewer that `inspect view` serves on its own doesn't have the annotation display yet. Run the viewer from source, next to a log server:

```bash
# Terminal 1: serve your logs on the port the viewer's dev server expects
uv run inspect view start --log-dir path/to/logs --port 7575

# Terminal 2: the viewer
cd src/inspect_ai/_view/ts-mono/apps/inspect
pnpm dev
```

Then open <http://localhost:5173>.

## Add annotations to a log

The Python code is in `proto/text_annotations/`. It isn't part of the installed `inspect_ai` package, so put your scripts in the repository root, or run them from there with `PYTHONPATH=.`, so that `proto` can be imported.

Annotations are added by an ordinary scorer, `text_annotations`, so you can add them during an eval or afterwards to existing logs with `inspect_ai.score`. Each call adds one **layer**: a set of spans with the value of one or more **fields** on each. Its arguments are the layer's name, its fields, an **annotator** that returns the spans with their values, a `source` naming what produced the values, and a `unit` naming what a span is (for display only).

To add more than one layer to a log, give each its own scorer name by wrapping the call in a `@scorer` function, as below. The score's value is the number of spans.

### Label paragraphs with a classifier

`paragraph_spans` splits each assistant message's reasoning into paragraphs (text separated by blank lines). `classifier_annotator` asks your classifier about each one, labels it with the most probable option, and keeps the probabilities.

```python
from inspect_ai.scorer import scorer

from proto.text_annotations import (
    ANNOTATION_METRICS,
    CategoricalField,
    classifier_annotator,
    paragraph_spans,
    text_annotations,
)

QUESTIONS = [
    CategoricalField(
        name="suspects_test",
        description="Does the agent suspect it is being tested?",
        options=["yes", "no"],
    ),
]


async def classify(texts, questions, state):
    # Call your classifier here. Return, for each text, the probability of
    # each option of each question.
    return [{"suspects_test": {"yes": 0.1, "no": 0.9}} for _ in texts]


@scorer(metrics=ANNOTATION_METRICS)
def paragraph_labels():
    return text_annotations(
        "paragraph labels",
        QUESTIONS,
        classifier_annotator(paragraph_spans, classify),
        source="my-classifier",
        unit="paragraph",
    )
```

For a yes/no field, use the options `["yes", "no"]` or `["1", "0"]`: the viewer then tints only "yes" (or "1") paragraphs.

### Per-token probe values computed elsewhere

Probes usually run outside Inspect, on a model's activations. Save each token's position and value, then attach them with your own annotator: a function that returns an `AnnotatedSpan` for each span.

```python
from proto.text_annotations import AnnotatedSpan, NumericField, Span

PROBES = [
    NumericField(
        name="eval_awareness_L32",
        description="Linear probe for evaluation awareness",
        model_layer=32,
    ),
]

# Your saved results, by (sample id, epoch): one row per token.
results = {}


async def saved_probe_values(state, fields):
    return [
        AnnotatedSpan(
            Span(row["message_id"], row["content_index"], row["start"], row["end"]),
            {"eval_awareness_L32": row["value"]},
        )
        for row in results[(state.sample_id, state.epoch)]
    ]


@scorer(metrics=ANNOTATION_METRICS)
def probe_values():
    return text_annotations(
        "probes",
        PROBES,
        saved_probe_values,
        source="my-probes",
        unit="token",
        metadata={"tokenizer": "Qwen/Qwen3-8B"},
    )
```

What each span refers to:

- `message_id` is the message's `id`.
- `content_index` is the index of the part in the message's `content` list, or `None` when the message's content is a plain string.
- `start` and `end` are Unicode code-point offsets (Python string indices) into that part's text: a `ContentText`'s `text`, a `ContentReasoning`'s `reasoning`, or the string content. They are the character offsets a Hugging Face fast tokenizer gives with `return_offsets_mapping=True`, as long as you tokenised that text on its own. If you tokenised the whole chat-formatted conversation, map the offsets back to each part. Tokens the chat template adds have no text in the log and are left out.

A layer can have several fields, for example the same probe at several layers. Every span then needs a value for each.

To run probes inside the scorer instead, `probe_annotator(token_spans, run_probes)` splits every message into tiktoken `o200k_base` tokens and gives your runner the spans.

### Add the annotations to an existing log

```python
from inspect_ai import score
from inspect_ai.log import read_eval_log, write_eval_log

log = read_eval_log("logs/my-run.eval")
log = score(
    log,
    [paragraph_labels(), probe_values()],
    action="append",
    model="mockllm/model",  # these scorers call no model
)
write_eval_log(log, "annotated/my-run.eval")
```

## Stored format

Each scorer stores its layers in `Score.metadata["text_annotations"]`:

```
{
  "version": 0,
  "layers": [
    {
      "name": str, "unit": str, "source": str,
      "description": str | null,
      "metadata": {str: JSON value},
      "fields": [
        {"name": str, "description": str | null, "type": "categorical", "options": [str, ...]},
        {"name": str, "description": str | null, "type": "numeric", "model_layer": int | null}
      ],
      "parts": [
        {
          "message_id": str,
          "content_index": int | null,
          "starts": [int], "ends": [int],
          "values": {field name: [option or number, one per span]},
          "probabilities": {categorical field name: [[one per option, in order], one per span]}
        }
      ]
    }
  ]
}
```

Each part holds the spans in one message part, in order and not overlapping; parts are in transcript order. `probabilities` is optional. The Pydantic models in `proto/text_annotations/annotations.py` check every rule.

## Limitations

- Annotations are shown only in the Messages tab, one layer at a time.
- Tool-call arguments can't be annotated.
- Inspect stores a score's metadata three times in a log (in the sample, in the transcript's score event and in the reductions). Compression removes most of the cost on disk, but token-level layers still make a log several times larger.
- The viewer that `inspect view` serves on its own isn't rebuilt; use the viewer from source as above.

## Branches

- `proto/paragraph-labels` (default): Inspect with `proto/text_annotations/`.
- `ts-mono/proto/paragraph-labels`: the viewer changes, for the `src/inspect_ai/_view/ts-mono` submodule.
