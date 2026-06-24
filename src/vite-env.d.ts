/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** Base URL da separacao-api (nexus). Ex.: https://api-industrial.cloud.berzerk.com.br */
  readonly VITE_SEPARACAO_API_URL?: string;
  /** Liga o modo shadow da Separação (roda em paralelo ao pós-venda, sem virar sistema-de-registro). */
  readonly VITE_SEPARACAO_SHADOW?: string;
  /** Região do Cognito (default us-east-1). */
  readonly VITE_COGNITO_REGION?: string;
  /** App client id do pool ops (berzerk-ops) — login username+senha da Separação. */
  readonly VITE_COGNITO_OPS_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
