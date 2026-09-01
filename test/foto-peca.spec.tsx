// Foto da peça no card da separação (01/09, Bubble/Blossom).
//
// A imagem dessas peças no catálogo é uma composição paisagem "frente | costas";
// o card quadrado com `cover` mostrava as duas cortadas ao meio. O `FotoPeca`
// detecta a composição pela proporção real da imagem carregada e mostra só a
// metade direita (as costas, onde está a estampa). Retrato e quadrado seguem
// inteiros.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FotoPeca, ehComposta } from "../src/components/FotoPeca";

afterEach(cleanup);

function renderCom(naturalWidth: number, naturalHeight: number) {
  const { container } = render(<FotoPeca src="https://cdn.shopify.com/x.jpg" style={{ width: 100, height: 100 }} />);
  const img = container.querySelector("img")!;
  Object.defineProperty(img, "naturalWidth", { value: naturalWidth, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: naturalHeight, configurable: true });
  fireEvent.load(img);
  return { img, caixa: container.firstElementChild as HTMLElement };
}

describe("ehComposta", () => {
  it("retrato e quadrado não são composição", () => {
    expect(ehComposta(2069, 2688)).toBe(false); // Zeus
    expect(ehComposta(720, 960)).toBe(false);
    expect(ehComposta(1000, 1000)).toBe(false);
  });
  it("frente + costas lado a lado é composição", () => {
    expect(ehComposta(1540, 1000)).toBe(true);
    expect(ehComposta(2000, 1000)).toBe(true);
  });
  it("sem dimensões (ainda não carregou) não é composição", () => {
    expect(ehComposta(0, 0)).toBe(false);
  });
});

describe("FotoPeca", () => {
  it("foto em retrato ocupa a caixa inteira com cover", () => {
    const { img, caixa } = renderCom(720, 960);
    expect(img.style.width).toBe("100%");
    expect(img.style.marginLeft).toBe("");
    expect(caixa.dataset.composta).toBeUndefined();
  });

  it("composição paisagem mostra só a metade direita, centralizada", () => {
    const { img, caixa } = renderCom(1540, 1000);
    expect(img.style.width).toBe("200%");
    expect(img.style.marginLeft).toBe("-100%");
    expect(img.style.objectFit).toBe("cover");
    expect(caixa.style.overflow).toBe("hidden");
    expect(caixa.dataset.composta).toBe("true");
  });

  it("a caixa herda o tamanho passado pelo card", () => {
    const { caixa } = renderCom(720, 960);
    expect(caixa.style.width).toBe("100px");
    expect(caixa.style.height).toBe("100px");
  });
});
