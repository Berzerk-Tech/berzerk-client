// Cliente Rust pra iTAG REST API (itag2.itagalert.com.br/itagalert_integracao/*).
//
// Substitui o caminho via edge function `itag-print-rfid` do app antigo.
// Como Tauri roda código nativo, batemos HTTP direto sem CORS e com Basic auth
// nas credenciais que o operador setou em Settings → iTAG iPrint.
//
// Endpoints cobertos (ver PDF "Fluxo padrão de integração V1.2"):
//   POST /iprint/gerarRFID/{codigoEmpresa}/{filial}                 — solicita print
//   POST /itagInventarioIprintItem/findPageByPredicate?page=&size=  — lista EPCs queimados
//   PUT  /produtoIprint/alteraNumeroNotaFiscalPorListaEpcLogMovimentacao/{nf}/{situacao}/{eo}/{ed}
//        — movimentação pós-impressão

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const PRINT_TIMEOUT_SECS: u64 = 60;
const QUERY_TIMEOUT_SECS: u64 = 30;
const POLL_INTERVAL_MS: u64 = 800;
const POLL_MAX_ATTEMPTS: u32 = 12; // ~10s total

#[derive(Deserialize)]
pub struct IprintConfig {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "basicUser")]
    pub basic_user: String,
    #[serde(rename = "basicPass")]
    pub basic_pass: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct IprintItem {
    pub cor: Option<String>,
    #[serde(rename = "dataExtra1")]
    pub data_extra1: Option<String>,
    #[serde(rename = "dataExtra2")]
    pub data_extra2: Option<String>,
    pub ean13: String,
    pub extra20: Option<String>,
    pub grupo: Option<String>,
    pub nome: Option<String>,
    pub preco: Option<f64>,
    pub quantidade: u32,
    pub referencia: Option<String>,
    pub tamanho: Option<String>,
    pub unidade: Option<String>,
}

#[derive(Serialize)]
pub struct EpcEntry {
    pub epc: String,
    #[serde(rename = "codigoInventario")]
    pub codigo_inventario: Option<i64>,
    pub tamanho: Option<String>,
    pub referencia: Option<String>,
    pub situacao: Option<i64>,
    pub ean13: Option<String>,
}

#[derive(Serialize)]
pub struct GerarRfidResponse {
    #[serde(rename = "codigoInventario")]
    pub codigo_inventario: Option<i64>,
    pub epcs: Vec<String>,
    /// Marca true quando a resposta do POST não trouxe EPCs e a gente
    /// completou via poll do findPageByPredicate.
    pub polled: bool,
    /// Raw da resposta pro debug — first 400 chars.
    #[serde(rename = "rawPreview")]
    pub raw_preview: String,
}

#[derive(Serialize)]
pub struct MovimentacaoResponse {
    pub ok: bool,
    pub status: u16,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct ConnectionStatus {
    pub ok: bool,
    pub host: String,
    pub message: Option<String>,
}

fn build_client(timeout: u64) -> reqwest::Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
}

fn base(config: &IprintConfig) -> String {
    config.base_url.trim_end_matches('/').to_string()
}

/// Formata reqwest::Error com a chain de causas em vez de só a primeira
/// linha — preserva diagnósticos de TLS, DNS, timeout, etc.
fn fmt_err(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(&format!(" → {}", s));
        cur = s.source();
    }
    out
}

