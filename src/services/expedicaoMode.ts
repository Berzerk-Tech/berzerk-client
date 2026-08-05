// Config da Expedição — flags de operação DENTRO do app (Configurações), não
// via .env. Persistem por estação (localStorage). O .env só fornece um valor
// PADRÃO inicial; a decisão final é do toggle no app.
//
// MODO TESTE  — roda o fluxo completo na mesa (identifica, confere, imprime),
//               mas NÃO chama o ship: nenhum efeito no sistema (nem no nexus,
//               nem no legado minhaconta bzk). Repetível à vontade.
// MODO OFICIAL— ao fechar o pacote, chama o ship de verdade (marca shipped +
//               replica a movimentação pro Tiny).
//
// SIMULAÇÃO   — usa pedidos fictícios (sem servidor), só pra treinar/validar a
//               tela quando o nexus ainda não respondeu. Desligada por padrão.
//
// Começa SEMPRE em TESTE (trava de segurança): a virada pra OFICIAL é uma
// escolha consciente em Configurações → Expedição.

export type ExpedicaoMode = "teste" | "oficial";

const MODE_KEY = "berzerk_expedicao_modo_v1";
const MOCK_KEY = "berzerk_expedicao_simulacao_v1";

function envMode(): ExpedicaoMode {
  return import.meta.env.VITE_EXPEDICAO_MODO === "oficial" ? "oficial" : "teste";
}

export function getExpedicaoMode(): ExpedicaoMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === "oficial" || raw === "teste") return raw;
    return envMode();
  } catch {
    return envMode();
  }
}

export function setExpedicaoMode(mode: ExpedicaoMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Conveniência booleana pro toggle de Configurações ("Modo teste": on/off). */
export function isModoTeste(): boolean {
  return getExpedicaoMode() === "teste";
}

export function setModoTeste(on: boolean): void {
  setExpedicaoMode(on ? "teste" : "oficial");
}

// --- Simulação (mock) --------------------------------------------------------

function envMock(): boolean {
  return import.meta.env.VITE_EXPEDICAO_MOCK === "true";
}

export function isExpedicaoSimulacao(): boolean {
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return envMock();
  } catch {
    return envMock();
  }
}

export function setExpedicaoSimulacao(on: boolean): void {
  try {
    localStorage.setItem(MOCK_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
}
