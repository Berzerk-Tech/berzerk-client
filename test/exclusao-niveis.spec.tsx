// Exclusão do galpão em dois níveis (bancada x fábrica): normalização, nível enviado,
// podeTirar/limpar por nível e a tela. Sem `aceitaNivel` tudo como antes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { contarFabrica, nivelParaEnvio, podeTirarItem } from "../src/lib/exclusaoGlobalTamanho";
import type { ExclusoesGlobais } from "../src/services/exclusoesGlobais";
import type { QueueProduct } from "../src/services/orders";

const getQueueProducts = vi.fn();
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getQueueProducts: (...a: unknown[]) => getQueueProducts(...a) };
});
const getExclusoesGlobais = vi.fn();
const adicionarExclusaoGlobal = vi.fn();
const removerExclusaoGlobal = vi.fn();
const mudarNivel = vi.fn();
vi.mock("../src/services/exclusoesGlobais", async () => {
  const real = await vi.importActual<typeof import("../src/services/exclusoesGlobais")>("../src/services/exclusoesGlobais");
  return {
    ...real,
    getExclusoesGlobais: () => getExclusoesGlobais(),
    adicionarExclusaoGlobal: (...a: unknown[]) => adicionarExclusaoGlobal(...a),
    removerExclusaoGlobal: (...a: unknown[]) => removerExclusaoGlobal(...a),
    mudarNivel: (...a: unknown[]) => mudarNivel(...a),
  };
});
vi.mock("../src/lib/printer", () => ({ printPdfBase64: vi.fn(async () => ({ ok: true })) }));
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => null }));

import { PickingFiltersModal } from "../src/components/PickingFiltersModal";

const FILA: QueueProduct[] = [
  { nome: "Moletom Cargo", tamanho: "M", ean: "1", imagemUrl: null, quantidade: 2, pedidos: 2, orderIds: ["a", "b"] },
  { nome: "Camiseta Zeus", tamanho: "M", ean: "2", imagemUrl: null, quantidade: 1, pedidos: 1, orderIds: ["c"] },
];
const T = (id: string, produto: string, extra: Record<string, unknown> = {}) => ({
  id,
  termo: `${produto} - M`,
  produto,
  tamanho: "M",
  criadoPor: "Stefhany",
  criadoEm: "2026-11-04T15:30:00.000Z",
  nivel: "bancada",
  podeRemover: true,
  podeMudarNivel: false,
  ...extra,
});
const lista = (termos: unknown[], extra: Record<string, unknown> = {}) => ({
  termos,
  atualizadoEm: null,
  aceitaTamanho: true,
  aceitaNivel: true,
  podeMarcarFabrica: false,
  ...extra,
});
const props = {
  filters: {},
  queue: { mode: "normal" as const, size: "M", sizes: ["M"] },
  onApply: vi.fn(),
  onClear: vi.fn(),
  onClose: vi.fn(),
};

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  getQueueProducts.mockReset().mockImplementation(async () => ({ products: FILA }));
  getExclusoesGlobais.mockReset();
  adicionarExclusaoGlobal.mockReset().mockImplementation(async () => ({ termos: [], atualizadoEm: null }));
  removerExclusaoGlobal.mockReset().mockImplementation(async () => ({ termos: [], atualizadoEm: null }));
  mudarNivel.mockReset();
  props.onApply.mockReset();
});

describe("normalização", () => {
  it("guarda os campos novos e ignora lixo", async () => {
    const { getExclusoesGlobais: real } = await vi.importActual<typeof import("../src/services/exclusoesGlobais")>("../src/services/exclusoesGlobais");
    void real;
    vi.resetModules();
    const api = await import("../src/lib/api");
    const spy = vi.spyOn(api, "apiRequest").mockResolvedValue({
      aceitaNivel: true,
      podeMarcarFabrica: true,
      atualizadoEm: null,
      termos: [
        { id: "1", termo: "A", nivel: "fabrica", semPecaEm: "2026-11-26T10:00:00Z", semPecaPorNome: " Rita ", podeMudarNivel: true, podeRemover: false },
        { id: "2", termo: "B", nivel: "xyz", semPecaEm: null },
      ],
    } as never);
    const svc = await vi.importActual<typeof import("../src/services/exclusoesGlobais")>("../src/services/exclusoesGlobais");
    const g = await svc.getExclusoesGlobais();
    spy.mockRestore();
    expect(g?.aceitaNivel).toBe(true);
    expect(g?.podeMarcarFabrica).toBe(true);
    expect(g?.termos[0]).toMatchObject({ nivel: "fabrica", semPecaEm: "2026-11-26T10:00:00Z", semPecaPorNome: "Rita", podeMudarNivel: true, podeRemover: false });
    expect(g?.termos[1].nivel).toBeUndefined();
    expect(g?.termos[1].semPecaEm).toBeUndefined();
  });
});

