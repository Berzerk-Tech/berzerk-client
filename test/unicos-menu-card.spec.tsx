// Card da fila Únicos: botão "⋯" só pra quem tem a flag de impressão manual; "Imprimir grade toda"
// abre o diálogo em modo grade; chip e clique no card seguem como sempre.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUnicos = vi.fn();
const getMe = vi.fn();

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return { ...real, getUnicos: (...a: unknown[]) => getUnicos(...a), getUnicosPedidos: vi.fn(async () => []), liberarImpressaoManual: vi.fn(async () => ({ liberados: 0 })) };
});
vi.mock("../src/services/orders", () => ({ getMe: (...a: unknown[]) => getMe(...a) }));

const { UnicosGrupos } = await import("../src/components/expedicao/UnicosGrupos");

const grupo = (tamanho: string, pedidos: number, cor = "Preto") => ({ estampa: "Leg Day", cor, tamanho, pedidos, prioritarios: 0, comOrderBump: 0, imagemUrl: null, tipos: [] });

function montar(onEscolher = vi.fn()) {
  render(<UnicosGrupos onEscolher={onEscolher} onIndisponivel={() => {}} suportado />);
  return onEscolher;
}

describe("Únicos — menu ⋯ do card", () => {
  beforeEach(() => {
    localStorage.clear();
    getMe.mockReset().mockResolvedValue({ permissions: [], unicosImpressaoManual: true });
    getUnicos.mockReset().mockResolvedValue({
      grupos: [grupo("XG", 14), grupo("P", 92), grupo("M", 90), grupo("G", 38), grupo("GG", 16)],
      totalPedidos: 250,
      filaUnicosAtiva: true,
      periodo: { de: null, ate: null },
    });
  });
  afterEach(() => cleanup());

  it("sem a flag não há botão ⋯", async () => {
    getMe.mockResolvedValue({ permissions: [], unicosImpressaoManual: false });
    montar();
    await screen.findByText("Leg Day");
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Mais opções de/)).toBeNull();
  });

  it("com a flag: menu mostra grade toda com a soma e abre o diálogo em modo grade, tamanhos em ordem", async () => {
    montar();
    fireEvent.click(await screen.findByLabelText("Mais opções de Leg Day Preto"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Imprimir grade toda (250 pedidos)" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Tamanhos da grade").textContent).toBe("P 92 · M 90 · G 38 · GG 16 · XG 14 — 250 pedidos");
    expect(screen.getByRole("button", { name: /Imprimir grade toda \(250 etiquetas \+ 5 capas\)/ })).toBeTruthy();
  });

  it("'Imprimir um tamanho…' abre o painel de tamanhos pra imprimir; escolher abre o diálogo daquele tamanho", async () => {
    const onEscolher = montar();
    fireEvent.click(await screen.findByLabelText("Mais opções de Leg Day Preto"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Imprimir um tamanho…" }));
    expect(await screen.findByText("Escolha o tamanho que vai imprimir.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Imprimir grade toda \(250 pedidos\)/ })).toBeTruthy();
    fireEvent.click(screen.getByTitle("Escolher a fila Leg Day Preto G"));
    expect(await screen.findByText(/Leg Day Preto · G — /)).toBeTruthy();
    expect(onEscolher).not.toHaveBeenCalled();
  });

  it("clicar no card continua abrindo o painel de tamanhos (fila da mesa) e o botão grade toda aparece lá", async () => {
    const onEscolher = montar();
    fireEvent.click(await screen.findByTitle("Abrir Leg Day Preto"));
    expect(screen.queryByText("Escolha o tamanho que vai imprimir.")).toBeNull();
    fireEvent.click(await screen.findByTitle("Escolher a fila Leg Day Preto M"));
    expect(onEscolher).toHaveBeenCalledWith({ estampa: "Leg Day", tamanho: "M", cor: "Preto" });
  });

  it("clicar num chip continua abrindo o diálogo daquele tamanho", async () => {
    montar();
    fireEvent.click(await screen.findByTitle("Abrir os pedidos do tamanho P"));
    expect(await screen.findByText(/Leg Day Preto · P — /)).toBeTruthy();
    expect(screen.queryByLabelText("Tamanhos da grade")).toBeNull();
  });

  it("card com um tamanho só: o menu tem só 'Imprimir tamanho X (N pedidos)'", async () => {
    getUnicos.mockResolvedValue({ grupos: [grupo("G", 7)], totalPedidos: 7, filaUnicosAtiva: true, periodo: { de: null, ate: null } });
    montar();
    fireEvent.click(await screen.findByLabelText("Mais opções de Leg Day Preto"));
    const itens = screen.getAllByRole("menuitem");
    expect(itens.map((i) => i.textContent)).toEqual(["Imprimir tamanho G (7 pedidos)"]);
    fireEvent.click(itens[0]);
    expect(await screen.findByText(/Leg Day Preto · G — /)).toBeTruthy();
  });

  it("'Impressões recentes' abre o histórico local", async () => {
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Impressões recentes" }));
    expect(await screen.findByText("Nenhuma impressão manual nos últimos 3 dias.")).toBeTruthy();
  });

  it("depois de imprimir um tamanho pelo menu e o card sumir, o próximo card abre o fluxo normal da mesa", async () => {
    const onEscolher = montar();
    fireEvent.click(await screen.findByLabelText("Mais opções de Leg Day Preto"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Imprimir um tamanho…" }));
    fireEvent.click(await screen.findByTitle("Escolher a fila Leg Day Preto G"));
    await screen.findByText(/Leg Day Preto · G — /);
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    // o card acabou: o poll traz só outra estampa
    getUnicos.mockResolvedValue({
      grupos: [{ ...grupo("M", 5, "Branco"), estampa: "Outra" }, { ...grupo("G", 3, "Branco"), estampa: "Outra" }],
      totalPedidos: 8,
      filaUnicosAtiva: true,
      periodo: { de: null, ate: null },
    });
    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    fireEvent.click(await screen.findByTitle("Abrir Outra Branco"));
    expect(screen.queryByText("Escolha o tamanho que vai imprimir.")).toBeNull();
    fireEvent.click(await screen.findByTitle("Escolher a fila Outra Branco M"));
    expect(onEscolher).toHaveBeenCalledWith({ estampa: "Outra", tamanho: "M", cor: "Branco" });
  });
});