/// Ping inofensivo: faz uma busca paginada de 1 item no inventário
/// pra validar credenciais Basic + reachability.
#[tauri::command(rename_all = "camelCase")]
pub async fn itag_iprint_ping(config: IprintConfig) -> ConnectionStatus {
    let url = format!(
        "{}/itagInventarioIprintItem/findPageByPredicate?page=0&size=1&fieldSort=referencia&direction=ASC",
        base(&config)
    );
    let client = match build_client(QUERY_TIMEOUT_SECS) {
        Ok(c) => c,
        Err(e) => {
            return ConnectionStatus {
                ok: false,
                host: config.base_url,
                message: Some(format!("client init falhou: {}", e)),
            };
        }
    };

    // Predicate restritivo: busca por inventário com codigoInventario = -1
    // (não existe). Servidor responde rápido com page vazia usando o índice,
    // sem precisar paginar a tabela inteira.
    let ping_predicate = serde_json::json!({
        "codigoInventario": { "valorCampo": -1, "contem": false }
    });
    let resp = client
        .post(&url)
        .basic_auth(&config.basic_user, Some(&config.basic_pass))
        .header("Content-Type", "application/json")
        .json(&ping_predicate)
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => ConnectionStatus {
            ok: true,
            host: config.base_url,
            message: Some(format!("HTTP {}", r.status().as_u16())),
        },
        Ok(r) => {
            let code = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            let preview = body.chars().take(160).collect::<String>();
            ConnectionStatus {
                ok: false,
                host: config.base_url,
                message: Some(format!("HTTP {} — {}", code, preview)),
            }
        }
        Err(e) => ConnectionStatus {
            ok: false,
            host: config.base_url,
            message: Some(format!("conexão falhou: {}", fmt_err(&e))),
        },
    }
}

/// POST /iprint/gerarRFID/{codigoEmpresa}/{filial}
/// Se a resposta não trouxer EPCs inline, faz poll de findPageByPredicate
/// até o codigoInventario aparecer com os items esperados.
#[tauri::command(rename_all = "camelCase")]
pub async fn itag_iprint_gerar_rfid(
    config: IprintConfig,
    codigo_empresa: u32,
    filial: u32,
    items: Vec<IprintItem>,
) -> Result<GerarRfidResponse, String> {
    if items.is_empty() {
        return Err("validation: items vazio".to_string());
    }
    let total_quantidade: u32 = items.iter().map(|i| i.quantidade).sum();
    if total_quantidade == 0 {
        return Err("validation: soma de quantidades é zero".to_string());
    }

    let url = format!(
        "{}/iprint/gerarRFID/{}/{}",
        base(&config),
        codigo_empresa,
        filial
    );
    let client =
        build_client(PRINT_TIMEOUT_SECS).map_err(|e| format!("client_init: {}", e))?;

    let resp = client
        .post(&url)
        .basic_auth(&config.basic_user, Some(&config.basic_pass))
        .header("Content-Type", "application/json")
        .json(&items)
        .send()
        .await
        .map_err(|e| format!("iprint_call: requisição falhou — {}", fmt_err(&e)))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("iprint_call: leitura body falhou — {}", fmt_err(&e)))?;

    if !status.is_success() {
        let preview = body.chars().take(300).collect::<String>();
        return Err(format!("iprint_call: HTTP {} — {}", status.as_u16(), preview));
    }

    let raw_preview: String = body.chars().take(400).collect();

    // Tenta extrair codigoInventario e (talvez) EPCs do response.
    let parsed: serde_json::Value =
        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);

    let codigo_inventario = extract_codigo_inventario(&parsed);
    let mut epcs = extract_epcs(&parsed);
    let mut polled = false;

    // Se gerarRFID não retornou EPCs inline, faz poll até preencher.
    if epcs.is_empty() {
        if let Some(ci) = codigo_inventario {
            polled = true;
            epcs = poll_inventory_epcs(&client, &config, ci, total_quantidade).await?;
        } else {
            return Err(format!(
                "epc_extraction: response sem codigoInventario nem EPCs — {}",
                raw_preview
            ));
        }
    }

    Ok(GerarRfidResponse {
        codigo_inventario,
        epcs,
        polled,
        raw_preview,
    })
}

/// POST /tagInventarioIprintItem/findPageByPredicate?page=&size=&fieldSort=&direction=
/// Filtra por codigoInventario e devolve os EPCs.
#[tauri::command(rename_all = "camelCase")]
pub async fn itag_iprint_query_inventory(
    config: IprintConfig,
    codigo_inventario: i64,
    page: Option<u32>,
    size: Option<u32>,
) -> Result<Vec<EpcEntry>, String> {
    let client = build_client(QUERY_TIMEOUT_SECS).map_err(|e| format!("client_init: {}", e))?;
    let page = page.unwrap_or(0);
    let size = size.unwrap_or(500);
    query_inventory_raw(&client, &config, codigo_inventario, page, size).await
}