describe("nível enviado", () => {
  it("nexus antigo: nada; não supervisor: sempre bancada; supervisor: o escolhido", () => {
    expect(nivelParaEnvio(null, "fabrica")).toBeUndefined();
    expect(nivelParaEnvio({}, "fabrica")).toBeUndefined();
    expect(nivelParaEnvio({ aceitaNivel: true, podeMarcarFabrica: false }, "fabrica")).toBe("bancada");
    expect(nivelParaEnvio({ aceitaNivel: true }, "fabrica")).toBe("bancada");
    expect(nivelParaEnvio({ aceitaNivel: true, podeMarcarFabrica: true }, "fabrica")).toBe("fabrica");
    expect(nivelParaEnvio({ aceitaNivel: true, podeMarcarFabrica: true }, "bancada")).toBe("bancada");
  });
});

describe("podeTirarItem / contagem por nível", () => {
  const g = lista(
    [T("1", "Moletom Cargo", { nivel: "fabrica", podeRemover: false }), T("2", "Camiseta Zeus")],
  ) as unknown as ExclusoesGlobais;
  const sel = (produto: string) => ({ produto, tamanho: "M" });
  it("termo fábrica não sai pra separadora; bancada sai; não salvo sai", () => {
    expect(podeTirarItem(g, sel("Moletom Cargo"), false)).toBe(false);
    expect(podeTirarItem(g, sel("Camiseta Zeus"), false)).toBe(true);
    expect(podeTirarItem(g, sel("Novo"), false)).toBe(true);
  });
  it("sem podeRemover do servidor, fábrica ainda só a supervisão tira", () => {
    const sem = lista([T("1", "Moletom Cargo", { nivel: "fabrica", podeRemover: undefined })]) as unknown as ExclusoesGlobais;
    expect(podeTirarItem(sem, sel("Moletom Cargo"), false)).toBe(false);
    expect(podeTirarItem({ ...sem, podeMarcarFabrica: true }, sel("Moletom Cargo"), false)).toBe(true);
  });
  it("nexus antigo: tudo ou nada pela leitura", () => {
    expect(podeTirarItem({ termos: [], atualizadoEm: null }, sel("X"), false)).toBe(true);
    expect(podeTirarItem({ termos: [], atualizadoEm: null }, sel("X"), true)).toBe(false);
    expect(podeTirarItem(null, sel("X"), true)).toBe(false);
  });
  it("contarFabrica conta produtos distintos e é 0 sem aceitaNivel", () => {
    expect(contarFabrica([sel("Moletom Cargo"), sel("Camiseta Zeus")], g)).toBe(1);
    expect(contarFabrica([sel("Moletom Cargo")], { termos: g.termos, atualizadoEm: null })).toBe(0);
  });
});

