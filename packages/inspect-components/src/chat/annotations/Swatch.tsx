import { FC } from "react";

import type { SpanStyle } from "./model";
import styles from "./Swatch.module.css";

/** A square of a span's background, e.g. beside its value or option; empty
 *  without a fill. */
export const Swatch: FC<{ fill: SpanStyle | undefined }> = ({ fill }) => (
  <span className={styles.swatch} style={fill} />
);
