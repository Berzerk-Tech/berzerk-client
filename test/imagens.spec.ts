import { describe, expect, it } from "vitest";
import { imagemRedimensionada, miniatura } from "../src/lib/imagens";

const ORIGINAL =
  "https://cdn.shopify.com/s/files/1/0653/3975/2616/files/RESSURECTED.jpg?v=1772119324";

describe("imagemRedimensionada", () => {
  it("acrescenta width mantendo o ?v= do CDN da Shopify", () => {
    expect(imagemRedimensionada(ORIGINAL, 400)).toBe(
      "https://cdn.shopify.com/s/files/1/0653/3975/2616/files/RESSURECTED.jpg?v=1772119324&width=400",
    );
  });

  it("usa ? quando a URL não tem query", () => {
    expect(imagemRedimensionada("https://cdn.shopify.com/a/b.jpg", 1000)).toBe(
      "https://cdn.shopify.com/a/b.jpg?width=1000",
    );
  });

  it("não mexe em URL que já pede tamanho (width= ou sufixo _NxN)", () => {
    const comWidth = "https://cdn.shopify.com/a/b.jpg?v=1&width=480";
    expect(imagemRedimensionada(comWidth, 1000)).toBe(comWidth);
    const comSufixo = "https://cdn.shopify.com/a/b_800x800.jpg?v=1";
    expect(imagemRedimensionada(comSufixo, 1000)).toBe(comSufixo);
  });

  it("deixa host de fora da Shopify intacto (Tiny/S3 já vem reduzido)", () => {
    const tiny = "https://s3.amazonaws.com/tiny/produtos/foo.jpg";
    expect(imagemRedimensionada(tiny, 400)).toBe(tiny);
  });

  it("cobre os subdomínios do CDN", () => {
    expect(imagemRedimensionada("https://loja.myshopify.com/x.png", 400)).toContain("width=400");
    expect(imagemRedimensionada("https://foo.shopifycdn.net/x.png", 400)).toContain("width=400");
  });

  it("null/vazio/URL inválida não explodem", () => {
    expect(imagemRedimensionada(null, 400)).toBeNull();
    expect(imagemRedimensionada(undefined, 400)).toBeNull();
    expect(imagemRedimensionada("", 400)).toBeNull();
    expect(imagemRedimensionada("/local/foo.jpg", 400)).toBe("/local/foo.jpg");
  });

  it("miniatura usa 400", () => {
    expect(miniatura(ORIGINAL)).toContain("width=400");
  });
});
