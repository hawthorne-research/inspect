# Handoff: paragraph-level labels in Inspect View (prototype)

> **Delete this file once you have picked up the work**, and commit the deletion
> on this branch. It describes the state on 2026-11-26 and will go stale.

## Goal

The goal is a general way to label a transcript at paragraph level (span-level
labels from a classifier such as TypeSafe Jev) and to see those labels in Inspect
View. It came from `~/dev/grader-awareness-eval`, another project, which uses
Jev to label every chain-of-thought paragraph and writes the labels to JSONL
files outside the eval logs.

Status: a working prototype with **random** labels. The user has been iterating
on the visuals.

## Where the code is

Both branches are in the public repo
`https://github.com/hawthorne-research/inspect-paragraph-labels`.

| Branch | Contents | Base |
|---|---|---|
| `proto/paragraph-labels` | inspect_ai: Python prototype in `proto/paragraph_labels/` and this file | upstream `main` at `26f6d0575` |
| `ts-mono/proto/paragraph-labels` | the viewer (the `src/inspect_ai/_view/ts-mono` submodule), commit `7934ac35` | ts-mono `4ed7bf2d`, the commit upstream pins |

The inspect_ai branch does **not** change the submodule's commit (still
`4ed7bf2d`) or `.gitmodules`, so check out the viewer branch by hand (see
Setup). Afterwards `git status` shows the submodule as modified. Don't commit
that change.

On the user's Mac, both branches are already checked out in
`/Users/mo/dev/inspect_ai`.

**The repo is public.** Never commit eval logs, transcripts, `proto_data/`, or
screenshots that show transcript text. The logs are private research data.

## Setup (fresh clone)

```bash
git clone -b proto/paragraph-labels https://github.com/hawthorne-research/inspect-paragraph-labels.git inspect_ai
cd inspect_ai
git submodule update --init src/inspect_ai/_view/ts-mono
git -C src/inspect_ai/_view/ts-mono remote add hawthorne https://github.com/hawthorne-research/inspect-paragraph-labels.git
git -C src/inspect_ai/_view/ts-mono fetch hawthorne ts-mono/proto/paragraph-labels
git -C src/inspect_ai/_view/ts-mono switch -c proto/paragraph-labels hawthorne/ts-mono/proto/paragraph-labels
(cd src/inspect_ai/_view/ts-mono && pnpm install)
uv sync   # needs uv >= 0.13.4
```

To push viewer changes, run
`git -C src/inspect_ai/_view/ts-mono push hawthorne HEAD:ts-mono/proto/paragraph-labels`.

## Test data (local only, git-ignored)

- `proto_data/source/` holds read-only copies (`chmod a-w`) of 13 logs from
  `~/dev/grader-awareness-eval/logs`. Only ever read that directory; another
  agent owns that project.
- `proto_data/labelled/` holds the same logs with a `paragraph_labels` score
  added.

To rebuild both:

```bash
mkdir -p proto_data/source
for f in \
  2026-11-04T19-29-08-00-00_translation_ecb3dd6uwucP7i2YgAXEu8 \
  2026-11-05T14-33-22-00-00_translation_ACTEZb5ARELuF5EoQfNgLK \
  2026-11-05T14-33-22-00-00_translation_JinUdNpeZha4ST8JSDxVgy \
  2026-11-05T14-33-22-00-00_translation_frhxJoA4vMi3pJzJi45Xuk \
  2026-11-05T14-44-50-00-00_translation_c8EDYSFMamqfqtqKDF9Lvp \
  2026-11-05T14-44-50-00-00_translation_doWQyxkytdgLjzisLZWwQ7 \
  2026-11-05T14-45-41-00-00_translation_gCrtax3apaEP9QUK7kCcqt \
  2026-11-06T17-26-47-00-00_maze_Zfy3o9wXwnc7sHbyvx5hVd \
  2026-11-09T18-03-00-00-00_maze_D7jgoHZKLEJaDGBAxPRy7R \
  2026-11-12T18-43-24-00-00_maze_BZ9HWUhYKDFWCxCJnq5nt7 \
  2026-11-12T18-43-24-00-00_maze_nyKwGJrChiykxqwJikuYNr \
  2026-11-12T19-24-23-00-00_maze_J9iiR9xQQ7WZsorWwJpej7 \
  2026-11-12T19-24-23-00-00_maze_boYm6zwXaP5ki3r8mjCw3T; do
  cp -p ~/dev/grader-awareness-eval/logs/$f.eval proto_data/source/
done
chmod a-w proto_data/source/*.eval
.venv/bin/python -m proto.paragraph_labels.make_fake_labels --source proto_data/source --output proto_data/labelled
```

The script takes about 20 s. It checks every written log and confirms the
source files' hashes are unchanged.

## Run the viewer

```bash
.venv/bin/inspect view start --log-dir proto_data/labelled --port 7677 --display plain
cd src/inspect_ai/_view/ts-mono/apps/inspect
pnpm exec vite --config .agents/skills/verify-log-viewer/vite.verify.config.ts   # http://localhost:5179
```

- Port 7575, the `pnpm dev` default, is often taken by the user's own
  `inspect view`.
- **Never run `pnpm build` in ts-mono.** It copies the bundle over
  `src/inspect_ai/_view/dist`, the viewer that ships with Inspect.

Samples worth opening (all sample `guidance`, epoch 1):

- maze `BZ9HWUhY`, 71 paragraphs
- maze `D7jgoHZK` (Qwen), 272 paragraphs; use it to test the strip at scale
- translation `ACTEZb5A`, which has `plans_concealment` chips

