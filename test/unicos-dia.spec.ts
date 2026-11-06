import { describe, expect, it } from "vitest";
import { diaDe, filtrarPorDia, rotuloDia } from "../src/lib/unicosExpedicao";

describe("filtro por dia dos Únicos (Victor, 06/11/2026)", () => {
  it("diaDe usa America/Sao_Paulo (UTC-3)", () => {
    expect(diaDe("2026-11-05T02:30:00Z")).toBe("2026-11-04"); // 23:30 do dia 4 em SP
    expect(diaDe("2026-11-05T03:00:00Z")).toBe("2026-11-05");
    expect(diaDe(null)).toBeNull();
    expect(diaDe("lixo")).toBeNull();
  });
  it("filtrarPorDia filtra, e sem dia devolve tudo", () => {
    const ps = [{ id: "a", emitidoEm: "2026-11-04T15:00:00Z" }, { id: "b", emitidoEm: "2026-11-05T15:00:00Z" }, { id: "c", emitidoEm: null }];
    expect(filtrarPorDia(ps, "2026-11-04").map((p) => p.id)).toEqual(["a"]);
    expect(filtrarPorDia(ps, null)).toBe(ps);
  });
  it("rotuloDia", () => expect(rotuloDia("2026-11-04")).toBe("04/11"));
});
