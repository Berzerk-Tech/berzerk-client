// Enxurrada de GET (revisão 10/11): `periodo` chega como objeto novo a cada render
// do pai; as telas de Únicos não podem refazer o GET nem o intervalo de 30 s por isso.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUnicos = vi.fn();
const getUnicosPedidos = vi.fn();
vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return { ...real, getUnicos: (...a: unknown[]) => getUnicos(...a), getUnicosPedidos: (...a: unknown[]) => getUnicosPedidos(...a) };
});
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getMe: async () => ({ permissions: [] }) };
});

const { UnicosFila } = await import("../src/components/expedicao/UnicosFila");
const { UnicosGrupos } = await import("../src/components/expedicao/UnicosGrupos");

beforeEach(() => {
  getUnicos.mockReset().mockResolvedValue({ grupos: [], totalPedidos: 0, filaUnicosAtiva: true, periodo: { de: null, ate: null } });
  getUnicosPedidos.mockReset().mockResolvedValue([{ id: "o1", numero: "1", cliente: "C", produtoNome: "P", prioritario: false, emitidoEm: "2026-11-03T15:00:00.000Z" }]);
});
afterEach(() => cleanup());

describe("período estável nas telas de Únicos", () => {
  it("UnicosFila: re-render com período igual (objeto novo) não refaz o GET", async () => {
    const props = { grupo: { estampa: "Leg Day", tamanho: "G", cor: null }, versao: 0, onTrocar: () => {}, onEsgotou: () => {}, mesaLivre: false };
    const { rerender } = render(<UnicosFila {...props} periodo={{ de: "2026-11-03", ate: "2026-11-03" }} />);
    await waitFor(() => expect(getUnicosPedidos).toHaveBeenCalledTimes(1));
    rerender(<UnicosFila {...props} periodo={{ de: "2026-11-03", ate: "2026-11-03" }} />);
    rerender(<UnicosFila {...props} periodo={{ de: "2026-11-03", ate: "2026-11-03" }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(getUnicosPedidos).toHaveBeenCalledTimes(1);
    // Mudar de fato o período refaz.
    rerender(<UnicosFila {...props} periodo={{ de: "2026-11-04", ate: "2026-11-04" }} />);
    await waitFor(() => expect(getUnicosPedidos).toHaveBeenCalledTimes(2));
  });

  it("UnicosGrupos: re-render com período igual (objeto novo) não refaz o GET", async () => {
    const onSuporte = () => {};
    const onIndisponivel = () => {};
    const render1 = (periodo: { de: string | null; ate: string | null }) => (
      <UnicosGrupos onEscolher={() => {}} onIndisponivel={onIndisponivel} periodo={periodo} onPeriodo={() => {}} suportado={true} onSuporte={onSuporte} />
    );
    const { rerender } = render(render1({ de: "2026-11-03", ate: "2026-11-05" }));
    await waitFor(() => expect(getUnicos).toHaveBeenCalledTimes(1));
    rerender(render1({ de: "2026-11-03", ate: "2026-11-05" }));
    rerender(render1({ de: "2026-11-03", ate: "2026-11-05" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(getUnicos).toHaveBeenCalledTimes(1);
  });
});
