import { describe, expect, it } from "vitest";
import { basesDeLookup } from "../src/lib/rfid";

const BERZERK = "https://itag2.itagalert.com.br/itagalert_berzerk";

describe("basesDeLookup — ordem dos ambientes da iTAG no lookup EPC→peça (26/10)", () => {
  it("berzerk primeiro; o ambiente configurado pra impressão (integracao) só depois", () => {
    expect(basesDeLookup("http://itag2.itagalert.com.br/itagalert_integracao")).toEqual([
      BERZERK,
      "http://itag2.itagalert.com.br/itagalert_integracao",
    ]);
  });

  it("não repete o berzerk quando a estação já imprime nele (protocolo/barra final não contam)", () => {
    expect(basesDeLookup("http://itag2.itagalert.com.br/itagalert_berzerk/")).toEqual([BERZERK]);
  });

  it("configuração vazia = só o berzerk", () => {
    expect(basesDeLookup("  ")).toEqual([BERZERK]);
  });
});
