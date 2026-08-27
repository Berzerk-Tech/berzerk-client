// jsdom não tem ResizeObserver (useFitCards observa a área de cards).
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO;

// Node 22 traz um `localStorage` global desabilitado que sombreia o do jsdom.
const store = new Map<string, string>();
const shim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
};
Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
if (typeof window !== "undefined")
  Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
