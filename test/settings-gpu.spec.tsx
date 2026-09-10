// Toggle "Desativar Aceleração de Hardware (GPU)" nas Configurações — a
// preferência mora num arquivo lido pelo Rust antes do WebView2 subir (não
// localStorage), então a troca só faz efeito depois de reiniciar o app.
// Ver src/lib/gpu.ts e src-tauri/src/gpu_prefs.rs.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const relaunch = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: (...a: unknown[]) => relaunch(...a) }));

const { GpuSettings } = await import("../src/components/GpuSettings");

beforeEach(() => {
  invoke.mockReset();
  relaunch.mockReset();
});

afterEach(cleanup);

describe("GpuSettings", () => {
  it("renderiza o toggle e o texto explicativo com o estado inicial de gpu_get_disabled", async () => {
    invoke.mockResolvedValueOnce(true); // gpu_get_disabled
    await act(async () => {
      render(<GpuSettings />);
    });

    expect(invoke).toHaveBeenCalledWith("gpu_get_disabled");
    expect(screen.getByText("Desativar Aceleração de Hardware (GPU)")).toBeTruthy();
    expect(
      screen.getByText(
        "Recomendado ativar caso a tela apresente tremores ou cintilações de renderização em placas de vídeo integradas/antigas.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
  });

  it("alternar chama gpu_set_disabled e mostra o toast + botão de reiniciar", async () => {
    invoke.mockResolvedValueOnce(false); // gpu_get_disabled no mount
    await act(async () => {
      render(<GpuSettings />);
    });
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));

    invoke.mockResolvedValueOnce(undefined); // gpu_set_disabled
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"));
    });

    expect(invoke).toHaveBeenCalledWith("gpu_set_disabled", { disabled: true });
    expect(screen.getByText("Reinicie o Berzerk Client para aplicar a alteração.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reiniciar agora" })).toBeTruthy();
  });

  it('clicar "Reiniciar agora" chama relaunch', async () => {
    invoke.mockResolvedValueOnce(false); // gpu_get_disabled no mount
    await act(async () => {
      render(<GpuSettings />);
    });
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));

    invoke.mockResolvedValueOnce(undefined); // gpu_set_disabled
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Reiniciar agora" }));
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
