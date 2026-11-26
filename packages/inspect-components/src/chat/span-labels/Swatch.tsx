import { FC } from "react";

import type { OptionMark } from "./spanLabels";
import styles from "./Swatch.module.css";

/** A colour dot for an option; a ring for hollow marks. */
export const Swatch: FC<{ mark: OptionMark }> = ({ mark }) => (
  <span
    className={styles.swatch}
    style={
      mark.hollow
        ? { border: `2px solid ${mark.color}` }
        : { backgroundColor: mark.color }
    }
  />
);
