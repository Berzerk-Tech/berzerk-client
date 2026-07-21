import { supabase } from "../lib/supabase";
import { isEan13Format } from "../lib/ean13";

export type EanSource = "local" | "shopify";

export type EanLookupResult = {
  eans: Record<string, string>;
  skus: Record<string, string>;
  sources: Record<string, EanSource>;
  missingSizes: string[];
  shopifyProduct: {
    id: string;
    title: string;
    color: string | null;
  } | null;
  /**
   * Nome canônico do produto no Shopify (`unified_products.shopify_product_name`,
   * cacheado de `shopify_product_designs.shopify_product_title`). É a "Referência
   * Shopify" — string única já combinada (ex: "Oversized - Hello Kitty"). Usada
   * como nome impresso na etiqueta quando não há Referência Tiny. null = sem
   * cache resolvido pro produto.
   */
  shopifyReference: string | null;
  unifiedProductId: string | null;
  /**
   * True quando sobraram tamanhos sem EAN local E a chamada pro Shopify foi
   * pulada (`skipShopifyFallback`). UI pode mostrar botão "Buscar no Shopify"
   * pra subir o lookup sob demanda.
   */
  shopifyFallbackAvailable: boolean;
};

export type LookupInput = {
  designName: string | null | undefined;
  shirtColor: string | null | undefined;
  sizes: string[];
  /**
   * Pula `loadShopifyProduct` se sobrarem tamanhos sem EAN local. Usado pelo
   * load inicial da Produção pra evitar 50+ edge function calls em série
   * antes do operador ver a lista. Cache em memória/localStorage ainda é
   * consultado — só pula o fetch novo.
   */
  skipShopifyFallback?: boolean;
};

type ShopifyVariant = {
  option1?: string | null;
  option2?: string | null;
  barcode?: string | null;
  sku?: string | null;
};

type ShopifyProduct = {
  id: string | number;
  title: string;
  variants?: ShopifyVariant[];
};

function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Normalização "forte" pra casar nome de estampa ↔ design_template: além de
 * acentos/case, colapsa qualquer pontuação/espaço num único espaço. Assim
 * "Comam Frutas - Morango retro" casa com "Comam Frutas morango retro" —
 * renomear o lote não perde o vínculo. Replica `normName` do industrial
 * (`src/backend/services/rfidEanLookup.ts`).
 */
