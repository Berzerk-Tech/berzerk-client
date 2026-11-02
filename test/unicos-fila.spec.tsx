// Modo Únicos (01/11): order bump visível na lista do grupo, volta automática quando a fila
// do tamanho acaba e abertura direta do painel de tamanhos da estampa.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnicosFila } from "../src/components/expedicao/UnicosFila";
import { UnicosGrupos } from "../src/components/expedicao/UnicosGrupos";

const getUnicos = vi.fn();
const getUnicosPedidos = vi.fn();

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    getUnicos: (...a: unknown[]) => getUnicos(...a),
    getUnicosPedidos: (...a: unknown[]) => getUnicosPedidos(...a),
  };
});
vi.mock("../src/services/orders", () => ({ getMe: async () => ({ permissions: [] }) }));

const GRUPO = { estampa: "Baki", tamanho: "G" };
const ped = (id: string, extra: Record<string, unknown> = {}) => ({ id, numero: id, cliente: "Fulana", produtoNome: "Oversized", prioritario: false, ...extra });

describe("UnicosFila", () => {
  beforeEach(() => getUnicosPedidos.mockReset());
  afterEach(() => cleanup());

  it("mostra o order bump na linha e no subtítulo; linha sem bump não mostra", async () => {
    getUnicosPedidos.mockResolvedValue([
      ped("1001", { orderBump: { produtoId: "b", produtoNome: "Touca Berzerk", tamanho: "U" } }),
      ped("1002"),
    ]);
    render(<UnicosFila grupo={GRUPO} versao={0} onTrocar={() => {}} onEsgotou={() => {}} mesaLivre />);
    expect(await screen.findByText("+ Touca Berzerk · U")).toBeTruthy();
    expect(screen.getAllByText(/^\+ Touca Berzerk/)).toHaveLength(1);
    expect(screen.getByText(/2 pedidos na fila · 1 com bump/)).toBeTruthy();
  });

  it("linha mostra tipo, cor e tamanho da peça e o bump com tamanho (sem tamanho, só o nome)", async () => {
    getUnicosPedidos.mockResolvedValue([
      ped("1001", { tamanho: "G", cor: "Preto", orderBump: { produtoId: "b", produtoNome: "Oversized - Surpresa", tamanho: "GG" } }),
      ped("1002", { tamanho: "G", orderBump: { produtoId: "b", produtoNome: "Touca" } }),
    ]);
    render(<UnicosFila grupo={GRUPO} versao={0} onTrocar={() => {}} onEsgotou={() => {}} mesaLivre />);
    expect(await screen.findByText("Oversized · Preto · G")).toBeTruthy();
    expect(screen.getByText("+ Oversized - Surpresa · GG")).toBeTruthy();
    expect(screen.getByText("+ Touca")).toBeTruthy();
  });

  it("Voltar e Trocar estampa chamam os handlers e ficam desabilitados com a mesa ocupada", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001")]);
    const onVoltar = vi.fn();
    const onTrocar = vi.fn();
    const { rerender } = render(<UnicosFila grupo={GRUPO} versao={0} onVoltar={onVoltar} onTrocar={onTrocar} onEsgotou={() => {}} mesaLivre />);
    await screen.findByText("1 pedido na fila");
    fireEvent.click(screen.getByText("Voltar"));
    fireEvent.click(screen.getByText("Trocar estampa"));
    expect(onVoltar).toHaveBeenCalledTimes(1);
    expect(onTrocar).toHaveBeenCalledTimes(1);
    rerender(<UnicosFila grupo={GRUPO} versao={0} onVoltar={onVoltar} onTrocar={onTrocar} trocarDesabilitado onEsgotou={() => {}} mesaLivre={false} />);
    expect((screen.getByText("Voltar") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Trocar estampa") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sem bump o subtítulo não cita bump", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1002")]);
    render(<UnicosFila grupo={GRUPO} versao={0} onTrocar={() => {}} onEsgotou={() => {}} mesaLivre />);
    expect(await screen.findByText("1 pedido na fila")).toBeTruthy();
  });

  it("lista vazia com a mesa livre chama onEsgotou uma vez", async () => {
    getUnicosPedidos.mockResolvedValue([]);
    const onEsgotou = vi.fn();
    const { rerender } = render(<UnicosFila grupo={GRUPO} versao={0} onTrocar={() => {}} onEsgotou={onEsgotou} mesaLivre />);
    await waitFor(() => expect(onEsgotou).toHaveBeenCalledTimes(1));
    rerender(<UnicosFila grupo={GRUPO} versao={1} onTrocar={() => {}} onEsgotou={onEsgotou} mesaLivre />);
    await waitFor(() => expect(getUnicosPedidos).toHaveBeenCalledTimes(2));
    expect(onEsgotou).toHaveBeenCalledTimes(1);
  });

  it("lista vazia com a mesa ocupada não chama; chama quando a mesa libera", async () => {
    getUnicosPedidos.mockResolvedValue([]);
    const onEsgotou = vi.fn();
    const { rerender } = render(<UnicosFila grupo={GRUPO} versao={0} onTrocar={() => {}} onEsgotou={onEsgotou} mesaLivre={false} />);
    await screen.findByText(/voltando/);
    expect(onEsgotou).not.toHaveBeenCalled();
    rerender(<UnicosFila grupo={GRUPO} versao={0} onTrocar={() => {}} onEsgotou={onEsgotou} mesaLivre />);
    await waitFor(() => expect(onEsgotou).toHaveBeenCalledTimes(1));
  });
});

describe("UnicosFila seleção", () => {
  beforeEach(() => getUnicosPedidos.mockReset());
  afterEach(() => cleanup());
  const props = { grupo: GRUPO, versao: 0, onTrocar: () => {}, onEsgotou: () => {}, mesaLivre: true };

  it("sem seleção, não seleciona nada: nenhuma linha selecionada e selo PRÓXIMO só na 1ª", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001"), ped("1002")]);
    const onSelecionar = vi.fn();
    render(<UnicosFila {...props} selecionadoId={null} onSelecionar={onSelecionar} />);
    await screen.findByText("#1001");
    expect(onSelecionar).not.toHaveBeenCalled();
    const opcoes = screen.getAllByRole("option");
    expect(opcoes.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(screen.getAllByText("PRÓXIMO")).toHaveLength(1);
    expect(opcoes[0].textContent).toContain("PRÓXIMO");
    expect(screen.getByText(/Toque num pedido pra escolher/)).toBeTruthy();
  });

  it("ocultarIds tira o pedido da lista na hora", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001"), ped("1002")]);
    render(<UnicosFila {...props} selecionadoId={null} onSelecionar={() => {}} ocultarIds={["1001"]} />);
    await screen.findByText("#1002");
    expect(screen.queryByText("#1001")).toBeNull();
    expect(screen.getByText("1 pedido na fila")).toBeTruthy();
  });

  it("clicar no pedido já selecionado desfaz a seleção", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001"), ped("1002")]);
    const onSelecionar = vi.fn();
    render(<UnicosFila {...props} selecionadoId="1002" onSelecionar={onSelecionar} />);
    await screen.findByText("#1002");
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onSelecionar).toHaveBeenCalledWith(null);
  });

  it("destaca o selecionado e o clique em outro chama onSelecionar", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001"), ped("1002")]);
    const onSelecionar = vi.fn();
    render(<UnicosFila {...props} selecionadoId="1002" onSelecionar={onSelecionar} />);
    await screen.findByText("#1002");
    const opcoes = screen.getAllByRole("option");
    expect(opcoes[0].getAttribute("aria-selected")).toBe("false");
    expect(opcoes[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(opcoes[0]);
    expect(onSelecionar).toHaveBeenCalledWith("1001");
  });

  it("recarga mantém o id se ainda existe; senão limpa a seleção", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001"), ped("1002")]);
    const onSelecionar = vi.fn();
    const { rerender } = render(<UnicosFila {...props} selecionadoId="1002" onSelecionar={onSelecionar} />);
    await screen.findByText("#1002");
    expect(onSelecionar).not.toHaveBeenCalled();
    getUnicosPedidos.mockResolvedValue([ped("1003"), ped("1004")]);
    rerender(<UnicosFila {...props} versao={1} selecionadoId="1002" onSelecionar={onSelecionar} />);
    await waitFor(() => expect(onSelecionar).toHaveBeenCalledWith(null));
  });

  it("título leva o tipo do pedido selecionado; sem pedidos, só estampa e tamanho", async () => {
    getUnicosPedidos.mockResolvedValue([ped("1001", { produtoNome: "Oversized Baki" }), ped("1002", { produtoNome: "Poliamida Baki" })]);
    render(<UnicosFila {...props} selecionadoId="1002" onSelecionar={() => {}} />);
    expect(await screen.findByText("Poliamida · Baki · G")).toBeTruthy();
    cleanup();
    getUnicosPedidos.mockResolvedValue([]);
    render(<UnicosFila {...props} selecionadoId={null} onSelecionar={() => {}} />);
    expect(await screen.findByText("BAKI · G")).toBeTruthy();
  });

  it("linha com bump mostra a miniatura quando há imagemUrl", async () => {
    getUnicosPedidos.mockResolvedValue([
      ped("1001", { orderBump: { produtoId: "b", produtoNome: "Touca", imagemUrl: "https://cdn.shopify.com/s/files/touca.jpg" } }),
      ped("1002", { orderBump: { produtoId: "b", produtoNome: "Touca" } }),
    ]);
    const { container } = render(<UnicosFila {...props} selecionadoId="1001" onSelecionar={() => {}} />);
    await screen.findByText("#1002");
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

describe("UnicosGrupos com estampaInicial", () => {
  beforeEach(() => getUnicos.mockReset());
  afterEach(() => cleanup());

  const g = (estampa: string, tamanho: string) => ({ estampa, tamanho, pedidos: 2, prioritarios: 0, imagemUrl: null, tipos: [] });

  it("abre o painel de tamanhos da estampa depois do fetch", async () => {
    getUnicos.mockResolvedValue({ grupos: [g("Baki", "P"), g("Baki", "GG"), g("Rux", "M")], totalPedidos: 6, filaUnicosAtiva: true });
    render(<UnicosGrupos onEscolher={() => {}} onIndisponivel={() => {}} estampaInicial="Baki" />);
    expect(await screen.findByText("← Voltar")).toBeTruthy();
    expect(screen.getByTitle("Escolher a fila Baki P")).toBeTruthy();
    expect(screen.getByTitle("Escolher a fila Baki GG")).toBeTruthy();
  });

  it("estampa com um único tamanho restante mostra o painel mesmo assim", async () => {
    getUnicos.mockResolvedValue({ grupos: [g("Baki", "P")], totalPedidos: 2, filaUnicosAtiva: true });
    const onEscolher = vi.fn();
    render(<UnicosGrupos onEscolher={onEscolher} onIndisponivel={() => {}} estampaInicial="Baki" />);
    expect(await screen.findByText("← Voltar")).toBeTruthy();
    expect(onEscolher).not.toHaveBeenCalled();
  });

  it("estampa que não existe mais cai na grade", async () => {
    getUnicos.mockResolvedValue({ grupos: [g("Rux", "M")], totalPedidos: 2, filaUnicosAtiva: true });
    render(<UnicosGrupos onEscolher={() => {}} onIndisponivel={() => {}} estampaInicial="Baki" />);
    expect(await screen.findByTitle("Escolher a fila Rux M")).toBeTruthy();
    expect(screen.queryByText("← Voltar")).toBeNull();
  });
});
