import type { CSSProperties } from "react";
import iconDark from "../assets/brand/icon-dark.png";
import iconLight from "../assets/brand/icon-light.png";

/**
 * Lumberjack oficial da Berzerk (assets da pasta `brand/`, monocromático).
 * A variante certa aparece conforme o tema (`data-theme` no <html>) — regras
 * `.berzerk-logo-*` no index.css.
 */
export function BerzerkLogo({ style }: { style?: CSSProperties }) {
  return (
    <span
      style={{ display: "inline-flex", ...style }}
      role="img"
      aria-label="Berzerk"
    >
      <img src={iconDark} alt="" className="berzerk-logo-dark" style={img} />
      <img src={iconLight} alt="" className="berzerk-logo-light" style={img} />
    </span>
  );
}

const img: CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };
