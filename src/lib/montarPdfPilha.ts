// Monta UM PDF com as folhas da pilha (capas e etiquetas) já resolvidas, pra quem imprime fora do app.

import { PDFDocument } from "pdf-lib";
import { CAPA_ALTURA_PT, CAPA_LARGURA_PT } from "./capaTamanhoPdf";

export type FolhaResolvida = { tipo: "pdf"; base64: string } | { tipo: "imagem"; base64: string; formato: "png" | "jpg" | "jpeg" };

function bytesDe(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function montarPdfPilha(folhas: FolhaResolvida[]): Promise<Uint8Array> {
  const saida = await PDFDocument.create();
  for (const f of folhas) {
    if (f.tipo === "pdf") {
      const origem = await PDFDocument.load(bytesDe(f.base64));
      const paginas = await saida.copyPages(origem, origem.getPageIndices());
      for (const pg of paginas) saida.addPage(pg);
    } else {
      const img = f.formato === "png" ? await saida.embedPng(bytesDe(f.base64)) : await saida.embedJpg(bytesDe(f.base64));
      const pagina = saida.addPage([CAPA_LARGURA_PT, CAPA_ALTURA_PT]);
      const escala = Math.min(CAPA_LARGURA_PT / img.width, CAPA_ALTURA_PT / img.height);
      const w = img.width * escala;
      const h = img.height * escala;
      pagina.drawImage(img, { x: (CAPA_LARGURA_PT - w) / 2, y: (CAPA_ALTURA_PT - h) / 2, width: w, height: h });
    }
  }
  return saida.save();
}

function paraBase64(bytes: Uint8Array): string {
  let bin = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) bin += String.fromCharCode(...bytes.subarray(i, i + passo));
  return btoa(bin);
}

/**
 * Salva o PDF na pasta Downloads pelo comando nativo e devolve o caminho; fora do Tauri (ou se o comando
 * falhar) cai no download do webview (âncora com blob) e devolve `null` (não dá pra saber onde caiu).
 */
export async function baixarArquivoPdf(bytes: Uint8Array, nome: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("save_pdf_to_downloads", { base64: paraBase64(bytes), fileName: nome });
  } catch {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return null;
  }
}
