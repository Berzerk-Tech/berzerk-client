// Formatação de data/hora compartilhada entre Separação e Expedição — mesmo
// horário de Brasília nas duas telas (o que importa é a hora DA OPERAÇÃO, não
// a do navegador/estação).

/** dd/mm hh:mm em horário de Brasília. Devolve o próprio ISO se a data vier inválida. */
export function fmtDataHora(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
      });
}
