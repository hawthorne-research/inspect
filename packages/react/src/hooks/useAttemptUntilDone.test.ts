// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAttemptUntilDone } from "./useAttemptUntilDone";

describe("useAttemptUntilDone", () => {
  it("attempts after each render until an attempt succeeds", () => {
    let ready = false;
    const attempt = vi.fn(() => ready);
    const { rerender } = renderHook(() => useAttemptUntilDone("a", attempt));
    rerender();
    expect(attempt).toHaveBeenCalledTimes(2);

    ready = true;
    rerender();
    rerender();
    rerender();
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("attempts again for a new key, and for the same key after a null one", () => {
    const attempt = vi.fn(() => true);
    const initialProps: { key: string | null } = { key: "a" };
    const { rerender } = renderHook(
      ({ key }) => useAttemptUntilDone(key, attempt),
      { initialProps }
    );
    rerender({ key: "a" });
    expect(attempt).toHaveBeenCalledTimes(1);

    rerender({ key: "b" });
    expect(attempt).toHaveBeenCalledTimes(2);

    rerender({ key: null });
    expect(attempt).toHaveBeenCalledTimes(2);
    rerender({ key: "b" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("calls the attempt of the latest render", () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    const { rerender } = renderHook(
      ({ attempt }: { attempt: () => boolean }) =>
        useAttemptUntilDone("a", attempt),
      { initialProps: { attempt: first } }
    );
    rerender({ attempt: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
