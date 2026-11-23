import type { CSSProperties } from "react";
import { corDaVariante, varianteNumerada } from "../lib/varianteNumerada";

const LADO: Record<"grande" | "medio" | "pequeno", { px: number; fonte: number; raio: number }> = {
  grande: { px: 46, fonte: 32, raio: 8 },
  medio: { px: 28, fonte: 19, raio: 6 },
  pequeno: { px: 20, fonte: 14, raio: 4 },
};

/**
 * Selo quadrado com o número da variante ("Ganley 2" → 2), cor fixa por número.
 * Só exibição; sem variante no nome não renderiza nada.
 * `style` permite posicionar (ex.: absoluto sobre a foto).
 */
export function SeloVariante({
  nome,
  tamanho = "medio",
  style,
}: {
  nome: string | null | undefined;
  tamanho?: "grande" | "medio" | "pequeno";
  style?: CSSProperties;
}) {
  const n = varianteNumerada(nome);
  if (n == null) return null;
  const { fundo, texto } = corDaVariante(n);
  const t = LADO[tamanho];
  return (
    <span
      title={`Variante ${n}`}
      aria-label={`Variante ${n}`}
      data-testid="selo-variante"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: t.px,
        height: t.px,
        borderRadius: t.raio,
        background: fundo,
        color: texto,
        fontWeight: 800,
        fontSize: t.fonte,
        lineHeight: 1,
        fontFamily: "var(--font-sans)",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
        ...style,
      }}
    >
      {n}
    </span>
  );
}
