import { describe, expect, it } from "vitest";

import { linearMap, niceDomain, ticks } from "./scales";

describe("niceDomain", () => {
  it.each([
    [
      [0.03, 0.97],
      [0, 1],
    ],
    [
      [0.2, 0.9],
      [0.2, 0.9],
    ],
    [
      [-19.3, -2.1],
      [-20, 0],
    ],
    [
      [3, 3],
      [1.5, 4.5],
    ],
    [
      [0, 0],
      [-0.6, 0.6],
    ],
  ] as const)("widens %j to %j", (domain, expected) => {
    expect(niceDomain(domain)).toEqual(expected);
  });
});

describe("ticks", () => {
  it.each([
    [
      [0, 1],
      [0, 0.2, 0.4, 0.6, 0.8, 1],
    ],
    [
      [-20, 0],
      [-20, -15, -10, -5, 0],
    ],
    [
      [0.2, 0.9],
      [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    ],
  ] as const)("puts round ticks on %j", (domain, expected) => {
    expect(ticks(domain)).toEqual(expected);
  });
});

describe("linearMap", () => {
  it("takes one domain's ends to the other's", () => {
    const map = linearMap([-20, 0], [0, 1]);
    expect(map(-20)).toBe(0);
    expect(map(0)).toBe(1);
    expect(map(-5)).toBe(0.75);
  });
});
