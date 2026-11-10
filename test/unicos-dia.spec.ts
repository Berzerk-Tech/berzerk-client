import { describe, expect, it } from "vitest";
import { ajustarPeriodo, diaDe, escolherPeriodo, filtrarPorDia, filtrarPorPeriodo, PERIODO_VAZIO, periodoEfetivo, rotuloDia, rotuloPeriodo, type PeriodoUnicos } from "../src/lib/unicosExpedicao";

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

describe("filtro por intervalo dos Únicos (10/11/2026)", () => {
  const ps = [
    { id: "a", emitidoEm: "2026-10-31T15:00:00Z" },
    { id: "b", emitidoEm: "2026-11-03T15:00:00Z" },
    { id: "c", emitidoEm: "2026-11-05T15:00:00Z" },
    { id: "d", emitidoEm: null },
  ];
  const ids = (p: PeriodoUnicos) => filtrarPorPeriodo(ps, p).map((x) => x.id);
  it("filtrarPorPeriodo: inclusivo, só de, só até, vazio", () => {
    expect(ids({ de: "2026-10-31", ate: "2026-11-03" })).toEqual(["a", "b"]);
    expect(ids({ de: "2026-11-03", ate: null })).toEqual(["b", "c"]);
    expect(ids({ de: null, ate: "2026-11-03" })).toEqual(["a", "b"]);
    expect(ids({ de: "2026-11-05", ate: "2026-11-05" })).toEqual(["c"]);
    expect(filtrarPorPeriodo(ps, PERIODO_VAZIO)).toBe(ps);
  });
  it("rotuloPeriodo", () => {
    expect(rotuloPeriodo({ de: "2026-10-31", ate: "2026-11-05" })).toBe("31/10 a 05/11");
    expect(rotuloPeriodo({ de: "2026-10-31", ate: null })).toBe("a partir de 31/10");
    expect(rotuloPeriodo({ de: null, ate: "2026-11-05" })).toBe("até 05/11");
    expect(rotuloPeriodo({ de: "2026-11-05", ate: "2026-11-05" })).toBe("05/11");
    expect(rotuloPeriodo(PERIODO_VAZIO)).toBe("");
  });
  it("ajustarPeriodo nunca inverte", () => {
    expect(ajustarPeriodo({ de: null, ate: "2026-11-03" }, "de", "2026-11-05")).toEqual({ de: "2026-11-05", ate: "2026-11-05" });
    expect(ajustarPeriodo({ de: "2026-11-03", ate: null }, "ate", "2026-11-01")).toEqual({ de: "2026-11-01", ate: "2026-11-01" });
    expect(ajustarPeriodo({ de: "2026-11-01", ate: "2026-11-05" }, "ate", "")).toEqual({ de: "2026-11-01", ate: null });
  });
  it("periodoEfetivo colapsa em um dia só quando a API não suporta", () => {
    const p = { de: "2026-10-31", ate: "2026-11-05" };
    expect(periodoEfetivo(p, true)).toBe(p);
    // Suporte desconhecido (null) NÃO é prova: só um dia, como na API antiga.
    expect(periodoEfetivo(p, null)).toEqual({ de: "2026-10-31", ate: "2026-10-31" });
    expect(periodoEfetivo(p, false)).toEqual({ de: "2026-10-31", ate: "2026-10-31" });
    expect(periodoEfetivo({ de: null, ate: "2026-11-05" }, false)).toEqual({ de: "2026-11-05", ate: "2026-11-05" });
    expect(periodoEfetivo(PERIODO_VAZIO, false)).toEqual(PERIODO_VAZIO);
  });
});

describe("escolherPeriodo", () => {
  it("sem suporte provado, 'De' grava um dia fechado e 'Até' é ignorado", () => {
    for (const suportado of [false, null] as const) {
      expect(escolherPeriodo(PERIODO_VAZIO, "de", "2026-11-03", suportado)).toEqual({ de: "2026-11-03", ate: "2026-11-03" });
      expect(escolherPeriodo({ de: "2026-11-03", ate: "2026-11-03" }, "de", null, suportado)).toEqual(PERIODO_VAZIO);
      const p = { de: "2026-11-03", ate: "2026-11-03" };
      expect(escolherPeriodo(p, "ate", "2026-11-09", suportado)).toBe(p);
    }
  });

  it("com suporte provado segue o ajuste normal do intervalo", () => {
    expect(escolherPeriodo(PERIODO_VAZIO, "de", "2026-11-03", true)).toEqual({ de: "2026-11-03", ate: null });
    expect(escolherPeriodo({ de: "2026-11-03", ate: null }, "ate", "2026-11-05", true)).toEqual({ de: "2026-11-03", ate: "2026-11-05" });
  });
});
