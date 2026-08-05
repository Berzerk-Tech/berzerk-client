// Gera a DANFE SIMPLIFICADA (100×150 mm) como PDF a partir do DanfeData que o
// nexus devolve — mesmo shape SNAKE_CASE do posvenda (valores numéricos como
// string). Sai em base64 pra impressão silenciosa (src/lib/printer.ts).

import { jsPDF } from "jspdf";
import JsBarcode from "jsbarcode";
import type { DanfeData, DanfePessoa } from "../services/expedicao";

const MAX_ITENS = 8;

/** Gera o PDF da DANFE simplificada e devolve o base64 (sem prefixo data:). */
export function gerarDanfeSimplificadaPdf(nf: DanfeData): string {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [100, 150] });
  const W = 100;
  const M = 4;
  let y = 5;

  const line = (yy: number) => {
    doc.setLineWidth(0.2);
    doc.line(M, yy, W - M, yy);
  };
  const text = (s: string, x: number, yy: number, size = 7, style: "normal" | "bold" = "normal") => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.text(s, x, yy);
  };
  const right = (s: string, xr: number, yy: number, size = 7, style: "normal" | "bold" = "normal") => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.text(s, xr, yy, { align: "right" });
  };

  // --- Emitente ---
  text(clip(nf.emitente.nome ?? "EMITENTE", 46), M, y, 8, "bold");
  y += 4;
  text(`CNPJ: ${docNumero(nf.emitente) ?? "—"}`, M, y, 6);
  y += 3;
  text(clip(enderecoLinha(nf.emitente), 60), M, y, 6);
  y += 4;
  line(y);
  y += 4;

  // --- Título (centralizado) ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("DANFE SIMPLIFICADA", W / 2, y, { align: "center" });
  y += 4;
  text(`NF-e nº ${nf.numero ?? "—"}  Série ${nf.serie ?? "—"}`, M, y, 7);
  y += 3;
  text(`Emissão: ${fmtDate(nf.data_emissao)}`, M, y, 6);
  right(clip(nf.natureza_operacao ?? "", 30), W - M, y, 6);
  y += 4;

  // --- Código de barras da chave de acesso ---
  if (nf.chave_acesso) {
    const barcode = barcodeDataUrl(nf.chave_acesso.replace(/\D/g, ""));
    if (barcode) {
      doc.addImage(barcode, "PNG", M, y, W - 2 * M, 10);
      y += 11;
    }
    doc.setFont("courier", "normal");
    doc.setFontSize(5.5);
    doc.text(fmtChave(nf.chave_acesso), W / 2, y, { align: "center" });
    y += 3;
  }
  line(y);
  y += 4;

  // --- Destinatário ---
  text("DESTINATÁRIO", M, y, 6, "bold");
  y += 3.5;
  text(clip(nf.cliente.nome ?? "—", 60), M, y, 7);
  y += 3.5;
  text(`CPF/CNPJ: ${docNumero(nf.cliente) ?? "—"}`, M, y, 6);
  y += 3;
  text(clip(enderecoLinha(nf.cliente), 62), M, y, 6);
  y += 3;
  text(clip(`${nf.cliente.cidade ?? ""} / ${nf.cliente.uf ?? ""}  ${nf.cliente.cep ?? ""}`, 60), M, y, 6);
  y += 4;
  line(y);
  y += 4;

  // --- Itens (até MAX_ITENS) ---
  text("ITENS", M, y, 6, "bold");
  right(`${nf.itens.length} item(ns)`, W - M, y, 6);
  y += 3.5;
  for (const it of nf.itens.slice(0, MAX_ITENS)) {
    text(clip(it.descricao ?? it.codigo ?? "Item", 52), M, y, 6);
    right(`${fmtQtd(num(it.quantidade))}x ${money(num(it.valor_unitario))}`, W - M, y, 6);
    y += 3.2;
  }
  if (nf.itens.length > MAX_ITENS) {
    text(`+ ${nf.itens.length - MAX_ITENS} item(ns) — ver DANFE completa`, M, y, 5.5, "bold");
    y += 3.2;
  }
  y += 1;
  line(y);
  y += 4;

  // --- Totais ---
  text("Produtos", M, y, 6);
  right(money(num(nf.valor_produtos)), W - M, y, 6);
  y += 3.2;
  if (num(nf.valor_frete)) {
    text("Frete", M, y, 6);
    right(money(num(nf.valor_frete)), W - M, y, 6);
    y += 3.2;
  }
  if (num(nf.valor_desconto)) {
    text("Desconto", M, y, 6);
    right(`- ${money(num(nf.valor_desconto))}`, W - M, y, 6);
    y += 3.2;
  }
  text("TOTAL DA NOTA", M, y, 8, "bold");
  right(money(num(nf.valor_nota)), W - M, y, 8, "bold");
  y += 4;
  line(y);
  y += 4;

  // --- Transporte / volumes ---
  if (nf.transportador?.nome) {
    text(`Transp.: ${clip(nf.transportador.nome, 46)}`, M, y, 6);
    y += 3.2;
  }
  if (nf.volumes) {
    const v = nf.volumes;
    text(`Volumes: ${v.quantidade ?? "—"}  Peso: ${v.peso_bruto ?? "—"} kg`, M, y, 6);
    y += 3.2;
  }
  if (nf.protocolo) {
    text(`Protocolo: ${nf.protocolo}  ${fmtDate(nf.data_protocolo)}`, M, y, 5.5);
    y += 3;
  }
  if (nf.informacoes_adicionais) {
    y += 1;
    const wrapped = doc.splitTextToSize(nf.informacoes_adicionais, W - 2 * M) as string[];
    doc.setFont("helvetica", "normal");
    doc.setFontSize(5.5);
    doc.text(wrapped.slice(0, 4), M, y);
  }

  return doc.output("datauristring").split(",")[1] ?? "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function barcodeDataUrl(code: string): string | null {
  if (!code) return null;
  try {
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, code, { format: "CODE128", displayValue: false, margin: 0, height: 60, width: 1 });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function docNumero(p: DanfePessoa): string | null {
  return p.cnpj ?? p.cpf_cnpj ?? null;
}

function enderecoLinha(p: DanfePessoa): string {
  return [p.endereco, p.numero, p.complemento, p.bairro].filter(Boolean).join(", ");
}

function num(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // Tiny manda "99.90" ou às vezes "99,90".
    const n = parseFloat(v.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function clip(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function money(v: number): string {
  return (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtQtd(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toLocaleString("pt-BR");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtChave(chave: string): string {
  const digits = chave.replace(/\D/g, "");
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}
