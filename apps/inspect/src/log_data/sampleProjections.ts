import { useQueries, type UseQueryResult } from "@tanstack/react-query";

import type { EvalSample } from "@tsmono/inspect-common/types";
import { AsyncQueue } from "@tsmono/util";

import { useAppConfig } from "../app_config";
import type { SampleHandle } from "../app/types";
import type { ClientAPI } from "../client/api/types";

import { fetchSample } from "./sampleFetch";

/** What to keep of each sample once it has loaded. */
export interface SampleProjection<T> {
  /** Names the projection in the cache, keeping two projections of a
   *  sample apart. */
  name: string;
  project: (sample: EvalSample) => T;
}

export interface ProjectedSample<T> {
  handle: SampleHandle;
  value: T;
}

export interface SampleProjectionError {
  handle: SampleHandle;
  error: Error;
}

export interface SampleProjections<T> {
  /** The samples projected so far, in `handles` order. */
  values: ProjectedSample<T>[];
  /** The samples that failed to load or project, in `handles` order. */
  errors: SampleProjectionError[];
  /** Samples projected or failed so far, of `total`. */
  settled: number;
  total: number;
}

// Samples load a few at a time: a log's worth at once would open dozens of
// range reads together and hold every full sample in memory until it is
// projected.
const kConcurrency = 4;
const queue = new AsyncQueue(kConcurrency);

const sampleProjectionKey = (name: string, handle: SampleHandle) =>
  [
    "log_data",
    "sample-projection",
    name,
    handle.logFile,
    handle.id,
    handle.epoch,
  ] as const;

/**
 * `projection` of each of `handles`' completed samples: a sample is fetched
 * (a few at a time), projected and dropped, so only projections stay in
 * memory. Each is cached per projection, log file and sample, and as a
 * completed sample doesn't change, not fetched again while cached. A sample
 * that fails is reported in `errors`; the others still load.
 */
export const useSampleProjections = <T>(
  handles: readonly SampleHandle[],
  projection: SampleProjection<T>
): SampleProjections<T> => {
  const { api } = useAppConfig();
  return useQueries({
    queries: handles.map((handle) => ({
      queryKey: sampleProjectionKey(projection.name, handle),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        loadProjection(api, handle, projection, signal),
      staleTime: Infinity,
      // Projections can be large (a row per token); comparing a refetch
      // with the cached value would walk all of it.
      structuralSharing: false,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
    combine: (results) => combineProjections(handles, results),
  });
};

const loadProjection = <T>(
  api: ClientAPI,
  handle: SampleHandle,
  projection: SampleProjection<T>,
  signal: AbortSignal
): Promise<T> =>
  queue.enqueue(async () => {
    // A sample still waiting when its query is cancelled (the view closed)
    // isn't fetched.
    signal.throwIfAborted();
    const sample = await fetchSample(
      api,
      handle.logFile,
      handle.id,
      handle.epoch
    );
    return projection.project(sample);
  });

const combineProjections = <T>(
  handles: readonly SampleHandle[],
  results: readonly UseQueryResult<T>[]
): SampleProjections<T> => {
  const values: ProjectedSample<T>[] = [];
  const errors: SampleProjectionError[] = [];
  for (const [i, result] of results.entries()) {
    const handle = handles[i];
    if (!handle) continue;
    if (result.isSuccess) values.push({ handle, value: result.data });
    else if (result.isError) errors.push({ handle, error: result.error });
  }
  return {
    values,
    errors,
    settled: values.length + errors.length,
    total: handles.length,
  };
};
