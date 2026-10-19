// `canal` da fila sempre vai pra rede (inclusive ecommerce); claimOrder só com canal explícito.
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiRequest: (...a: unknown[]) => apiRequest(...a) };
});

const o = await import("../src/services/orders");

describe("services/orders — canal", () => {
  beforeEach(() => apiRequest.mockReset().mockResolvedValue({ orders: [] }));

  it("getQueueCounts: canal sempre na query", async () => {
    await o.getQueueCounts(undefined, "mercado_livre");
    expect(apiRequest.mock.calls[0][1].query.canal).toBe("mercado_livre");
    await o.getQueueCounts(undefined, "ecommerce");
    await o.getQueueCounts();
    expect(apiRequest.mock.calls[1][1].query.canal).toBe("ecommerce");
    expect(apiRequest.mock.calls[2][1].query.canal).toBe("ecommerce");
  });

  it("claimLote / claimNext / claimNextMixed / claimOrder: canal sempre no body (claimOrder só explícito)", async () => {
    await o.claimLote({ mode: "normal", sizes: ["M"], canal: "mercado_livre" });
    expect(apiRequest.mock.calls[0][1].body.canal).toBe("mercado_livre");
    await o.claimLote({ mode: "normal", sizes: ["M"] });
    expect(apiRequest.mock.calls[1][1].body.canal).toBe("ecommerce");
    await o.claimNext(["M"], undefined, "mercado_livre");
    expect(apiRequest.mock.calls[2][1].body.canal).toBe("mercado_livre");
    await o.claimNextMixed(["M"], undefined, "mercado_livre");
    expect(apiRequest.mock.calls[3][1].body.canal).toBe("mercado_livre");
    await o.claimOrder("x", "mercado_livre");
    expect(apiRequest.mock.calls[4][1].body).toEqual({ orderId: "x", canal: "mercado_livre" });
    await o.claimOrder("x");
    expect(apiRequest.mock.calls[5][1].body).toEqual({ orderId: "x" });
  });

  it("getQueueProducts / getQueueDates: canal na query", async () => {
    await o.getQueueProducts({ mode: "normal", size: "M", canal: "mercado_livre" });
    expect(apiRequest.mock.calls[0][1].query.canal).toBe("mercado_livre");
    await o.getQueueDates({ mode: "normal", size: "M" });
    expect(apiRequest.mock.calls[1][1].query.canal).toBe("ecommerce");
  });
});