## Data format

The labels go in `Score.metadata["span_labels"]` as `SpanLabels` version 0:

```
{version: 0, unit: "paragraph", classifier: str,
 questions: [{name, description, options: [str]}],
 spans: [{message_id, content_index, start, end,
          labels: {question: option},
          probabilities: {question: {option: p}}}]}
```

- `start` and `end` are Unicode code-point offsets into
  `ContentReasoning.reasoning` (or `ContentText.text`). The viewer converts
  them with `Array.from`.
- `Score.value` counts spans per option of the first question.
- Python models: `proto/paragraph_labels/span_labels.py`.
- Viewer parser: `packages/inspect-components/src/chat/span-labels/spanLabels.ts`.

## What's built

**Python** (`proto/paragraph_labels/`):

- `span_labels.py`: the models and the paragraph splitter. It splits on blank
  lines exactly as `grader-awareness-eval/scripts/paragraphs.py` does, checked
  on all 53,779 paragraphs.
- `scorer.py`: the general `@scorer` `span_labels(questions, classify,
  classifier_name)`, and `random_classifier`, which is seeded by sha256 of
  (eval id, sample id, epoch, paragraph index).
- `make_fake_labels.py`: applies the scorer to existing logs with
  `inspect_ai.score(..., action="append", model="mockllm/model")`, then writes
  copies.
- `test_span_labels.py`: the tests.

**Viewer** (ts-mono):

- Labelled reasoning paragraphs show a coloured left border, label chips and a
  hover popover with every question's probability distribution. Labelled
  messages start expanded.
- A **sticky legend** sits above the messages. It shows the classifier, a
  colour-by question selector, and a count for each option; clicking an option
  dims the paragraphs that don't have it.
- A **composition strip** in the legend has one equal-width segment per
  paragraph, in transcript order, with a gap at each message boundary. Hovering
  shows the label and a preview. Clicking scrolls to the paragraph, including
  off-screen virtualized messages, and flashes it.
- Invalid label data falls back to normal rendering and logs a console warning.
- A find-in-page fix in `packages/react` (`MarkdownDiv`, `FindBand`): find
  waits for markdown placeholders to render. It was needed because each
  paragraph is its own markdown block.

## Decisions already made with the user

- Labels are stored in the log as an ordinary sample score, not in a separate
  store.
- A paragraph is text separated by blank lines. Only reasoning parts are
  labelled by default.
- The strip has one segment per paragraph, not per-category blocks. The user
  asked for "a bar with colours … clicking a section goes there", which was read
  as going to a place in the transcript. They haven't objected.

## Open questions for the user (asked, not yet answered)

1. **Real Jev labels instead of random ones.** The files are
   `grader-awareness-eval/logs/reasoning_labels_jev-1.14_*.jsonl`.
   - Rows are keyed by (`log`, `variant` = sample id, `epoch`, `index`).
     `index` is the paragraph's position under the same splitter, so the rows map
     one-to-one onto our spans.
   - The files use **different codebook versions**. For example `1d418585` has
     `suspects_test` yes/no; `maze_4f0562ad` has `test_awareness` with 5
     options; translation labels exist only in the older `91fc7054`.
   - Read each file's questions from its rows, and ask the user which file is
     current.
2. **Narrow windows.** When the 11 `kind` options wrap, the legend grows to
   about 125px. Should options with a zero count be hidden?
3. **Raised earlier, not yet answered:**
   - Score clutter: the per-option counts appear as 11 extra scores in the
     sample header.
   - Chip noise: should each question's "nothing happening" answer be hidden?
     That needs the format to mark a default option. The codebook's per-option
     descriptions would also be worth adding.
   - Colours: 11 kinds but only 8 colours.

## Known limitations

- Labels appear in the Messages tab only, not the Transcript tab. Labels on
  text parts are validated but not drawn.
- One invalid span hides every label in that sample.
- A code fence that spans a blank line renders broken.
- In the paged Messages list, clicking a segment whose message hasn't loaded
  only logs a warning.
- There is no indicator of which paragraphs are on screen.
- The popover can cover the next paragraphs.
- Strip segments can't be reached by keyboard.
- Inspect's epoch reducer copies epoch 1's `span_labels` into
  `log.reductions`. The viewer reads `sample.scores`, so this has no effect.

## Before anything goes upstream

This is not PR-ready. `AGENTS.md` requires an accepted issue first, and new
functionality goes into an extension unless a maintainer agrees otherwise.
Related work:

- inspect_ai issue #2715, "custom transcript views": maintainers agreed in Oct
  2025, with no PR yet.
- Issue #1143, "Log annotation UI".
- PR #4990, the `Reference` model for scanner scores.
- Scout PR `meridianlabs-ai/inspect_scout#714` (`jev_scanner`), closed:
  maintainers said vendor-specific scanners belong in a separate package.

Split the `packages/react` find fix into its own issue or PR, since it also
affects Scout's viewer. To land a ts-mono change, follow
`.agents/skills/land-ts-mono/SKILL.md`.

## How the user works

- They follow the `exploration-mode` skill. Ask design questions 1–3 at a time.
  A strong subagent (Opus 5.5) writes non-trivial code. You read every changed
  line and check the outputs before reporting.
- Use standard terms and plain language. Don't coin new words.
- After a visual change, show screenshots in light and dark themes.
- Never write to `~/dev/grader-awareness-eval`.
