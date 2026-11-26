import { FC } from "react";

import { formatTokenValue } from "./tokenScale";
import { TokenStrip, type TokenStripBin } from "./TokenStrip";
import { TokenTooltip } from "./TokenTooltip";
import { probeLabel } from "./tokenValues";
import type { TokenValuesView } from "./TokenValuesContext";
import styles from "./TokenValuesLegend.module.css";

interface TokenValuesLegendProps {
  view: TokenValuesView;
  bins: readonly TokenStripBin[];
  onProbeChange: (probe: string) => void;
  onSelectBin: (bin: TokenStripBin) => void;
}

/** Tokenizer summary, probe picker, colour scale and overview strip for a
 *  sample with token values. Also hosts the tokens' shared hover tooltip. */
export const TokenValuesLegend: FC<TokenValuesLegendProps> = ({
  view,
  bins,
  onProbeChange,
  onSelectBin,
}) => {
  const { values, probe, scale } = view;
  return (
    // Find skips the legend: its probe names would shadow the transcript.
    <section
      className={styles.legend}
      aria-label="Token values"
      data-unsearchable
    >
      <div className={styles.header}>
        <span className="text-style-label text-style-secondary">
          Token values
        </span>
        <span className={styles.source}>
          {values.tokenizer} · {values.tokenCount.toLocaleString()}{" "}
          {values.unit}s
        </span>
        <label className={styles.probe} title={probe.description ?? undefined}>
          <span className="text-style-secondary">Probe</span>
          <select
            className={styles.select}
            value={probe.name}
            onChange={(e) => onProbeChange(e.target.value)}
          >
            {values.probes.map((p) => (
              <option
                key={p.name}
                value={p.name}
                title={p.description ?? undefined}
              >
                {probeLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <ColorBar scale={scale} />
      </div>
      <TokenStrip bins={bins} scale={scale} onSelect={onSelectBin} />
      <TokenTooltip view={view} />
    </section>
  );
};

const ColorBar: FC<{ scale: number }> = ({ scale }) =>
  scale > 0 ? (
    <span
      className={styles.colorBar}
      title={`Values at or beyond ±${formatTokenValue(scale)} (the 99th percentile of |value| for this probe) get full colour`}
    >
      <span className={styles.gradient} />
      <span className={styles.ticks}>
        <span>{formatTokenValue(-scale)}</span>
        <span>0</span>
        <span>{formatTokenValue(scale)}</span>
      </span>
    </span>
  ) : (
    <span className={styles.noScale}>all values are 0</span>
  );
