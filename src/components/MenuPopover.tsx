// Menu "⋯" enxuto e reutilizável: botão de três pontinhos que abre uma lista de ações num popover.
// Fecha com Esc, clique fora, scroll/resize e ao escolher; navega por setas (↑ ↓ Home End).
// O popover vai pra um portal (fixed): a grade de cards tem overflow e cortaria o menu.
// O gatilho é um <span role="button"> porque costuma ficar DENTRO de um card que já é <button>.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";

export type ItemMenu = { chave: string; rotulo: string; onSelecionar: () => void };

export function MenuPopover({ rotuloAria, itens, estiloGatilho }: { rotuloAria: string; itens: ItemMenu[]; estiloGatilho?: CSSProperties }) {
  const [aberto, setAberto] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const gatilhoRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const fechar = useCallback((devolverFoco: boolean) => {
    setAberto(false);
    if (devolverFoco) gatilhoRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!aberto || !gatilhoRef.current) return;
    const r = gatilhoRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }, [aberto]);

  // Ao abrir, foco no 1º item.
  useEffect(() => {
    if (aberto && pos) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [aberto, pos]);

  useEffect(() => {
    if (!aberto) return;
    const fora = (ev: MouseEvent) => {
      const alvo = ev.target as Node;
      if (menuRef.current?.contains(alvo) || gatilhoRef.current?.contains(alvo)) return;
      fechar(false);
    };
    const tecla = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        fechar(true);
      }
    };
    const solto = () => fechar(false);
    document.addEventListener("mousedown", fora);
    window.addEventListener("keydown", tecla, true);
    window.addEventListener("resize", solto);
    window.addEventListener("scroll", solto, true);
    return () => {
      document.removeEventListener("mousedown", fora);
      window.removeEventListener("keydown", tecla, true);
      window.removeEventListener("resize", solto);
      window.removeEventListener("scroll", solto, true);
    };
  }, [aberto, fechar]);

  const alternar = (ev: ReactMouseEvent | ReactKeyboardEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    setAberto((v) => !v);
  };

  const teclaDoItem = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    const lista = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = lista.indexOf(document.activeElement as HTMLElement);
    const ir = (j: number) => {
      ev.preventDefault();
      lista[(j + lista.length) % lista.length]?.focus();
    };
    if (ev.key === "ArrowDown") ir(i + 1);
    else if (ev.key === "ArrowUp") ir(i - 1);
    else if (ev.key === "Home") ir(0);
    else if (ev.key === "End") ir(lista.length - 1);
    else if (ev.key === "Tab") fechar(false);
    ev.stopPropagation();
  };

  return (
    <>
      <span
        ref={gatilhoRef}
        role="button"
        tabIndex={0}
        aria-label={rotuloAria}
        aria-haspopup="menu"
        aria-expanded={aberto}
        style={{ ...gatilho, ...estiloGatilho }}
        onClick={alternar}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " " || ev.key === "ArrowDown") alternar(ev);
          else ev.stopPropagation();
        }}
      >
        ⋯
      </span>
      {aberto &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={rotuloAria}
            style={{ ...menu, top: pos?.top ?? 0, right: pos?.right ?? 0, visibility: pos ? "visible" : "hidden" }}
            onClick={(ev) => ev.stopPropagation()}
            onKeyDown={teclaDoItem}
          >
            {itens.map((it) => (
              <button
                key={it.chave}
                type="button"
                role="menuitem"
                style={item}
                onClick={(ev) => {
                  ev.stopPropagation();
                  fechar(true);
                  it.onSelecionar();
                }}
              >
                {it.rotulo}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

const gatilho: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontSize: 20,
  fontWeight: 900,
  lineHeight: 1,
  cursor: "pointer",
  userSelect: "none",
};
const menu: CSSProperties = {
  position: "fixed",
  zIndex: 1100,
  minWidth: 220,
  display: "flex",
  flexDirection: "column",
  padding: 4,
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong, var(--border))",
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
};
const item: CSSProperties = { padding: "10px 12px", textAlign: "left", background: "transparent", border: "none", borderRadius: 6, color: "var(--text)", fontSize: 14, fontWeight: 700, cursor: "pointer" };
