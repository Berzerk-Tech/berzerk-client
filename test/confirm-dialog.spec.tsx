// Diálogo de confirmação in-app (tecla K / "Concluir com faltantes").
//
// `window.confirm` no WebView2 do Tauri volta `false` sem mostrar nada; o K
// "não fazia nada". O diálogo tem que responder a Enter/Esc UMA vez só e
// listar as peças que faltam.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

afterEach(cleanup);

function montar() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      tom="warning"
      titulo="Faltam 2 peças neste pedido"
      mensagem="Concluir mesmo assim?"
      detalhes={[
        { label: "Oversized - Bubble", meta: "XG", valor: "falta 1" },
        { label: "Oversized - Blossom", meta: "M", valor: "falta 1" },
      ]}
      confirmarLabel="Concluir com faltantes"
      cancelarLabel="Voltar"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("lista as peças que faltam e foca o diálogo (não o botão)", () => {
    montar();
    expect(screen.getByRole("dialog")).toBe(document.activeElement);
    expect(screen.getByText("Oversized - Bubble")).toBeTruthy();
    expect(screen.getByText("XG")).toBeTruthy();
    expect(screen.getAllByText("falta 1")).toHaveLength(2);
  });

  it("Enter confirma UMA vez; Esc cancela", () => {
    const { onConfirm, onCancel } = montar();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Enter não vaza pros atalhos globais da mesa", () => {
    montar();
    const global = vi.fn();
    window.addEventListener("keydown", global);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(global).not.toHaveBeenCalled(); // capture + stopPropagation
    window.removeEventListener("keydown", global);
  });

  it("botões clicáveis; clicar fora cancela", () => {
    const { onConfirm, onCancel } = montar();
    fireEvent.click(screen.getByRole("button", { name: /Concluir com faltantes/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Voltar/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
