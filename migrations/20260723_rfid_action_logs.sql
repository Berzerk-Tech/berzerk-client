-- Log de ações do app desktop (impressão, reimpressão, movimentação, descarte
-- de teste). Por enquanto vive no Supabase industrial; na virada pro nexus a
-- escrita muda de destino (o serviço src/services/actionLog.ts é o único ponto).
--
-- PASSO MANUAL no Supabase industrial (como as migrações anteriores):
-- rodar este SQL no SQL Editor do projeto hvnysnfmsndjehjndipc.

create table if not exists public.rfid_action_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- print_done | print_partial | print_failed | print_test | reprint_queue |
  -- movimentar | movimentar_failed | discard_test
  action text not null,
  batch_id uuid,
  batch_code text,
  job_id uuid,
  operator_id uuid,
  operator_email text,
  station_id text,
  -- payload livre por ação (counts, situação destino, erro, origem da ação…)
  details jsonb
);

create index if not exists rfid_action_logs_batch_id_idx
  on public.rfid_action_logs (batch_id);
create index if not exists rfid_action_logs_created_at_idx
  on public.rfid_action_logs (created_at desc);

alter table public.rfid_action_logs enable row level security;

create policy "authenticated pode inserir log"
  on public.rfid_action_logs for insert
  to authenticated with check (true);

-- Leitura pro painel industrial / auditoria.
create policy "authenticated pode ler log"
  on public.rfid_action_logs for select
  to authenticated using (true);
