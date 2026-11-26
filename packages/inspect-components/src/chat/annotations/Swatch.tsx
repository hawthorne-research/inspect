import { CSSProperties, FC } from "react";

import styles from "./Swatch.module.css";

/** A square of a span's background, e.g. beside its value or option. */
export const Swatch: FC<{ fill: CSSProperties | undefined }> = ({ fill }) => (
  <span className={styles.swatch} style={fill} />
);
