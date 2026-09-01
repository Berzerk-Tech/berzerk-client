import { useState, type CSSProperties, type SyntheticEvent } from "react";

// Foto da peça no card da separação e nas miniaturas da fila.
//
// Reclamação das separadoras (01/09, Bubble e Blossom): a foto do card
// aparecia "dividida", com duas camisetas cortadas ao meio. A causa é a imagem
// que o catálogo (Shopify) tem pra essas peças — uma composição PAISAGEM com
// frente e costas LADO A LADO num arquivo só. O card é quadrado com
// `object-fit: cover`, então sobra o miolo: metade direita da frente + metade
// esquerda das costas. A Zeus (foto única, em retrato) fica certa pelo mesmo
// motivo.
//
// A correção é de exibição: quando a imagem carregada é paisagem o bastante
// pra ser uma composição, mostramos UMA metade, inteira e centralizada no
// quadro. Fica a metade DIREITA (as costas) porque é onde está a estampa
// grande nessas coleções — na frente só o logo pequeno no peito, que não
// distingue a peça. Retrato e quadrado seguem com o `cover` de sempre.
//
// Nada disso muda o que o Nexus manda; se um dia o catálogo passar a ter a
// foto certa por variante, a detecção simplesmente não dispara.

/** Largura/altura a partir da qual a foto é tratada como composição
 *  "frente | costas". Foto de peça é retrato (~0,77) ou quadrada (1,0);
 *  duas lado a lado dá ~1,5. */
export const RAZAO_COMPOSTA = 1.25;

export function ehComposta(naturalWidth: number, naturalHeight: number): boolean {
  return naturalHeight > 0 && naturalWidth / naturalHeight >= RAZAO_COMPOSTA;
}

export function FotoPeca({
  src,
  style,
  alt = "",
}: {
  src: string;
  /** Caixa da foto (largura/altura/borda/raio). O corte acontece dentro dela. */
  style?: CSSProperties;
  alt?: string;
}) {
  const [composta, setComposta] = useState(false);
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setComposta(ehComposta(img.naturalWidth, img.naturalHeight));
  };
  return (
    <span style={{ ...style, ...caixa }} data-composta={composta || undefined}>
      <img
        src={src}
        alt={alt}
        onLoad={onLoad}
        style={composta ? fotoMetadeDireita : fotoInteira}
        loading="lazy"
        decoding="async"
      />
    </span>
  );
}

const caixa: CSSProperties = {
  display: "block",
  overflow: "hidden",
  boxSizing: "border-box",
};

const fotoInteira: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

/** Foto com o dobro da largura da caixa, deslocada pra esquerda: só a metade
 *  direita fica visível, e o `cover` centraliza a peça na vertical. */
const fotoMetadeDireita: CSSProperties = {
  width: "200%",
  height: "100%",
  marginLeft: "-100%",
  objectFit: "cover",
  display: "block",
};
