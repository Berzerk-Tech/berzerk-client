import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { filtrarJobsDispensados, useJobsDispensados } from "../src/lib/jobsDispensados";

const falhou = { id: "j1", status: "falhou" };

describe("jobs de impressão dispensados (✕ da fila)", () => {
  beforeEach(() => localStorage.clear());

  it("dispensar esconde o job e um novo poll com o mesmo erro continua oculto", () => {
    const { result, rerender } = renderHook(({ jobs }) => useJobsDispensados(jobs), {
      initialProps: { jobs: [falhou] },
    });
    expect(result.current.visiveis).toHaveLength(1);
    act(() => result.current.dispensar("j1"));
    expect(result.current.visiveis).toHaveLength(0);
    // poll devolve o MESMO job falhado (novo objeto, mesmo id)
    rerender({ jobs: [{ ...falhou }] });
    expect(result.current.visiveis).toHaveLength(0);
    // erro novo (outro id) aparece
    rerender({ jobs: [{ ...falhou }, { id: "j2", status: "falhou" }] });
    expect(result.current.visiveis.map((j) => j.id)).toEqual(["j2"]);
  });

  it("persiste entre montagens e restaurar traz o job de volta", () => {
    const a = renderHook(() => useJobsDispensados([falhou]));
    act(() => a.result.current.dispensar("j1"));
    a.unmount();
    const b = renderHook(() => useJobsDispensados([falhou]));
    expect(b.result.current.visiveis).toHaveLength(0);
    act(() => b.result.current.restaurar("j1"));
    expect(b.result.current.visiveis).toHaveLength(1);
  });

  it("filtro puro", () => {
    expect(filtrarJobsDispensados([falhou], new Set())).toEqual([falhou]);
    expect(filtrarJobsDispensados([falhou], new Set(["j1"]))).toEqual([]);
  });
});
