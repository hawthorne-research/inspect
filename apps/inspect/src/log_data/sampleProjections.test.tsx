// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { testEvalSample } from "@tsmono/inspect-common/testing";
import type { EvalSample } from "@tsmono/inspect-common/types";

import { APP_CONFIG_KEY, AppConfig } from "../app_config";
import type { SampleHandle } from "../app/types";
import { testClientAPI } from "../client/api/testClientApi";
import type { ClientAPI } from "../client/api/types";

import {
  useSampleProjections,
  type SampleProjection,
} from "./sampleProjections";

const clientWith = (get_log_sample: ClientAPI["get_log_sample"]) => {
  const client = new QueryClient();
  const config = {
    api: testClientAPI({ get_log_sample }),
    singleFileMode: false,
    loader: "replicator",
    inspect_version: "1.0.0",
    scout_version: null,
    logDir: "/logs",
    absLogDir: "/abs/logs",
  } satisfies AppConfig;
  client.setQueryData(APP_CONFIG_KEY, config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return wrapper;
};

const handles = (count: number): SampleHandle[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    epoch: 1,
    logFile: "a.eval",
  }));

const kIdOf: SampleProjection<string> = {
  name: "id",
  project: (sample) => `${sample.id}/${sample.epoch}`,
};

describe("useSampleProjections", () => {
  it("loads a few samples at a time and keeps only their projections", async () => {
    let inFlight = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    const get_log_sample = (id: string | number, epoch: number) =>
      new Promise<EvalSample>((resolve) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        waiting.push(() => {
          inFlight -= 1;
          resolve(testEvalSample({ id, epoch }));
        });
      });
    const { result } = renderHook(
      () => useSampleProjections(handles(10), kIdOf),
      {
        wrapper: clientWith((_file, id, epoch) => get_log_sample(id, epoch)),
      }
    );

    await waitFor(() => expect(waiting).toHaveLength(4));
    expect(result.current.settled).toBe(0);
    for (let released = 0; released < 10; released++) {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()?.();
    }
    await waitFor(() => expect(result.current.settled).toBe(10));
    expect(most).toBe(4);
    expect(result.current.total).toBe(10);
    expect(result.current.values.map((v) => v.value)).toEqual(
      handles(10).map((h) => `${h.id}/1`)
    );
  });

  it("reports a sample that fails and still loads the others", async () => {
    const { result } = renderHook(
      () => useSampleProjections(handles(3), kIdOf),
      {
        wrapper: clientWith((_file, id, epoch) =>
          id === "s1"
            ? Promise.reject(new Error("range read failed"))
            : Promise.resolve(testEvalSample({ id, epoch }))
        ),
      }
    );
    await waitFor(() => expect(result.current.settled).toBe(3));
    expect(result.current.values.map((v) => v.value)).toEqual(["s0/1", "s2/1"]);
    expect(
      result.current.errors.map(({ handle, error }) => [
        handle.id,
        error.message,
      ])
    ).toEqual([["s1", "range read failed"]]);
  });
});
