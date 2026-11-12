// Pedir reposição: fluxo principal do modal + estabilidade (re-render do pai
// não dispara chamada) + botão só com suporte.
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemCatalogoReposicao } from "../src/services/reposicaoPedidos";

const getCatalogo = vi.fn();
const getMeus = vi.fn();
const criar = vi.fn();
const cancelar = vi.fn();
vi.mock("../src/services/reposicaoPedidos", async () => {
  const real = await vi.importActual<typeof import("../src/services/reposicaoPedidos")>("../src/services/reposicaoPedidos");
  return {
    ...real,
    getCatalogoReposicao: (...a: unknown[]) => getCatalogo(...a),
    getMeusPedidosReposicao: (...a: unknown[]) => getMeus(...a),
    criarPedidosReposicao: (...a: unknown[]) => criar(...a),
    cancelarPedidosReposicao: (...a: unknown[]) => cancelar(...a),
  };
});

import { PedirReposicaoModal } from "../src/components/PedirReposicaoModal";
import { useMeusPedidosReposicao } from "../src/lib/usePedidosReposicao";

function it_(id: string, nomeCurto: string, o: Partial<ItemCatalogoReposicao> = {}): ItemCatalogoReposicao {
  return {
    produtoId: id, nome: `Oversized - ${nomeCurto}`, nomeCurto, imagemUrl: null, grupo: "Oversized", cor: "preta",
    corIndefinida: false, picking: 30, limite: 30, pendenteQtd: 0, pendentePedidos: 0, faltaQtd: 0, estoqueLoja: null,
    estado: "ativo", fixado: false, ...o,
  };
}
const MEUS_VAZIO = { agora: "2026-11-10T12:00:00Z", pendentes: [], atendidos24h: [] };
const catalogo = (extra: object = {}) => ({
  kind: "ok",
  catalogo: {
    tamanho: "M", atualizadoEm: "", pickingDisponivel: true,
    itens: [it_("a", "Zeus"), it_("b", "Myth", { limite: 20, pendenteQtd: 10 })],
    minhaFila: { tamanhos: ["M"] }, limites: { porPessoa: 5, pendentesMeus: 1, fila: 0, pendentesFila: 0 },
    ...extra,
  },
});

function Pai({ children }: { children: (n: number) => React.ReactNode }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <button onClick={() => setN((x) => x + 1)}>rerender-pai</button>
      {children(n)}
    </div>
  );
}

beforeEach(() => {
  getCatalogo.mockReset().mockResolvedValue(catalogo());
  getMeus.mockReset().mockResolvedValue(MEUS_VAZIO);
  criar.mockReset().mockResolvedValue({ kind: "ok", pedidos: [{ id: "p1", produtoId: "a", tamanho: "M", qtd: 10 }] });
  cancelar.mockReset().mockResolvedValue(1);
});
afterEach(cleanup);

const props = { tamanhoFila: "M" as const, pedidosMesa: [], meus: MEUS_VAZIO, onRecarregarMeus: async () => {}, onClose: () => {} };

const linhaMeus = (o: object) => ({
  id: "x", produtoId: "a", nome: "Oversized - Zeus", imagemUrl: null, cor: "preta", tamanho: "M", qtd: 10,
  status: "pendente", criadoEm: "2026-11-10T11:50:00Z", atendidoEm: null, atendidoPorNome: null,
  falta: false, faltaEm: null, faltaPorNome: null, ...o,
});