describe("tela", () => {
  it("nexus antigo (sem aceitaNivel): sem selos, sem escolha de nível, POST sem nivel", async () => {
    getExclusoesGlobais.mockResolvedValue({ termos: [], atualizadoEm: null, aceitaTamanho: true });
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    expect(screen.queryByTestId("nivel-novo")).toBeNull();
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus", "M"));
    expect(screen.queryByTestId("selo-nivel")).toBeNull();
  });

  it("separadora: marca como bancada, sem escolha de nível, com o texto de apoio", async () => {
    getExclusoesGlobais.mockResolvedValue(lista([]));
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    expect(screen.queryByTestId("nivel-novo")).toBeNull();
    expect(screen.getByText(/até a reposição atender ou até o fim do dia/)).toBeTruthy();
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus", "M", "bancada"));
  });

  it("supervisão: padrão fábrica, lembra a escolha e envia o nível escolhido", async () => {
    getExclusoesGlobais.mockResolvedValue(lista([], { podeMarcarFabrica: true }));
    const { unmount } = render(<PickingFiltersModal {...props} />);
    const grupo = await screen.findByTestId("nivel-novo");
    expect(grupo.querySelector('[aria-pressed="true"]')?.textContent).toBe("Acabou na fábrica");
    fireEvent.click(screen.getByText("Falta na bancada"));
    unmount();
    getExclusoesGlobais.mockResolvedValue(lista([], { podeMarcarFabrica: true }));
    render(<PickingFiltersModal {...props} />);
    const g2 = await screen.findByTestId("nivel-novo");
    expect(g2.querySelector('[aria-pressed="true"]')?.textContent).toBe("Falta na bancada");
    fireEvent.click(await screen.findByText("Camiseta Zeus"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus", "M", "bancada"));
  });

  it("selos de nível e 'Repositor: não tem'; separadora não vê promover; fábrica fica travada", async () => {
    getExclusoesGlobais.mockResolvedValue(
      lista([
        T("1", "Moletom Cargo", { nivel: "fabrica", podeRemover: false }),
        T("2", "Camiseta Zeus", { semPecaEm: "2026-11-26T10:00:00Z", semPecaPorNome: "Rita" }),
      ]),
    );
    render(<PickingFiltersModal {...props} />);
    const selos = await screen.findAllByTestId("selo-nivel");
    expect(selos.map((s) => s.textContent)).toEqual(["Fábrica", "Bancada"]);
    expect(screen.getByTestId("selo-sem-peca").textContent).toBe("Repositor: não tem");
    expect(screen.queryByTestId("mudar-nivel")).toBeNull();
    expect(screen.getAllByTestId("item-travado")).toHaveLength(1);
    expect(screen.getByText(/1 fábrica/)).toBeTruthy();
    // "Limpar do galpão" só tira o que pode: o termo fábrica continua.
    fireEvent.click(screen.getByRole("button", { name: "Limpar do galpão" }));
    expect(screen.getAllByTestId("selo-nivel")).toHaveLength(1);
    expect(screen.getByTestId("selo-nivel").textContent).toBe("Fábrica");
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(removerExclusaoGlobal).toHaveBeenCalledTimes(1));
    expect(removerExclusaoGlobal).toHaveBeenCalledWith("2");
  });

  it("supervisão promove com um clique e a lista nova vem do servidor", async () => {
    getExclusoesGlobais.mockResolvedValue(lista([T("2", "Camiseta Zeus", { podeMudarNivel: true })], { podeMarcarFabrica: true }));
    mudarNivel.mockResolvedValue(lista([T("2", "Camiseta Zeus", { nivel: "fabrica", podeMudarNivel: true })], { podeMarcarFabrica: true }));
    render(<PickingFiltersModal {...props} />);
    fireEvent.click(await screen.findByTestId("mudar-nivel"));
    await waitFor(() => expect(mudarNivel).toHaveBeenCalledWith("2", "fabrica"));
    await waitFor(() => expect(screen.getByTestId("mudar-nivel").textContent).toBe("Voltar pra bancada"));
    expect(screen.getByTestId("selo-nivel").textContent).toBe("Fábrica");
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("403 ao mudar o nível: mensagem clara e lista do servidor restaurada", async () => {
    const original = lista([T("2", "Camiseta Zeus", { podeMudarNivel: true })], { podeMarcarFabrica: true });
    getExclusoesGlobais.mockResolvedValue(original);
    mudarNivel.mockRejectedValue(new ApiError(403, "forbidden", { error: "exclusao_global_nao_permitida" }));
    render(<PickingFiltersModal {...props} />);
    fireEvent.click(await screen.findByTestId("mudar-nivel"));
    await waitFor(() => expect(screen.getByText(/Só a supervisão marca falta na fábrica/)).toBeTruthy());
    expect(screen.getByTestId("selo-nivel").textContent).toBe("Bancada");
  });

  it("403 ao marcar FÁBRICA no Aplicar (supervisão sem direito no servidor) vira a mensagem da supervisão", async () => {
    getExclusoesGlobais.mockResolvedValue(lista([], { podeMarcarFabrica: true }));
    adicionarExclusaoGlobal.mockRejectedValue(new ApiError(403, "forbidden", { error: "exclusao_global_nao_permitida" }));
    render(<PickingFiltersModal {...props} />);
    await screen.findByTestId("nivel-novo");
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(screen.getByText(/Só a supervisão marca falta na fábrica/)).toBeTruthy());
    expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus", "M", "fabrica");
  });

  it("403 de POST de bancada usa a mensagem genérica de antes", async () => {
    getExclusoesGlobais.mockResolvedValue(lista([]));
    adicionarExclusaoGlobal.mockRejectedValue(new ApiError(403, "forbidden", { error: "exclusao_global_nao_permitida" }));
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(screen.getByText(/Só quem tirou ou a supervisão devolve/)).toBeTruthy());
    expect(screen.queryByText(/marca falta na fábrica/)).toBeNull();
  });

  it("termo que sumiu do servidor não é re-enviado depois de promover outro", async () => {
    const A = T("1", "Moletom Cargo");
    const B = T("2", "Camiseta Zeus", { podeMudarNivel: true });
    getExclusoesGlobais.mockResolvedValue(lista([A, B], { podeMarcarFabrica: true }));
    // Depois de promover B, o servidor já não tem A (reposição atendeu).
    mudarNivel.mockResolvedValue(lista([T("2", "Camiseta Zeus", { nivel: "fabrica", podeMudarNivel: true })], { podeMarcarFabrica: true }));
    render(<PickingFiltersModal {...props} />);
    const botoes = await screen.findAllByTestId("mudar-nivel");
    fireEvent.click(botoes[botoes.length - 1]);
    await waitFor(() => expect(mudarNivel).toHaveBeenCalledWith("2", "fabrica"));
    await waitFor(() => expect(screen.getAllByTestId("selo-nivel")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    expect(adicionarExclusaoGlobal).not.toHaveBeenCalled();
    expect(removerExclusaoGlobal).not.toHaveBeenCalled();
  });

  it("404 de termo já removido: mensagem própria e rascunho novo da estação preservado", async () => {
    const B = T("2", "Camiseta Zeus", { podeMudarNivel: true });
    getExclusoesGlobais.mockResolvedValueOnce(lista([B], { podeMarcarFabrica: true }));
    render(<PickingFiltersModal {...props} />);
    const btn = await screen.findByTestId("mudar-nivel");
    // A estação marca um item novo (rascunho) antes de promover.
    fireEvent.click(screen.getByText("Moletom Cargo"));
    getExclusoesGlobais.mockResolvedValue(lista([], { podeMarcarFabrica: true }));
    mudarNivel.mockRejectedValue(new ApiError(404, "not found", { error: "exclusao_global_nao_encontrada" }));
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/Esse item já saiu do galpão/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(adicionarExclusaoGlobal).toHaveBeenCalledTimes(1));
    expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Moletom Cargo", "M", "fabrica");
    expect(removerExclusaoGlobal).not.toHaveBeenCalled();
  });
});

describe("fundirComServidor (puro)", () => {
  it("só o que existe no servidor, os rascunhos novos e os termos novos", async () => {
    const { fundirComServidor } = await import("../src/lib/exclusaoGlobalTamanho");
    const base = [{ produto: "A", tamanho: "M" }, { produto: "B", tamanho: "M" }];
    const sel = [...base, { produto: "Rascunho", tamanho: null }];
    const termos = [T("2", "B", { nivel: "fabrica" }), T("3", "Novo")] as never;
    const r = fundirComServidor(sel, base, termos);
    expect(r.map((x) => x.produto)).toEqual(["B", "Rascunho", "Novo"]);
    expect(r[0].nivel).toBe("fabrica");
  });
});
