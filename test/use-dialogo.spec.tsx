// `useDialogo`: confirm/alert em Promise com o diálogo do app (Etiquetagem,
// 02/09 — os cinco `window.confirm` do BatchBrowser voltavam false calados no
// WebView2, e o `window.alert` era a caixa cinza do Windows).

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { separarTexto, useDialogo } from "../src/lib/useDialogo";
import { mensagemBloqueio, type ResolvedBatch } from "../src/services/batches";

afterEach(cleanup);

let api: ReturnType<typeof useDialogo> | null = null;
function Host() {
  api = useDialogo();
  return <div>{api.dialogo}</div>;
}

describe("separarTexto", () => {
  it("parágrafo em branco separa título de mensagem", () => {
    expect(separarTexto("Descartar o teste do lote 2348?\n\nApaga só os EPCs.")).toEqual({
      titulo: "Descartar o teste do lote 2348?",
      mensagem: "Apaga só os EPCs.",
    });
  });
  it("'Falha ao X: motivo' vira título + mensagem", () => {
    expect(separarTexto("Falha ao voltar 2348 pra fila: 500 Internal")).toEqual({
      titulo: "Falha ao voltar 2348 pra fila",
      mensagem: "500 Internal",
    });
  });
  it("texto simples é só título", () => {
    expect(separarTexto("Credenciais iTAG não configuradas em Settings.")).toEqual({
      titulo: "Credenciais iTAG não configuradas em Settings.",
    });
  });
});

describe("useDialogo", () => {
  it("confirmar: Enter resolve true, Esc resolve false", async () => {
    render(<Host />);
    let p!: Promise<boolean>;
    act(() => { p = api!.confirmar("Movimentar 12 EPCs?\n\nOrigem 1 → destino 2."); });
    expect(screen.getByRole("dialog").textContent).toContain("Movimentar 12 EPCs?");
    act(() => { fireEvent.keyDown(window, { key: "Enter" }); });
    await expect(p).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => { p = api!.confirmar("Cancelar?"); });
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    await expect(p).resolves.toBe(false);
  });

  it("avisar: um botão só, resolve ao fechar", async () => {
    render(<Host />);
    let p!: Promise<void>;
    act(() => { p = api!.avisar("Falha ao descartar teste de 2348: rede caiu"); });
    expect(screen.queryByRole("button", { name: /Cancelar/ })).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("rede caiu");
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Entendi/ })); });
    await expect(p).resolves.toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("mensagemBloqueio", () => {
  const base = {
    batch: { batch_code: "2348", sizes: [] } as unknown as ResolvedBatch["batch"],
    eans: {}, skus: {}, sources: {}, isPrintable: false, catalogColor: null,
  };
  it("consulta falhou: diz que foi a consulta, não o EAN", () => {
    const m = mensagemBloqueio({ ...base, missingSizes: ["P", "M"], motivo: null, catalogTitle: null, erro: "HTTP 503" });
    expect(m.titulo).toContain("consultar o catálogo");
    expect(m.mensagem).toContain("HTTP 503");
  });
  it("sem vínculo: manda vincular o produto", () => {
    const m = mensagemBloqueio({ ...base, missingSizes: ["P", "M"], motivo: "sem_vinculo", catalogTitle: null });
    expect(m.titulo).toBe("Lote 2348 sem produto vinculado");
    expect(m.mensagem).toContain("Vincular produto");
  });
  it("sem EAN: nomeia o produto e os tamanhos", () => {
    const m = mensagemBloqueio({ ...base, missingSizes: ["P", "M", "G"], motivo: "sem_ean", catalogTitle: "Oversized - Zeus" });
    expect(m.titulo).toBe("Lote 2348 sem EAN13 (P, M, G)");
    expect(m.mensagem).toContain("Oversized - Zeus");
    expect(m.mensagem).toContain("P, M, G");
  });
});
