import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuPopover } from "../src/components/MenuPopover";

function montar() {
  const aGrade = vi.fn();
  const umTamanho = vi.fn();
  const clicouFora = vi.fn();
  render(
    <div>
      <button type="button" onClick={clicouFora}>
        fora
      </button>
      <MenuPopover
        rotuloAria="Mais opções de Leg Day Preto"
        itens={[
          { chave: "grade", rotulo: "Imprimir grade toda (250 pedidos)", onSelecionar: aGrade },
          { chave: "tamanho", rotulo: "Imprimir um tamanho…", onSelecionar: umTamanho },
        ]}
      />
    </div>,
  );
  return { aGrade, umTamanho, clicouFora };
}

describe("MenuPopover (⋯)", () => {
  afterEach(() => cleanup());

  it("abre pelo gatilho, mostra os itens e escolher fecha e chama a ação", () => {
    const { aGrade } = montar();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByLabelText("Mais opções de Leg Day Preto"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Imprimir grade toda (250 pedidos)", "Imprimir um tamanho…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /grade toda/ }));
    expect(aGrade).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Mais opções de Leg Day Preto"));
  });

  it("Esc fecha e devolve o foco ao gatilho", () => {
    montar();
    const gatilho = screen.getByLabelText("Mais opções de Leg Day Preto");
    fireEvent.click(gatilho);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(gatilho);
  });

  it("clique fora fecha sem escolher", () => {
    const { aGrade, umTamanho } = montar();
    fireEvent.click(screen.getByLabelText("Mais opções de Leg Day Preto"));
    fireEvent.mouseDown(screen.getByText("fora"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(aGrade).not.toHaveBeenCalled();
    expect(umTamanho).not.toHaveBeenCalled();
  });

  it("setas movem o foco entre os itens (com volta) e Enter no gatilho abre", () => {
    montar();
    const gatilho = screen.getByLabelText("Mais opções de Leg Day Preto");
    fireEvent.keyDown(gatilho, { key: "Enter" });
    const [a, b] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(b);
  });

  it("o clique no gatilho e nos itens não sobe pro card", () => {
    const card = vi.fn();
    render(
      <div onClick={card}>
        <MenuPopover rotuloAria="m" itens={[{ chave: "a", rotulo: "A", onSelecionar: () => {} }]} />
      </div>,
    );
    fireEvent.click(screen.getByLabelText("m"));
    fireEvent.click(screen.getByRole("menuitem"));
    expect(card).not.toHaveBeenCalled();
  });
});