/// PUT /produtoIprint/alteraNumeroNotaFiscalPorListaEpcLogMovimentacao/{nf}/{situacao}/{eo}/{ed}
/// Body: array de EPCs.
#[tauri::command(rename_all = "camelCase")]
pub async fn itag_iprint_movimentar(
    config: IprintConfig,
    epcs: Vec<String>,
    nota_fiscal: String,
    situacao_destino: u32,
    empresa_origem: u32,
    empresa_destino: u32,
) -> Result<MovimentacaoResponse, String> {
    if epcs.is_empty() {
        return Err("validation: lista de EPCs vazia".to_string());
    }
    let url = format!(
        "{}/produtoIprint/alteraNumeroNotaFiscalPorListaEpcLogMovimentacao/{}/{}/{}/{}",
        base(&config),
        urlencoding::encode(&nota_fiscal),
        situacao_destino,
        empresa_origem,
        empresa_destino
    );
    let client = build_client(QUERY_TIMEOUT_SECS).map_err(|e| format!("client_init: {}", e))?;
    let resp = client
        .put(&url)
        .basic_auth(&config.basic_user, Some(&config.basic_pass))
        .header("Content-Type", "application/json")
        .json(&epcs)
        .send()
        .await
        .map_err(|e| format!("movimentar: requisição falhou — {}", fmt_err(&e)))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let preview: String = body.chars().take(200).collect();

    if status.is_success() {
        Ok(MovimentacaoResponse {
            ok: true,
            status: status.as_u16(),
            message: if preview.is_empty() { None } else { Some(preview) },
        })
    } else {
        Err(format!("movimentar: HTTP {} — {}", status.as_u16(), preview))
    }
}

#[derive(Serialize, Clone)]
pub struct EpcDetail {
    pub epc: String,
    pub ean13: Option<String>,
    pub nome: Option<String>,
    pub tamanho: Option<String>,
    pub cor: Option<String>,
    pub found: bool,
    /// base_url do ambiente que resolveu (debug/telemetria).
    pub fonte: Option<String>,
}

/// Resolve EPC → produto (ean13/nome/tamanho/cor) na NUVEM da iTAG — o mesmo
/// caminho do posvenda em produção (edge `itag-epc-lookup`): POST
/// produtoIprint/findPageByPredicate com {codigoEmpresa, epc}. A doc da iTAG
/// avisa que tags em campo nem sempre são SGTIN padrão GS1 — a nuvem deles é a
/// fonte da verdade do que cada EPC significa.
///
/// Tenta cada base na ordem: o ambiente configurado primeiro e depois
/// `extra_bases` (tags da era posvenda vivem no itagalert_berzerk; as nossas no
/// itagalert_integracao). Mesmas credenciais Basic pra todos (validado).
#[tauri::command(rename_all = "camelCase")]
pub async fn itag_epc_details(
    config: IprintConfig,
    epcs: Vec<String>,
    extra_bases: Option<Vec<String>>,
    codigo_empresa: Option<u32>,
) -> Result<Vec<EpcDetail>, String> {
    let client = build_client(QUERY_TIMEOUT_SECS).map_err(|e| format!("client_init: {}", e))?;
    let empresa = codigo_empresa.unwrap_or(1);

    let mut bases = vec![base(&config)];
    for b in extra_bases.unwrap_or_default() {
        let b = b.trim().trim_end_matches('/').to_string();
        if !b.is_empty() && !bases.contains(&b) {
            bases.push(b);
        }
    }

    let mut out: Vec<EpcDetail> = Vec::with_capacity(epcs.len());
    // Chunks de 8 concorrentes (mesmo batch size do edge do posvenda).
    for chunk in epcs.chunks(8) {
        let handles: Vec<_> = chunk
            .iter()
            .map(|epc| {
                let epc = epc.trim().to_uppercase();
                let client = client.clone();
                let bases = bases.clone();
                let user = config.basic_user.clone();
                let pass = config.basic_pass.clone();
                tokio::spawn(async move {
                    for b in &bases {
                        match lookup_epc_once(&client, b, &user, &pass, empresa, &epc).await {
                            Ok(Some(mut d)) => {
                                d.fonte = Some(b.clone());
                                return d;
                            }
                            Ok(None) => continue,
                            Err(_) => continue, // ambiente fora → tenta o próximo
                        }
                    }
                    EpcDetail {
                        epc,
                        ean13: None,
                        nome: None,
                        tamanho: None,
                        cor: None,
                        found: false,
                        fonte: None,
                    }
                })
            })
            .collect();
        for h in handles {
            out.push(h.await.map_err(|e| format!("join: {}", e))?);
        }
    }
    Ok(out)
}

