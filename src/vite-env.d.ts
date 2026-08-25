/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** Base URL da separacao-api (nexus). Ex.: https://api-industrial.cloud.berzerk.com.br */
  readonly VITE_SEPARACAO_API_URL?: string;
  /** Liga o modo shadow da Separação (roda em paralelo ao pós-venda, sem virar sistema-de-registro). */
  readonly VITE_SEPARACAO_SHADOW?: string;
  /** WebSocket do nexus (push de queue.changed). */
  readonly VITE_SEPARACAO_WS_URL?: string;
  /** Hosted UI do Cognito do Nexus. Ex.: https://auth.cloud.berzerk.com.br */
  readonly VITE_COGNITO_DOMAIN?: string;
  /** App client id do desktop no pool staff (output `cognito_desktop_client_id`). */
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /** Região do Cognito (default us-east-1). */
  readonly VITE_COGNITO_REGION?: string;
  /** App client id do pool ops (berzerk-ops) — login username+senha da Separação. */
  readonly VITE_COGNITO_OPS_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
