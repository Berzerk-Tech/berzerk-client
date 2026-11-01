// Modo Únicos (01/11): order bump visível na lista do grupo, volta automática quando a fila
// do tamanho acaba e abertura direta do painel de tamanhos da estampa.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    expect(await screen.findByText("+ Touca Berzerk")).toBeTruthy();
    expect(screen.getAllByText("+ Touca Berzerk")).toHaveLength(1);
    expect(screen.getByText(/2 pedidos na fila · 1 com bump/)).toBeTruthy();
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
