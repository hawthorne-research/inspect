import { CSSProperties, FC } from "react";

import type { OptionMark } from "./categorical";
import styles from "./Swatch.module.css";

/** A colour dot for an option (a ring for hollow marks), or a square
 *  chip of a value's background. */
export const Swatch: FC<
  | { mark: OptionMark; fill?: never }
  | { fill: CSSProperties | undefined; mark?: never }
> = ({ mark, fill }) =>
  mark ? (
    <span
      className={styles.dot}
      style={
        mark.hollow
          ? { border: `2px solid ${mark.color}` }
          : { backgroundColor: mark.color }
      }
    />
  ) : (
    <span className={styles.square} style={fill} />
  );
