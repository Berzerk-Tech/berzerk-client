import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeloVariante } from "../src/components/SeloVariante";

describe("SeloVariante", () => {
  it("mostra o número com a cor da variante", () => {
    render(<SeloVariante nome="Oversized Freaky Season - Ganley 2 - P" tamanho="grande" />);
    const selo = screen.getByLabelText("Variante 2");
    expect(selo.textContent).toBe("2");
    expect(selo.style.background).toBe("rgb(234, 88, 12)");
  });
  it("não renderiza sem variante", () => {
    const { container } = render(<SeloVariante nome="Oversized - Rux - G1" />);
    expect(container.innerHTML).toBe("");
  });
  it("não renderiza sem nome", () => {
    const { container } = render(<SeloVariante nome={null} />);
    expect(container.innerHTML).toBe("");
  });
});
