import type { ChatViewListHandle } from "@tsmono/inspect-components/chat";

// Space between the sticky chrome and the element it lands under.
const kLandingGap = 12;
// About a second of frames: long enough for the rows above the target to
// measure, short enough not to fight a user who starts scrolling.
const kMaxSettleFrames = 60;

interface ScrollToSpanOptions {
  list: ChatViewListHandle;
  scroller: HTMLElement;
  /** Bottom edge of this element is where the target should land. */
  chrome: HTMLElement;
  messageId: string;
  /** Selects the element to land, within the message's row. */
  selector: string;
  onLanded: (target: Element) => void;
}

/**
 * Scrolls the messages list to an element of a message (a labelled
 * paragraph, a token), including one whose message is virtualized
 * off-screen: the list first lands the message's row, then the element is
 * nudged until it sits just below the sticky chrome and stays put (rows
 * above it re-measure as they render). False when no loaded row holds the
 * message.
 */
export const scrollToSpan = ({
  list,
  scroller,
  chrome,
  messageId,
  selector,
  onLanded,
}: ScrollToSpanOptions): boolean =>
  list.scrollToMessage(messageId, () => {
    settleTarget(scroller, chrome, selector, onLanded);
  });

const settleTarget = (
  scroller: HTMLElement,
  chrome: HTMLElement,
  selector: string,
  onLanded: (target: Element) => void
): void => {
  let frames = 0;
  let stable = 0;
  const step = () => {
    const element = scroller.querySelector(selector);
    if (element) {
      const target = chrome.getBoundingClientRect().bottom + kLandingGap;
      const delta = element.getBoundingClientRect().top - target;
      const before = scroller.scrollTop;
      if (Math.abs(delta) > 1) scroller.scrollTop = before + delta;
      // Not moving counts as settled, including a target near the end
      // that the scroller can't bring any higher.
      stable = Math.abs(scroller.scrollTop - before) > 0.5 ? 0 : stable + 1;
    }
    frames += 1;
    if (element && stable >= 3) {
      onLanded(element);
    } else if (frames < kMaxSettleFrames) {
      requestAnimationFrame(step);
    } else if (element) {
      onLanded(element);
    }
  };
  requestAnimationFrame(step);
};