/// Um lookup em um ambiente: Ok(Some) achou, Ok(None) não existe lá,
/// Err = ambiente inacessível (o caller tenta o próximo).
async fn lookup_epc_once(
    client: &Client,
    base_url: &str,
    user: &str,
    pass: &str,
    empresa: u32,
    epc: &str,
) -> Result<Option<EpcDetail>, String> {
    let url = format!(
        "{}/produtoIprint/findPageByPredicate?page=0&size=1&direction=ASC",
        base_url
    );
    let body = serde_json::json!({
        "codigoEmpresa": { "valorCampo": empresa },
        "epc": epc,
    });
    let resp = client
        .post(&url)
        .basic_auth(user, Some(pass))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| fmt_err(&e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| fmt_err(&e))?;
    let item = match json.get("content").and_then(|c| c.as_array()).and_then(|a| a.first()) {
        Some(i) => i,
        None => return Ok(None),
    };
    let s = |k: &str| -> Option<String> {
        match item.get(k) {
            Some(serde_json::Value::String(v)) if !v.trim().is_empty() => Some(v.trim().to_string()),
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            _ => None,
        }
    };
    Ok(Some(EpcDetail {
        epc: epc.to_string(),
        ean13: s("ean13"),
        nome: s("nome"),
        tamanho: s("tamanho"),
        cor: s("cor"),
        found: true,
        fonte: None,
    }))
}

// ============ helpers ============

async fn poll_inventory_epcs(
    client: &Client,
    config: &IprintConfig,
    codigo_inventario: i64,
    expected_total: u32,
) -> Result<Vec<String>, String> {
    let mut last_seen: Vec<EpcEntry> = vec![];
    for attempt in 0..POLL_MAX_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        match query_inventory_raw(client, config, codigo_inventario, 0, 500).await {
            Ok(entries) => {
                if entries.len() as u32 >= expected_total {
                    return Ok(entries.into_iter().map(|e| e.epc).collect());
                }
                last_seen = entries;
            }
            Err(e) => {
                // último attempt: vaza o erro
                if attempt + 1 == POLL_MAX_ATTEMPTS {
                    return Err(format!("epc_extraction: poll falhou — {}", e));
                }
            }
        }
    }
    if last_seen.is_empty() {
        Err("epc_extraction: poll não encontrou nenhum EPC após 10s".to_string())
    } else {
        // Retorna parcial — o frontend pode decidir o que fazer
        Ok(last_seen.into_iter().map(|e| e.epc).collect())
    }
}

async fn query_inventory_raw(
    client: &Client,
    config: &IprintConfig,
    codigo_inventario: i64,
    page: u32,
    size: u32,
) -> Result<Vec<EpcEntry>, String> {
    let url = format!(
        "{}/itagInventarioIprintItem/findPageByPredicate?page={}&size={}&fieldSort=referencia&direction=ASC",
        base(config),
        page,
        size
    );
    let predicate = serde_json::json!({
        "codigoInventario": { "valorCampo": codigo_inventario, "contem": false }
    });

    let resp = client
        .post(&url)
        .basic_auth(&config.basic_user, Some(&config.basic_pass))
        .header("Content-Type", "application/json")
        .json(&predicate)
        .send()
        .await
        .map_err(|e| format!("query_inventory: req falhou — {}", fmt_err(&e)))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("query_inventory: body falhou — {}", fmt_err(&e)))?;

    if !status.is_success() {
        let preview = body.chars().take(300).collect::<String>();
        return Err(format!(
            "query_inventory: HTTP {} — {}",
            status.as_u16(),
            preview
        ));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("query_inventory: parse JSON falhou — {}", e))?;
    let content = parsed
        .get("content")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(content.len());
    for item in content {
        let compl = item.get("itagInventarioIprintItemCompl").unwrap_or(&item);
        let epc = compl
            .get("epc")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let Some(epc) = epc else {
            continue;
        };
        let codigo = compl
            .get("codigoInventario")
            .and_then(|v| v.as_i64());
        let tamanho = item
            .get("tamanho")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let referencia = item
            .get("referencia")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let situacao = item.get("situacao").and_then(|v| v.as_i64());
        let ean13 = item
            .get("ean13")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        out.push(EpcEntry {
            epc,
            codigo_inventario: codigo,
            tamanho,
            referencia,
            situacao,
            ean13,
        });
    }
    Ok(out)
}

