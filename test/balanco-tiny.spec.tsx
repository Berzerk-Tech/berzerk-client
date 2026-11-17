import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BalancoTiny } from "../src/components/BalancoTiny";
import { diferencaComTiny, linhasDoBalanco, medidoHa, milhar } from "../src/lib/balancoTiny";
import type { BalancoFilas } from "../src/services/orders";

const AGORA = Date.parse("2026-11-17T15:00:00Z");

function bal(p: Partial<BalancoFilas> = {}): BalancoFilas {
  return {
    periodo: { de: "2026-11-16", ate: "2026-11-16" },
    naFila: 1200,
    semEtiqueta: 30,
    faturadoNaoLiberado: 0,
    emSeparacao: 50,
    emEspera: 0,
    aguardandoEmbalar: 400,
    mercadoLivre: 10,
    entregaEmMaos: 0,
    duplicatas: 2,
    abertos: 1692,
    tiny: { total: 1700, medidoEm: "2026-11-17T14:55:00Z" },
    ...p,
  };
}

describe("lib balancoTiny", () => {
  it("milhar pt-BR", () => {
    expect(milhar(0)).toBe("0");
    expect(milhar(999)).toBe("999");
    expect(milhar(1692)).toBe("1.692");
    expect(milhar(1234567)).toBe("1.234.567");
  });
  it("linhas: só > 0, na ordem e com os rótulos", () => {
    expect(linhasDoBalanco(bal()).map((l) => [l.rotulo, l.valor])).toEqual([
      ["Na fila", 1200],
      ["Sem etiqueta J&T", 30],
      ["Em separação", 50],
      ["Separados, aguardando embalar", 400],
      ["Mercado Livre", 10],
      ["Duplicatas", 2],
    ]);
  });
  it("diferença", () => {
    expect(diferencaComTiny(10, 10)).toEqual({ texto: "bate", alerta: false });
    expect(diferencaComTiny(1500, 1000)).toEqual({ texto: "Nexus tem 500 a mais", alerta: false });
    expect(diferencaComTiny(1000, 2500)).toEqual({ texto: "faltam 1.500 no Nexus", alerta: true });
  });
  it("medido há", () => {
    expect(medidoHa("2026-11-17T15:00:00Z", AGORA)).toBe("medido agora");
    expect(medidoHa("2026-11-17T14:55:00Z", AGORA)).toBe("medido há 5 min");
    expect(medidoHa("2026-11-17T12:00:00Z", AGORA)).toBe("medido há 3 h");
    expect(medidoHa("lixo", AGORA)).toBe("");
  });
});

describe("BalancoTiny", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("mostra parcelas, total, Tiny e diferença", () => {
    render(<BalancoTiny balanco={bal()} agora={AGORA} />);
    expect(screen.getByText(/Conta com o Tiny \(todos os canais\)/)).toBeTruthy();
    expect(screen.getByText("Abertos no Nexus")).toBeTruthy();
    expect(screen.getByText("1.692")).toBeTruthy();
    expect(screen.getByText("1.700")).toBeTruthy();
    expect(screen.getByText("(medido há 5 min)")).toBeTruthy();
    expect(screen.getByText("faltam 8 no Nexus")).toBeTruthy();
    expect(screen.queryByText("Em espera")).toBeNull();
    expect(screen.getByText(/O Tiny só tira o pedido de faturado quando ele é expedido\./)).toBeTruthy();
  });

  it("tiny nulo: sem medição", () => {
    render(<BalancoTiny balanco={bal({ tiny: null })} agora={AGORA} />);
    expect(screen.getByText("Tiny: sem medição agora")).toBeTruthy();
    expect(screen.queryByText(/Faturados no Tiny/)).toBeNull();
  });

  it("recolhe e lembra", () => {
    const { unmount } = render(<BalancoTiny balanco={bal()} agora={AGORA} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Abertos no Nexus")).toBeNull();
    unmount();
    render(<BalancoTiny balanco={bal()} agora={AGORA} />);
    expect(screen.queryByText("Abertos no Nexus")).toBeNull();
  });
});