function normName(s: string | null | undefined): string {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ────────────────────────────────────────────────────────────
// Caches — module-level, session-scoped. Cleared via clearLookupCaches().
// Esse cache é o que torna resolveBatch barato quando rodado em paralelo
// pra 50 batches: ao invés de 50 hits em design_templates + ~20 em
// unified_products + ~20 em shopify-analytics, vira 1 + N + N (cada
// produto único é buscado uma vez só).
// ────────────────────────────────────────────────────────────

type DesignTemplateEntry = {
  shopify_product_id: string | null;
  thumbnail: string | null;
};

const designTemplateByName = new Map<string, DesignTemplateEntry>();
// Índice tolerante: normName(name) → set de shopify_product_ids (só não-nulos).
// Usado no fallback de match quando o nome exato não bate (pontuação/acento).
const designShopifyIdByNormName = new Map<string, Set<string>>();
let designTemplatesLoaded = false;
let designTemplatesLoading: Promise<void> | null = null;

async function loadDesignTemplates(): Promise<void> {
  if (designTemplatesLoaded) return;
  if (designTemplatesLoading) return designTemplatesLoading;
  designTemplatesLoading = (async () => {
    try {
      const { data, error } = await supabase
        .from("design_templates")
        .select("name, shopify_product_id, images")
        .eq("active", true);
      if (error || !data) {
        designTemplatesLoaded = true;
        return;
      }
      for (const d of data) {
        if (!d.name) continue;
        const lname = String(d.name).toLowerCase();
        const shopifyId = d.shopify_product_id
          ? String(d.shopify_product_id)
          : null;
        const imgs = d.images as { frente?: string[] } | null;
        const thumb = imgs?.frente?.[0] ?? null;
        // Pode haver mais de um template com o mesmo nome (ex: um sem vínculo
        // Shopify). PREFERE o que tem shopify_product_id — senão o desktop
        // pega a versão sem vínculo e o lote vira "não cadastrado". Espelha o
        // `.not("shopify_product_id","is",null)` do industrial.
        const existing = designTemplateByName.get(lname);
        if (!existing || (!existing.shopify_product_id && shopifyId)) {
          designTemplateByName.set(lname, {
            shopify_product_id: shopifyId,
            thumbnail: thumb ?? existing?.thumbnail ?? null,
          });
        } else if (existing && !existing.thumbnail && thumb) {
          existing.thumbnail = thumb;
        }
        if (shopifyId) {
          const key = normName(d.name as string);
          const set = designShopifyIdByNormName.get(key) ?? new Set<string>();
          set.add(shopifyId);
          designShopifyIdByNormName.set(key, set);
        }
      }
      designTemplatesLoaded = true;
    } catch (e) {
      console.warn("[ean13Lookup] loadDesignTemplates failed:", e);
      designTemplatesLoaded = true;
    } finally {
      designTemplatesLoading = null;
    }
  })();
  return designTemplatesLoading;
}

/**
 * Resolve `design_name` do lote → `shopify_product_id`, espelhando o industrial:
 *   1. match exato por nome (case-insensitive) COM vínculo Shopify;
 *   2. fallback tolerante por `normName` — só aceita se houver UM único
 *      shopify_product_id candidato (evita casar estampa errada);
 *   3. fallback por sufixo: lotes de dry tech/poliamida vêm com design_name
 *      "Cor - Estampa" (ex: "Marrom - Symbol"), mas o template carrega o nome
 *      COMPLETO do produto ("Poliamida Tech Running - Marrom - Symbol").
 *      Casa quando o nome do template TERMINA no design do lote (limite de
 *      palavra), e só se sobrar UM shopify_product_id candidato. NÃO casar
 *      segmento solto ("Marrom") — existe template "Marrom" de outro produto
 *      e o lote sairia com EAN errado.
 * Requer `loadDesignTemplates()` antes.
 */
function resolveShopifyIdForDesign(designName: string): string | null {
  const exact = designTemplateByName.get(designName.toLowerCase());
  if (exact?.shopify_product_id) return exact.shopify_product_id;
  const dn = normName(designName);
  if (!dn) return null;
  const set = designShopifyIdByNormName.get(dn);
  if (set && set.size === 1) return [...set][0];
  const suffix = ` ${dn}`;
  const candidates = new Set<string>();
  for (const [tplNorm, sids] of designShopifyIdByNormName) {
    if (tplNorm.endsWith(suffix)) for (const sid of sids) candidates.add(sid);
  }
  if (candidates.size === 1) return [...candidates][0];
  return null;
}

type UnifiedProductEntry = {
  unifiedProductId: string | null;
  barcodes: Record<string, string>;
  shopifyProductName: string | null;
};

const unifiedByShopify = new Map<string, UnifiedProductEntry>();
const unifiedLoading = new Map<string, Promise<void>>();

async function loadUnifiedProduct(shopifyId: string): Promise<void> {
  if (unifiedByShopify.has(shopifyId)) return;
  if (unifiedLoading.has(shopifyId)) return unifiedLoading.get(shopifyId);
  const p = (async () => {
    try {
      const { data } = await supabase
        .from("unified_products")
        .select("id, overrides, shopify_product_name")
        .eq("shopify_product_id", shopifyId)
        .limit(1)
        .maybeSingle();
      if (!data) {
        unifiedByShopify.set(shopifyId, {
          unifiedProductId: null,
          barcodes: {},
          shopifyProductName: null,
        });
        return;
      }
      const overrides = (data.overrides ?? {}) as {
        barcodes?: Record<string, string>;
      };
      const raw = overrides.barcodes ?? {};
      const barcodes: Record<string, string> = {};
      for (const [size, ean] of Object.entries(raw)) {
        if (typeof ean === "string" && isEan13Format(ean.trim())) {
          barcodes[size.toUpperCase()] = ean.trim();
        }
      }
      const shopifyProductName =
        typeof data.shopify_product_name === "string" &&
        data.shopify_product_name.trim()
          ? data.shopify_product_name.trim()
          : null;
      unifiedByShopify.set(shopifyId, {
        unifiedProductId: data.id as string,
        barcodes,
        shopifyProductName,
      });
    } catch (e) {
      console.warn("[ean13Lookup] loadUnifiedProduct failed:", e);
      unifiedByShopify.set(shopifyId, {
        unifiedProductId: null,
        barcodes: {},
        shopifyProductName: null,
      });
    } finally {
      unifiedLoading.delete(shopifyId);
    }
  })();
  unifiedLoading.set(shopifyId, p);
  return p;
}

const shopifyByProductId = new Map<string, ShopifyProduct>();
const shopifyLoading = new Map<string, Promise<ShopifyProduct | null>>();

// ── Cache em localStorage com TTL ──────────────────────────────
// O cache em memória dura só a sessão. Pra evitar refazer todo o trabalho de
// shopify-analytics ao reabrir o app, persistimos os produtos resolvidos em
// localStorage com TTL de 1h. Hidratamos o Map em memória no load do módulo.
const SHOPIFY_CACHE_KEY = "berzerk-rfid:shopify-cache:v1";
const SHOPIFY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

type CachedShopifyEntry = {
  product: ShopifyProduct;
  cachedAt: number;
};

function readShopifyStorage(): Record<string, CachedShopifyEntry> {
  try {
    const raw = localStorage.getItem(SHOPIFY_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("[ean13Lookup] readShopifyStorage failed:", e);
    return {};
  }
}

function writeShopifyStorage(cache: Record<string, CachedShopifyEntry>): void {
  try {
    localStorage.setItem(SHOPIFY_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // QuotaExceeded ou Privacy mode — silencioso, cache só em memória.
    console.warn("[ean13Lookup] writeShopifyStorage failed:", e);
  }
}

function hydrateShopifyCacheFromStorage(): void {
  const stored = readShopifyStorage();
  const now = Date.now();
  for (const [id, entry] of Object.entries(stored)) {
    if (entry?.product && now - entry.cachedAt < SHOPIFY_CACHE_TTL_MS) {
      shopifyByProductId.set(id, entry.product);
    }
  }
}

function persistShopifyEntry(id: string, product: ShopifyProduct): void {
  const cache = readShopifyStorage();
  const now = Date.now();
  // GC enquanto estamos aqui — evita storage crescer pra sempre
  for (const k of Object.keys(cache)) {
    if (!cache[k] || now - cache[k].cachedAt >= SHOPIFY_CACHE_TTL_MS) {
      delete cache[k];
    }
  }
  cache[id] = { product, cachedAt: now };
  writeShopifyStorage(cache);
}

// Hidrata uma vez no load do módulo. Tauri/Vite sempre têm localStorage.
hydrateShopifyCacheFromStorage();

async function tryFetchShopify(
  productId: string,
): Promise<{ ok: true; product: ShopifyProduct | null } | { ok: false }> {
  try {
    const { data, error } = await supabase.functions.invoke(
      "shopify-analytics",
      { body: { action: "product-by-id", productId } },
    );
    if (error) {
      console.warn("[ean13Lookup] shopify-analytics error:", error);
      return { ok: false };
    }
    const product =
      (data as { product?: ShopifyProduct } | null)?.product ?? null;
    return { ok: true, product };
  } catch (e) {
    console.warn("[ean13Lookup] shopify-analytics threw:", e);
    return { ok: false };
  }
}

async function loadShopifyProduct(
  productId: string,
): Promise<ShopifyProduct | null> {
  // Só CACHE sucessos. Falhas (timeout/erro) NÃO ficam no cache — assim a
  // próxima chamada tenta de novo em vez de retornar null preso.
  const cached = shopifyByProductId.get(productId);
  if (cached !== undefined) return cached;
  if (shopifyLoading.has(productId)) return shopifyLoading.get(productId)!;
  const p = (async () => {
    // Até 3 tentativas com backoff (500ms, 1000ms)
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await tryFetchShopify(productId);
      if (r.ok) {
        if (r.product) {
          shopifyByProductId.set(productId, r.product);
          persistShopifyEntry(productId, r.product);
        }
        // Se r.product === null (produto realmente não existe), não cacheamos.
        // Próximas chamadas vão tentar de novo — desperdício pequeno em
        // troca de consistência forte.
        return r.product;
      }
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
    }
    return null;
  })().then((result) => {
    shopifyLoading.delete(productId);
    return result;
  });
  shopifyLoading.set(productId, p);
  return p;
}

/**
 * Limpa todos os caches de catálogo. Chamar quando o operador clicar
 * Atualizar pra forçar refetch dos dados.
 */
export function clearLookupCaches(): void {
  designTemplateByName.clear();
  designShopifyIdByNormName.clear();
  designTemplatesLoaded = false;
  designTemplatesLoading = null;
  unifiedByShopify.clear();
  unifiedLoading.clear();
  shopifyByProductId.clear();
  shopifyLoading.clear();
  try {
    localStorage.removeItem(SHOPIFY_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Limpa só o cache do shopify-analytics. Útil quando uma chamada falhou
 * e queremos garantir retry no próximo load sem invalidar design_templates
 * e unified_products (que mudam menos).
 */
export function clearShopifyCache(): void {
  shopifyByProductId.clear();
  shopifyLoading.clear();
  try {
    localStorage.removeItem(SHOPIFY_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Thumbnail do design (do design_templates.images.frente[0]).
 * Requer loadDesignTemplates() ter sido chamado antes.
 */
export function getDesignThumbnail(
  designName: string | null | undefined,
): string | null {
  if (!designName) return null;
  return (
    designTemplateByName.get(designName.toLowerCase())?.thumbnail ?? null
  );
}

/**
 * Garante que design_templates está carregado no cache. Útil pra batches.ts
 * chamar uma vez antes de pedir thumbnails.
 */
export async function ensureDesignTemplatesLoaded(): Promise<void> {
  await loadDesignTemplates();
}

// ────────────────────────────────────────────────────────────
// Public API — getEansForBatch
// ────────────────────────────────────────────────────────────

export async function getEansForBatch(
  input: LookupInput,
): Promise<EanLookupResult> {
  const empty = (): EanLookupResult => ({
    eans: {},
    skus: {},
    sources: {},
    missingSizes: [...input.sizes],
    shopifyProduct: null,
    shopifyReference: null,
    unifiedProductId: null,
    shopifyFallbackAvailable: false,
  });

  try {
    const designName = input.designName?.trim();
    if (!designName || input.sizes.length === 0) return empty();

    // 1. design_templates → shopify_product_id (cached, match exato + tolerante)
    await loadDesignTemplates();
    const shopifyId = resolveShopifyIdForDesign(designName);
    if (!shopifyId) return empty();

    // 2. unified_products.overrides.barcodes (cached por shopify_product_id)
    await loadUnifiedProduct(shopifyId);
    const local = unifiedByShopify.get(shopifyId);
    const localBarcodes = local?.barcodes ?? {};
    const unifiedProductId = local?.unifiedProductId ?? null;
    const shopifyReference = local?.shopifyProductName ?? null;

    const eans: Record<string, string> = {};
    const skus: Record<string, string> = {};
    const sources: Record<string, EanSource> = {};

    for (const sz of input.sizes) {
      const localEan = localBarcodes[sz.toUpperCase()];
      if (localEan) {
        eans[sz] = localEan;
        skus[sz] = localEan;
        sources[sz] = "local";
      }
    }

    const stillMissing = input.sizes.filter((sz) => !eans[sz]);
    let shopifyProduct: EanLookupResult["shopifyProduct"] = null;
    let shopifyFallbackAvailable = false;

    // 3. Shopify fallback (cached por shopify_product_id)
    //
    // Se o caller pediu skipShopifyFallback E não temos cache em memória
    // (nem hidratação do localStorage), pulamos a edge function e marcamos
    // que o lookup pode ser completado depois — UI mostra "Buscar no Shopify".
    const inMemoryShopify = shopifyByProductId.get(shopifyId);
    const canUseCachedShopify = inMemoryShopify !== undefined;
    const shouldFetchShopify =
      stillMissing.length > 0 &&
      (canUseCachedShopify || !input.skipShopifyFallback);

    if (stillMissing.length === 0) {
      // Tudo coberto pelo unified local — sintetiza display do designName.
      shopifyProduct = {
        id: shopifyId,
        title: designName,
        color: input.shirtColor ?? null,
      };
    } else if (shouldFetchShopify) {
      const product = canUseCachedShopify
        ? inMemoryShopify
        : await loadShopifyProduct(shopifyId);
      if (product?.variants?.length) {
        const targetColor = normalize(input.shirtColor);
        const detectedColors = new Set<string>();

        for (const sz of stillMissing) {
          const szNorm = normalize(sz);
          const sameSize = product.variants.filter(
            (v) => normalize(v.option1) === szNorm,
          );
          if (sameSize.length === 0) continue;
          let chosen = sameSize.find(
            (v) => targetColor && normalize(v.option2) === targetColor,
          );
          if (!chosen) chosen = sameSize[0];
          if (chosen.option2) detectedColors.add(chosen.option2);

          // Berzerk: alguns variants têm barcode=null mas sku é EAN13
          const bc = (chosen.barcode ?? "").trim();
          const skuField = (chosen.sku ?? "").trim();
          const ean = isEan13Format(bc)
            ? bc
            : isEan13Format(skuField)
              ? skuField
              : "";
          if (ean) {
            eans[sz] = ean;
            skus[sz] = skuField || ean;
            sources[sz] = "shopify";
          }
        }

        const displayColor =
          [...detectedColors].find((c) => normalize(c) === targetColor) ??
          [...detectedColors][0] ??
          input.shirtColor ??
          null;

        shopifyProduct = {
          id: shopifyId,
          title: product.title,
          color: displayColor,
        };
      } else if (unifiedProductId) {
        shopifyProduct = {
          id: shopifyId,
          title: designName,
          color: input.shirtColor ?? null,
        };
      }
    } else {
      // stillMissing > 0 e Shopify foi pulado (sem cache em memória) —
      // marca pra UI oferecer "Buscar no Shopify" sob demanda.
      shopifyFallbackAvailable = true;
    }

    return {
      eans,
      skus,
      sources,
      missingSizes: input.sizes.filter((sz) => !eans[sz]),
      shopifyProduct,
      shopifyReference,
      unifiedProductId,
      shopifyFallbackAvailable,
    };
  } catch (e) {
    console.warn("[ean13Lookup] getEansForBatch threw:", e);
    return empty();
  }
}
