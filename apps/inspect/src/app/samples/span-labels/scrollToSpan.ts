import type { ChatViewListHandle } from "@tsmono/inspect-components/chat";

// Space between the sticky chrome and the paragraph it lands under.
const kLandingGap = 12;
// About a second of frames: long enough for the rows above the paragraph to
// measure, short enough not to fight a user who starts scrolling.
const kMaxSettleFrames = 60;

interface ScrollToSpanOptions {
  list: ChatViewListHandle;
  scroller: HTMLElement;
  /** Bottom edge of this element is where the paragraph should land. */
  chrome: HTMLElement;
  messageId: string;
  /** The paragraph's `data-span-key`. */
  spanKey: string;
  onLanded: () => void;
}

/**
 * Scrolls the messages list to a labelled paragraph, including one whose
 * message is virtualized off-screen: the list first lands the message's
 * row, then the paragraph is nudged until it sits just below the sticky
 * chrome and stays put (rows above it re-measure as they render). False
 * when no loaded row holds the message.
 */
export const scrollToSpan = ({
  list,
  scroller,
  chrome,
  messageId,
  spanKey,
  onLanded,
}: ScrollToSpanOptions): boolean =>
  list.scrollToMessage(messageId, () => {
    settleParagraph(scroller, chrome, spanKey, onLanded);
  });

const settleParagraph = (
  scroller: HTMLElement,
  chrome: HTMLElement,
  spanKey: string,
  onLanded: () => void
): void => {
  const selector = `[data-span-key="${CSS.escape(spanKey)}"]`;
  let frames = 0;
  let stable = 0;
  const step = () => {
    const paragraph = scroller.querySelector(selector);
    if (paragraph) {
      const target = chrome.getBoundingClientRect().bottom + kLandingGap;
      const delta = paragraph.getBoundingClientRect().top - target;
      const before = scroller.scrollTop;
      if (Math.abs(delta) > 1) scroller.scrollTop = before + delta;
      // Not moving counts as settled, including a paragraph near the end
      // that the scroller can't bring any higher.
      stable = Math.abs(scroller.scrollTop - before) > 0.5 ? 0 : stable + 1;
    }
    frames += 1;
    if (paragraph && stable >= 3) {
      onLanded();
    } else if (frames < kMaxSettleFrames) {
      requestAnimationFrame(step);
    } else if (paragraph) {
      onLanded();
    }
  };
  requestAnimationFrame(step);
};