describe("PedirReposicaoModal: Meus pedidos (12/11)", () => {
  beforeEach(() => localStorage.clear());
  const meusCom = (extra: object) => ({ ...MEUS_VAZIO, ...extra });

  it("histórico nasce recolhido, com contagem, e abre no clique (lembrando a escolha)", async () => {
    const meus = meusCom({
      atendidos24h: [
        linhaMeus({ id: "h1", nome: "Oversized - Historico1", status: "atendido", atendidoEm: "2026-11-10T11:00:00Z", atendidoPorNome: "Rafa" }),
        linhaMeus({ id: "h2", nome: "Oversized - Historico2", status: "atendido", atendidoEm: "2026-11-10T11:00:00Z" }),
      ],
    });
    render(<PedirReposicaoModal {...props} meus={meus} />);
    fireEvent.click(screen.getByText("Meus pedidos"));
    const toggle = screen.getByRole("button", { name: /Repostos nas últimas horas \(2\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Oversized - Historico1")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Oversized - Historico1")).toBeTruthy();
    cleanup();
    render(<PedirReposicaoModal {...props} meus={meus} />);
    fireEvent.click(screen.getByText("Meus pedidos"));
    expect(screen.getByText("Oversized - Historico1")).toBeTruthy();
  });

  it("daFila ausente: sem seção; presente: lista com nome de quem pediu, sem cancelar e sem mexer no contador da aba", async () => {
    const pendente = linhaMeus({ id: "meu", nome: "Oversized - Meu" });
    render(<PedirReposicaoModal {...props} meus={meusCom({ pendentes: [pendente] })} />);
    fireEvent.click(screen.getByText(/Meus pedidos/));
    expect(screen.queryByText(/Pedidos de outras bancadas/)).toBeNull();
    cleanup();

    const outro = linhaMeus({ id: "o1", nome: "Oversized - Alheio", pedidoPorNome: "Dani" });
    const semNome = linhaMeus({ id: "o2", nome: "Oversized - Alheio2" });
    render(<PedirReposicaoModal {...props} meus={meusCom({ pendentes: [pendente], daFila: [outro, semNome] })} />);
    expect(screen.getByText("Meus pedidos (1)")).toBeTruthy();
    fireEvent.click(screen.getByText("Meus pedidos (1)"));
    expect(screen.getByText("Pedidos de outras bancadas (2)")).toBeTruthy();
    expect(screen.getByText(/pedido de Dani/)).toBeTruthy();
    expect(screen.getByText(/pedido de outra operadora/)).toBeTruthy();
    // só o pendente dela tem "cancelar"
    expect(screen.getAllByText("cancelar")).toHaveLength(1);
  });
});

describe("PedirReposicaoModal", () => {
  it("abrir → +10 → enviar → desfazer", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    expect(screen.getByText("10 peças · 1 produto")).toBeTruthy();
    fireEvent.click(screen.getByText("Enviar pedido"));
    await waitFor(() => expect(criar).toHaveBeenCalledWith([{ produtoId: "a", tamanho: "M", qtd: 10 }], expect.any(String)));
    await screen.findByText(/Pedido enviado pros repositores/);
    fireEvent.click(screen.getByText("Desfazer"));
    await waitFor(() => expect(cancelar).toHaveBeenCalledWith(["p1"]));
    expect(screen.queryByText(/Pedido enviado pros repositores/)).toBeNull();
  });

  it("respeita limite − pendente e avisa o máximo", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Myth");
    const btn = screen.getByLabelText("Adicionar 10 peças de Myth");
    fireEvent.click(btn);
    expect(screen.getByText(/Máximo pra este produto: 10 pç \(já pedido 10\)/)).toBeTruthy();
    expect((screen.getByLabelText("Colocar mais 10 peças") as HTMLButtonElement).disabled).toBe(true);
  });

  it("409 limite: recarrega o catálogo, ajusta o carrinho e mantém o resto", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Myth"));
    criar.mockResolvedValueOnce({ kind: "erro", erro: { error: "limite", produtoId: "b", tamanho: "M", limite: 20, pendente: 20 } });
    getCatalogo.mockResolvedValue(catalogo({ itens: [it_("a", "Zeus"), it_("b", "Myth", { limite: 20, pendenteQtd: 20 })] }));
    fireEvent.click(screen.getByText("Enviar pedido"));
    await screen.findByText(/Alguém já pediu esse produto/);
    await waitFor(() => expect(screen.getByText("10 peças · 1 produto")).toBeTruthy());
  });

  it("idempotência: reenvio do mesmo carrinho reusa a chave; carrinho novo ou sucesso gera outra", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    criar.mockRejectedValueOnce(new Error("timeout"));
    fireEvent.click(screen.getByText("Enviar pedido"));
    await screen.findByText(/sem medo de duplicar/);
    fireEvent.click(screen.getByText("Tentar de novo")); // sucesso
    await screen.findByText(/Pedido enviado pros repositores/);
    const k1 = criar.mock.calls[0][1];
    expect(k1).toBeTruthy();
    expect(criar.mock.calls[1][1]).toBe(k1);
    // mesmo carrinho depois de enviado: chave nova
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    fireEvent.click(screen.getByText("Enviar pedido"));
    await waitFor(() => expect(criar).toHaveBeenCalledTimes(3));
    expect(criar.mock.calls[2][1]).not.toBe(k1);
  });

  it("idempotência: carrinho que mudou entre tentativas gera chave nova", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    criar.mockRejectedValueOnce(new Error("timeout"));
    fireEvent.click(screen.getByText("Enviar pedido"));
    await screen.findByText(/sem medo de duplicar/);
    // carrinho travado: não dá pra mudar o conteúdo (a chave vale pra ele)
    expect((screen.getByLabelText("Adicionar 10 peças de Myth") as HTMLButtonElement).disabled).toBe(true);
    // descartar: limpa carrinho e chave; carrinho novo ganha chave nova
    fireEvent.click(screen.getByText("Descartar"));
    await waitFor(() => expect(screen.getByText("0 peças · 0 produtos")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    fireEvent.click(screen.getByText("Enviar pedido"));
    await waitFor(() => expect(criar).toHaveBeenCalledTimes(2));
    expect(criar.mock.calls[1][1]).not.toBe(criar.mock.calls[0][1]);
  });

  it("envio não confirmado: refresh do catálogo NÃO ajusta o carrinho; tentar de novo reusa chave e conteúdo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<PedirReposicaoModal {...props} />);
      await screen.findByText("Zeus");
      fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Myth"));
      criar.mockRejectedValueOnce(new Error("timeout"));
      fireEvent.click(screen.getByText("Enviar pedido"));
      await screen.findByText(/sem medo de duplicar/);
      // refresh traz o Myth sem espaço: antes o carrinho era ajustado (assinatura/chave mudavam)
      getCatalogo.mockResolvedValue(catalogo({ itens: [it_("a", "Zeus"), it_("b", "Myth", { limite: 20, pendenteQtd: 20 })] }));
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.getByText("10 peças · 1 produto")).toBeTruthy();
      fireEvent.click(screen.getByText("Tentar de novo"));
      await waitFor(() => expect(criar).toHaveBeenCalledTimes(2));
      expect(criar.mock.calls[1][1]).toBe(criar.mock.calls[0][1]);
      expect(criar.mock.calls[1][0]).toEqual(criar.mock.calls[0][0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("409 chave_em_uso: zera a chave e manda conferir Meus pedidos", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    criar.mockResolvedValueOnce({ kind: "erro", erro: { error: "chave_em_uso" } });
    fireEvent.click(screen.getByText("Enviar pedido"));
    await screen.findByText("Não deu pra confirmar este pedido. Confira em Meus pedidos antes de enviar de novo.");
    fireEvent.click(screen.getByText("Enviar pedido"));
    await waitFor(() => expect(criar).toHaveBeenCalledTimes(2));
    expect(criar.mock.calls[1][1]).not.toBe(criar.mock.calls[0][1]);
  });

  it("sucesso limpa só o que foi enviado e botões ficam travados durante o envio", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    let liberar!: (v: unknown) => void;
    criar.mockReturnValueOnce(new Promise((r) => { liberar = r; }));
    fireEvent.click(screen.getByText("Enviar pedido"));
    await waitFor(() => expect((screen.getByLabelText("Tirar 10 peças") as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByLabelText("Colocar mais 10 peças") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { liberar({ kind: "ok", pedidos: [{ id: "p1", produtoId: "a", tamanho: "M", qtd: 10 }] }); });
    await screen.findByText(/Pedido enviado pros repositores/);
    expect(screen.getByText("0 peças · 0 produtos")).toBeTruthy();
  });

  it("erro de refresh some quando um refresh seguinte dá certo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<PedirReposicaoModal {...props} />);
      await screen.findByText("Zeus");
      getCatalogo.mockRejectedValueOnce(new Error("rede caiu"));
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.getByText("rede caiu")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.queryByText("rede caiu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fechar com itens no carrinho pede confirmação; sem itens fecha direto", async () => {
    const onClose = vi.fn();
    render(<PedirReposicaoModal {...props} onClose={onClose} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Fechar"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.findByText("Descartar o pedido que você estava montando?");
    fireEvent.click(screen.getByText("Continuar editando"));
    expect(screen.queryByText("Descartar o pedido que você estava montando?")).toBeNull();
    expect(screen.getByText("10 peças · 1 produto")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Fechar"));
    fireEvent.click(screen.getByText("Descartar"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("fora_da_fila sem tamanhos: continua relendo e destrava sozinho", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getCatalogo.mockResolvedValueOnce({ kind: "fora_da_fila", tamanhos: [] });
      render(<PedirReposicaoModal {...props} />);
      await screen.findByText("Você precisa estar com pedidos na mesa pra pedir reposição.");
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      await screen.findByText("Zeus");
      expect(getCatalogo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("409 produto_inativo: tira o produto, mantém o resto, mensagem simples", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Myth"));
    criar.mockResolvedValueOnce({ kind: "erro", erro: { error: "produto_inativo", produtoId: "a" } });
    fireEvent.click(screen.getByText("Enviar pedido"));
    await screen.findByText("Este produto não está mais disponível pra pedido.");
    await waitFor(() => expect(screen.getByText("10 peças · 1 produto")).toBeTruthy());
  });

  it("fila cheia mostra a mensagem simples", async () => {
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    criar.mockResolvedValueOnce({ kind: "erro", erro: { error: "fila_cheia", limite: 5, pendentes: 5 } });
    fireEvent.click(screen.getByText("Enviar pedido"));
    await screen.findByText("Os repositores estão com a fila cheia. Tente de novo em alguns minutos.");
  });

  it("teto pessoal: mostra X de Y e bloqueia envio que estoura", async () => {
    getCatalogo.mockResolvedValue(catalogo({ limites: { porPessoa: 2, pendentesMeus: 2, fila: 0, pendentesFila: 0 } }));
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByLabelText("Adicionar 10 peças de Zeus"));
    expect(screen.getByText(/Você tem 2 de 2 pedidos em aberto/)).toBeTruthy();
    expect((screen.getByText("Enviar pedido") as HTMLButtonElement).disabled).toBe(true);
  });

  it("fila vazia: mensagem e nada mais", async () => {
    getCatalogo.mockResolvedValue({ kind: "fora_da_fila", tamanhos: [] });
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Você precisa estar com pedidos na mesa pra pedir reposição.");
    expect(screen.queryByText("Enviar pedido")).toBeNull();
  });

  it("vários tamanhos permitidos: chips", async () => {
    getCatalogo.mockResolvedValue(catalogo({ minhaFila: { tamanhos: ["M", "G"] } }));
    render(<PedirReposicaoModal {...props} />);
    await screen.findByText("Zeus");
    fireEvent.click(screen.getByText("G"));
    await waitFor(() => expect(getCatalogo).toHaveBeenLastCalledWith("G"));
  });

  it("re-render do pai não dispara novas chamadas", async () => {
    render(
      <Pai>{() => <PedirReposicaoModal {...props} pedidosMesa={[]} onClose={() => {}} onRecarregarMeus={async () => {}} />}</Pai>,
    );
    await screen.findByText("Zeus");
    const antes = getCatalogo.mock.calls.length;
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText("rerender-pai"));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(getCatalogo.mock.calls.length).toBe(antes);
  });
});

function SondaAberto({ aberto }: { aberto: boolean }) {
  useMeusPedidosReposicao(aberto);
  return null;
}

describe("useMeusPedidosReposicao", () => {
  function Sonda() {
    const { suporte, meus } = useMeusPedidosReposicao(false);
    return <span>{suporte ? `suporte:${meus?.pendentes.length ?? 0}` : "sem-suporte"}</span>;
  }

  it("sem suporte (404/403 → null): nada aparece e não entra em laço", async () => {
    getMeus.mockResolvedValue(null);
    render(<Pai>{() => <Sonda />}</Pai>);
    await screen.findByText("sem-suporte");
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText("rerender-pai"));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(getMeus).toHaveBeenCalledTimes(1);
  });

  it("alternar `aberto` com request pendente deixa UM único ciclo ativo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pendentes: Array<(v: unknown) => void> = [];
      getMeus.mockImplementation(() => new Promise((r) => { pendentes.push(r); }));
      const { rerender } = render(<SondaAberto aberto={false} />);
      for (const a of [true, false, true, false, true]) rerender(<SondaAberto aberto={a} />);
      // libera TODOS os GETs pendentes (inclusive os dos efeitos já cancelados)
      getMeus.mockReset().mockResolvedValue(MEUS_VAZIO);
      await act(async () => { pendentes.splice(0).forEach((r) => r(MEUS_VAZIO)); });
      const base = getMeus.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      // aberto = true → 20 s: 3 chamadas num ciclo só (com órfãos seriam 3 × N)
      expect(getMeus.mock.calls.length - base).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("com suporte: busca uma vez e re-render do pai não refaz a chamada", async () => {
    render(<Pai>{() => <Sonda />}</Pai>);
    await screen.findByText("suporte:0");
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText("rerender-pai"));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(getMeus).toHaveBeenCalledTimes(1);
  });
});
