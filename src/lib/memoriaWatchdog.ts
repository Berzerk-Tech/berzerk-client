// Vigia de memória do renderer (WebView2/Chromium).
//
// Quando o heap do renderer estoura, o Chromium troca a aplicação inteira pela
// página "Esta página está com problemas — Código de erro: Out of Memory". Foi
// o que aconteceu na bancada do CD em 27/08: a operadora perde a tela, e o lote
// dela fica reservado até alguém agir.
//
// Recarregar a janela ANTES disso é estritamente melhor: a sessão do Cognito
// está no localStorage, os pedidos continuam reservados no servidor e a tela de
// filas oferece "Retomar". A operadora perde ~3 segundos em vez do turno.
//
// O vigia não é a correção de nada — as causas (imagem original do CDN,
// listeners sem cleanup, cache sem teto) se corrigem no lugar delas. Ele é a
// rede embaixo: qualquer vazamento futuro vira um recarregamento explicado, e
// o log de 60 em 60 segundos dá a curva pra achar o culpado.

/** Acima disto, recarrega. Chromium x64 costuma limitar o heap em ~4 GB. */
const LIMITE_PADRAO_BYTES = 1.5 * 1024 * 1024 * 1024;
/** Ou 70% do teto que o próprio motor informa, o que for MENOR. */
const FRACAO_DO_TETO = 0.7;
const INTERVALO_MS = 60_000;

const MOTIVO_KEY = "berzerk_recarregou_por_memoria_v1";

type MemoriaChromium = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

function memoria(): MemoriaChromium | null {
  const m = (performance as Performance & { memory?: MemoriaChromium }).memory;
  return m && typeof m.usedJSHeapSize === "number" ? m : null;
}

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * Motivo do último recarregamento por memória — o App lê (e CONSOME) pra
 * explicar à operadora por que a tela piscou. Sem isso o recarregamento
 * pareceria um travamento aleatório, que é o oposto de ganhar confiança.
 */
export function tomarMotivoDeRecarregamento(): string | null {
  try {
    const raw = localStorage.getItem(MOTIVO_KEY);
    if (raw) localStorage.removeItem(MOTIVO_KEY);
    return raw;
  } catch {
    return null;
  }
}

/**
 * Liga o vigia. Devolve o desligamento (o App mantém ligado a vida toda, mas
 * o retorno mantém o efeito honesto e testável).
 */
export function iniciarWatchdogMemoria(): () => void {
  if (!memoria()) {
    // Fora do Chromium (ou com a flag desligada) não há o que medir — some,
    // em vez de fingir que está vigiando.
    return () => {};
  }
  const timer = setInterval(() => {
    const m = memoria();
    if (!m) return;
    const teto = Math.min(LIMITE_PADRAO_BYTES, m.jsHeapSizeLimit * FRACAO_DO_TETO);
    // Uma linha por minuto: é a curva que diz se o heap sobe com o turno.
    console.info(
      `[memoria] heap ${mb(m.usedJSHeapSize)} / total ${mb(m.totalJSHeapSize)} (limiar ${mb(teto)})`,
    );
    if (m.usedJSHeapSize < teto) return;
    console.error(
      `[memoria] heap em ${mb(m.usedJSHeapSize)} — recarregando a janela antes da página de OOM`,
    );
    try {
      localStorage.setItem(
        MOTIVO_KEY,
        `A tela foi recarregada para liberar memória (${mb(m.usedJSHeapSize)}). Seus pedidos continuam reservados.`,
      );
    } catch {
      /* sem storage: recarrega mudo, ainda melhor que a página de OOM */
    }
    clearInterval(timer);
    window.location.reload();
  }, INTERVALO_MS);
  return () => clearInterval(timer);
}