fn extract_codigo_inventario(value: &serde_json::Value) -> Option<i64> {
    // Tenta caminhos comuns: root, content[0], itagInventarioIprintItemCompl
    if let Some(n) = value.get("codigoInventario").and_then(|v| v.as_i64()) {
        return Some(n);
    }
    if let Some(arr) = value.get("content").and_then(|v| v.as_array()) {
        if let Some(first) = arr.first() {
            if let Some(n) = first.get("codigoInventario").and_then(|v| v.as_i64()) {
                return Some(n);
            }
            if let Some(n) = first
                .get("itagInventarioIprintItemCompl")
                .and_then(|c| c.get("codigoInventario"))
                .and_then(|v| v.as_i64())
            {
                return Some(n);
            }
        }
    }
    None
}

fn extract_epcs(value: &serde_json::Value) -> Vec<String> {
    // Array no root: pode ser de strings ou de objetos com campo .epc
    if let Some(arr) = value.as_array() {
        let strings: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .filter(|s| !s.is_empty())
            .collect();
        if !strings.is_empty() {
            return strings;
        }
        // Resposta real do POST /iprint/gerarRFID — array de objetos
        // {codigo, epc, nome, grupo, tamanho, cor, ...}.
        let from_objs: Vec<String> = arr
            .iter()
            .filter_map(|v| {
                v.get("epc")
                    .or_else(|| {
                        v.get("itagInventarioIprintItemCompl")
                            .and_then(|c| c.get("epc"))
                    })
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
            .filter(|s| !s.is_empty())
            .collect();
        if !from_objs.is_empty() {
            return from_objs;
        }
    }
    // Campo "epcs" no root
    if let Some(arr) = value.get("epcs").and_then(|v| v.as_array()) {
        let parsed: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .filter(|s| !s.is_empty())
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    // Campo "content" com objetos contendo epc
    if let Some(arr) = value.get("content").and_then(|v| v.as_array()) {
        let parsed: Vec<String> = arr
            .iter()
            .filter_map(|v| {
                v.get("epc")
                    .or_else(|| {
                        v.get("itagInventarioIprintItemCompl")
                            .and_then(|c| c.get("epc"))
                    })
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
            .filter(|s| !s.is_empty())
            .collect();
        if !parsed.is_empty() {
            return parsed;
        }
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_epcs_from_array() {
        let v = serde_json::json!(["AABB", "CCDD"]);
        assert_eq!(extract_epcs(&v), vec!["AABB", "CCDD"]);
    }

    #[test]
    fn extracts_epcs_from_content() {
        let v = serde_json::json!({
            "content": [
                { "itagInventarioIprintItemCompl": { "epc": "X1", "codigoInventario": 7 } },
                { "itagInventarioIprintItemCompl": { "epc": "X2", "codigoInventario": 7 } }
            ]
        });
        assert_eq!(extract_epcs(&v), vec!["X1", "X2"]);
        assert_eq!(extract_codigo_inventario(&v), Some(7));
    }

    #[test]
    fn extracts_codigo_inventario_root() {
        let v = serde_json::json!({ "codigoInventario": 42 });
        assert_eq!(extract_codigo_inventario(&v), Some(42));
    }

    #[test]
    fn extracts_epcs_from_object_array() {
        // Resposta real do POST /iprint/gerarRFID — array de objetos com .epc
        let v = serde_json::json!([
            { "codigo": "4791526", "epc": "3029D6ACF4800C4000000001", "nome": "Camisa preta M" },
            { "codigo": "4791526", "epc": "3029D6ACF4800C4000000002", "nome": "Camisa preta M" }
        ]);
        assert_eq!(
            extract_epcs(&v),
            vec!["3029D6ACF4800C4000000001", "3029D6ACF4800C4000000002"]
        );
    }
}
