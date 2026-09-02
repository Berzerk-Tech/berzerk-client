import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog, type ConfirmDialogProps } from "../components/ConfirmDialog";

// `window.confirm` / `window.alert` em forma de Promise, com o diálogo do app.
//
// No WebView2 do Tauri v2 o `window.confirm` volta `false` SEM mostrar nada
// (foi o "K não faz nada" da Separação, 01/09) — na Etiquetagem eram cinco:
// descartar teste, reimprimir, voltar pra fila, movimentar EPCs e cancelar
// job, todos mudos. O `window.alert` até aparece, mas é a caixa cinza do
// Windows com "tauri.localhost diz". Este hook troca os dois pelo
// `ConfirmDialog`, mantendo a forma `const ok = await confirmar(...)`.

export type OpcoesDialogo = Pick<
  ConfirmDialogProps,
  "titulo" | "mensagem" | "detalhes" | "confirmarLabel" | "cancelarLabel" | "tom"
>;

type Pendente =
  | { tipo: "confirmar"; opcoes: OpcoesDialogo; resolve: (ok: boolean) => void }
  | { tipo: "aviso"; opcoes: OpcoesDialogo; resolve: () => void };

/**
 * Texto no formato dos antigos `window.confirm`/`alert` → título + mensagem.
 * Parágrafos separados por linha em branco: o primeiro é o título. Sem isso,
 * "Falha ao X: motivo" vira título "Falha ao X" e mensagem "motivo".
 */
export function separarTexto(texto: string): { titulo: string; mensagem?: string } {
  const t = texto.trim();
  const quebra = t.indexOf("\n\n");
  if (quebra > 0) return { titulo: t.slice(0, quebra).trim(), mensagem: t.slice(quebra + 2).trim() };
  const doisPontos = t.indexOf(": ");
  if (doisPontos > 0 && doisPontos < 80) {
    return { titulo: t.slice(0, doisPontos).trim(), mensagem: t.slice(doisPontos + 2).trim() };
  }
  return { titulo: t };
}

function normalizar(o: string | OpcoesDialogo): OpcoesDialogo {
  return typeof o === "string" ? separarTexto(o) : o;
}

export function useDialogo(): {
  /** Resolve `true` no Enter/botão, `false` no Esc/Cancelar/clique fora. */
  confirmar: (o: string | OpcoesDialogo) => Promise<boolean>;
  /** Um botão só; resolve quando fechar. */
  avisar: (o: string | OpcoesDialogo) => Promise<void>;
  /** Renderize uma vez, no fim do componente. */
  dialogo: ReactNode;
} {
  const [pendente, setPendente] = useState<Pendente | null>(null);

  const confirmar = useCallback(
    (o: string | OpcoesDialogo) =>
      new Promise<boolean>((resolve) => setPendente({ tipo: "confirmar", opcoes: normalizar(o), resolve })),
    [],
  );
  const avisar = useCallback(
    (o: string | OpcoesDialogo) =>
      new Promise<void>((resolve) => setPendente({ tipo: "aviso", opcoes: normalizar(o), resolve })),
    [],
  );

  const fechar = (ok: boolean) => {
    setPendente((p) => {
      if (!p) return null;
      if (p.tipo === "confirmar") p.resolve(ok);
      else p.resolve();
      return null;
    });
  };

  const dialogo = pendente ? (
    <ConfirmDialog
      {...pendente.opcoes}
      tom={pendente.opcoes.tom ?? (pendente.tipo === "aviso" ? "warning" : "neutro")}
      apenasAviso={pendente.tipo === "aviso"}
      onConfirm={() => fechar(true)}
      onCancel={() => fechar(false)}
    />
  ) : null;

  return { confirmar, avisar, dialogo };
}
