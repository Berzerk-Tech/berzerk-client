// Trava de atualização — ninguém opera numa versão velha.
//
// Até a 0.9.1 o updater aparecia como um banner com "Mais tarde". Na mesa do
// CD "mais tarde" é nunca: as máquinas ficavam meses atrás, e cada correção
// publicada só valia pra quem por acaso clicou. Agora não há "mais tarde".
//
// Duas portas levam ao MESMO bloqueio, e a divisão entre elas é de propósito:
//
//  1. **426 do nexus** (`{ error: "app_desatualizado" }`) — a trava de VERDADE.
//     O servidor compara o header `X-Berzerk-Client-Version` com a versão
//     mínima que o admin configurou e recusa fila, etiquetagem e expedição.
//     Não tem como um app velho ignorar: quem responde é o outro lado.
//  2. **updater do GitHub** — o aviso ANTECIPADO, no boot e ao entrar em cada
//     módulo. Se o GitHub estiver fora, esta porta simplesmente não abre (só
//     loga): uma falha de rede não pode parar a operação. Por isso ela não
//     substitui a primeira — complementa.
//
// A tela do bloqueio (`UpdateRequired`) não tem botão de "continuar".

import { checkForUpdate, type AvailableUpdate } from "./updater";

export type Bloqueio =
  | {
      /** O nexus recusou: esta é a trava dura. */
      kind: "servidor";
      versaoMinima: string;
      versaoAtual: string | null;
      mensagem: string;
    }
  | {
      /** O updater achou versão nova antes de o servidor precisar recusar. */
      kind: "updater";
      update: AvailableUpdate;
    };

let atual: Bloqueio | null = null;
const listeners = new Set<(b: Bloqueio | null) => void>();

export function bloqueioAtual(): Bloqueio | null {
  return atual;
}

export function onBloqueioChange(fn: (b: Bloqueio | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

type AntesDeBloquear = () => void | Promise<void>;
const antes = new Set<AntesDeBloquear>();

/**
 * Registra algo que precisa rodar ANTES de a tela de bloqueio entrar — hoje
 * só a Separação, devolvendo o lote reservado. Sem isto os pedidos ficariam
 * invisíveis pras outras estações até o janitor expirar o claim, e a mesa
 * bloqueada teria levado o trabalho junto. Devolve o unsubscribe.
 */
export function onAntesDeBloquear(fn: AntesDeBloquear): () => void {
  antes.add(fn);
  return () => {
    antes.delete(fn);
  };
}

/** Teto pros hooks — uma API lenta não pode segurar a tela de bloqueio. */
const HOOKS_CAP_MS = 2500;
let emVoo: Promise<void> | null = null;

/**
 * Entra em bloqueio (idempotente: chamadas concorrentes reaproveitam a mesma
 * promessa). A reentrada importa de verdade aqui — o hook da Separação chama
 * `POST /separacao/lote/devolver`, que também pode voltar 426 e chegar aqui de
 * novo no meio do próprio bloqueio.
 */
export function bloquear(b: Bloqueio): Promise<void> {
  if (emVoo) return emVoo;
  // Um bloqueio do SERVIDOR nunca é rebaixado para um do updater: o primeiro é
  // uma recusa, o segundo é um aviso.
  if (atual?.kind === "servidor" && b.kind === "updater") return Promise.resolve();

  emVoo = (async () => {
    const hooks = Array.from(antes).map((fn) =>
      Promise.resolve()
        .then(fn)
        .catch(() => undefined),
    );
    await Promise.race([
      Promise.allSettled(hooks),
      new Promise((r) => setTimeout(r, HOOKS_CAP_MS)),
    ]);
    atual = b;
    for (const fn of listeners) fn(atual);
  })().finally(() => {
    emVoo = null;
  });
  return emVoo;
}

/**
 * Consulta o updater e bloqueia SE houver versão nova. Chamada no boot e ao
 * entrar em cada módulo (Separação, Etiquetagem, Expedição).
 *
 * Falha (GitHub fora, sem rede, máquina sem saída) NÃO bloqueia: só loga. A
 * mesa continua trabalhando, e quem garante o piso continua sendo o 426 do
 * nexus — que vem pela conexão que a mesa precisa ter de qualquer jeito.
 */
export async function verificarAtualizacao(): Promise<void> {
  try {
    const update = await checkForUpdate();
    if (update) await bloquear({ kind: "updater", update });
  } catch (err) {
    console.warn("update check falhou (segue operando):", err);
  }
}
