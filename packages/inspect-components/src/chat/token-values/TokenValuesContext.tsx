import { createContext, useContext } from "react";

import type { LoadedTokenValues, TokenProbe } from "./tokenValues";

/** Validated token values for the sample on screen and the probe the
 *  legend selected. Absent outside such a sample, so chat views render as
 *  usual. */
export interface TokenValuesView {
  values: LoadedTokenValues;
  probe: TokenProbe;
  /** The magnitude drawn at full colour for `probe` in this sample. */
  scale: number;
}

export const TokenValuesContext = createContext<TokenValuesView | undefined>(
  undefined
);

export const useTokenValues = (): TokenValuesView | undefined =>
  useContext(TokenValuesContext);
