// ============================================================================
// Proxy Vercel per Amazon Bedrock (endpoint bedrock-mantle) -> Janitor AI / SillyTavern
// ============================================================================
//
// COSA CAMBIA RISPETTO ALLA VERSIONE PRECEDENTE
//
// 1) Il bug principale: il codice iniettava sempre
//        body.thinking = { type: "enabled", budget_tokens: 4096 }
//    che è la sintassi nativa dell'Anthropic Messages API. bedrock-mantle qui
//    espone l'OpenAI Chat Completions API, e AWS documenta un solo campo
//    universale per il reasoning su QUESTO endpoint, per QUALSIASI modello
//    Mantle: "reasoning_effort" (stringa: "low" | "medium" | "high").
//    Mandare un campo "thinking" non riconosciuto a un modello non-Claude,
//    su un endpoint che valida lo schema OpenAI, è quasi certamente quello
//    che causava il blocco cambiando modello.
//
// 2) reasoning_effort viene iniettato in modo dinamico (per ogni modello,
//    tranne una piccola lista di esclusione dove non avrebbe senso), invece
//    di un oggetto fisso identico per tutti.
//
// 3) RETRY AUTOMATICO: se Bedrock rifiuta comunque la richiesta con i
//    parametri di reasoning attivi, il proxy ritenta UNA volta senza quei
//    parametri, invece di far fallire la chat. Questo è quello che ti rende
//    "a prova di modello nuovo": non serve aggiornare il codice ogni volta
//    che AWS aggiunge/cambia un modello (è già successo con GLM, Kimi,
//    MiniMax solo nella tua lista).
//
// 4) max_tokens minimo alzato quando il reasoning è attivo: col budget di
//    ragionamento che consuma token, un max_tokens troppo basso può far
//    uscire la risposta visibile vuota o troncata.
//
// 5) La vecchia iniezione nel system prompt ("ragiona step-by-step") è
//    disattivata di default: su un modello senza canale di reasoning
//    separato, quel testo può comparire dentro la risposta in-character e
//    rompere l'immersione nel roleplay. Resta disponibile dietro un flag.
//
// 6) Aggiunte: timeout con AbortController, maxDuration più alto (il
//    reasoning richiede più tempo), iniezione opzionale della API key lato
//    server, protezione opzionale anti-abuso, chiusura pulita dello stream
//    se il client si disconnette.
//
// 7) FIX 500 in produzione: il file usava sintassi ESM (`export` /
//    `export default`) ma Vercel/Node lo caricava come CommonJS
//    ("SyntaxError: Unexpected token 'export'") perché manca "type":
//    "module" nel package.json più vicino. Convertito tutto a CommonJS
//    (module.exports): funziona subito, senza toccare altri file.
//
// 8) reasoning_effort è già al massimo dello schema Bedrock Mantle ("high"
//    — i valori validi sono solo none/low/medium/high, "illimitato" non
//    esiste). Alzati invece i due limiti pratici che possono tagliare
//    corto un ragionamento lungo: maxDuration/timeout (60s -> 300s, il
//    tetto del piano Hobby; dimmi se sei su Pro/Enterprise e si può salire
//    a 800s o 1800s) e la soglia minima di max_tokens riservata quando il
//    reasoning è attivo (2048 -> 100.000, su richiesta: è un tetto di
//    margine, il modello non è obbligato a usarlo tutto).
//
// 9) URL Mantle dinamico: alcuni modelli (xai.grok-4.3 e altri, vedi
//    OPENAI_PREFIX_MODELS) vogliono il path "/openai/v1/..." invece del
//    normale "/v1/...", e non è deducibile dal nome del modello. Il proxy
//    sceglie da solo il path giusto per la lista nota; se un modello nuovo
//    (non ancora in lista) viene chiamato sul path sbagliato, si
//    auto-corregge al primo tentativo e se lo ricorda per le richieste
//    successive — nessuna modifica manuale.
//
// 10) Errore reale visto in produzione con xai.grok-4.3: "isn't supported
//     on this route". Causa diversa dal prefisso: questo modello (per ora)
//     è disponibile SOLO sulla regione us-west-2, non sulla regione di
//     default us-east-1. Aggiunta una mappa di hint regione per modello
//     (MODEL_REGION_HINTS) più un fallback automatico su us-west-2 per
//     modelli nuovi non ancora mappati, con la stessa logica di
//     auto-correzione e cache del punto 9.
//
// 11) LOG DELLE CHIAMATE: ogni richiesta che arriva viene ora registrata
//     (modello, URL/regione/prefisso usati, se il reasoning era
//     compatibile o è stato rifiutato, se la risposta contiene davvero
//     contenuto di reasoning e una sua anteprima). Consultabile aprendo
//     l'URL del proxy nel browser con "?log" (tabella) o "?log=json" (dati
//     grezzi). È un log IN MEMORIA: si azzera quando l'istanza serverless
//     si riavvia (succede spesso, Vercel non garantisce un'istanza fissa),
//     quindi va bene per un controllo al volo ma non come storico
//     permanente. Ogni voce viene anche stampata con console.log, quindi
//     resta visibile pure nei Runtime Logs di Vercel (dashboard o
//     `vercel logs`) per la finestra di retention del tuo piano.
//
// CONFIGURAZIONE (tutta opzionale, su Vercel > Project > Settings >
// Environment Variables — se non le imposti il proxy si comporta come la
// versione base, nessuna rottura):
//   BEDROCK_API_KEY   -> se impostata, il proxy la usa per Bedrock al posto
//                        di quella mandata da Janitor (così in Janitor puoi
//                        mettere un valore a caso e tenere la chiave vera
//                        solo su Vercel).
//   PROXY_ACCESS_KEY  -> se impostata, il proxy accetta solo richieste che
//                        includono l'header "x-proxy-key" con questo
//                        valore. Protegge dal caso (comune) in cui qualcuno
//                        trovi l'URL del tuo proxy Vercel e lo usi a tue
//                        spese sul tuo account AWS. Se è impostata, protegge
//                        anche la pagina di log qui sotto: in browser non
//                        puoi mandare header custom, quindi lì la stessa
//                        chiave si passa come "?key=...".
//
// COME VEDERE IL LOG:
//   https://<tuo-progetto>.vercel.app/api/<nome-file>?log        (tabella HTML)
//   https://<tuo-progetto>.vercel.app/api/<nome-file>?log=json   (dati grezzi)
//   Aggiungi "&key=LA_TUA_PROXY_ACCESS_KEY" in fondo se hai impostato
//   PROXY_ACCESS_KEY. La pagina si aggiorna da sola ogni 15 secondi.
// ============================================================================

const config = {
  // 300s = default E massimo sul piano Hobby (con Fluid Compute, attivo di
  // default sui progetti nuovi). Su Pro/Enterprise si può salire fino a
  // 800s senza altro, o fino a 1800s (beta) con configurazione aggiuntiva.
  maxDuration: 300,
};

const DEFAULT_REGION = 'us-east-1'; // dove girano i tuoi modelli "principali" (gpt-oss, GLM, Kimi, MiniMax...)
const FALLBACK_REGION = 'us-west-2'; // seconda regione nota per Mantle: tentativo automatico se un modello nuovo non è raggiungibile sulla default
const FETCH_TIMEOUT_MS = 280_000; // resta sotto i 300s di maxDuration, per rispondere con un errore leggibile invece di un hard-kill
const MIN_MAX_TOKENS_WITH_REASONING = 100_000; // tetto alto "di margine": il modello lo usa solo se ne ha bisogno, non è un target

// Alcuni modelli su Mantle vogliono il path "/openai/v1/..." invece del
// normale "/v1/...": non è deducibile dal nome/vendor del modello (es. non
// è "tutti gli openai.*", gpt-oss NON lo richiede), AWS lo documenta caso
// per caso nella model card.
const OPENAI_PREFIX_MODELS = new Set([
  'xai.grok-4.3',
  'openai.gpt-5.5',
  'openai.gpt-5.6-sol',
  'google.gemma-4-31b',
  'google.gemma-4-e2b',
  'google.gemma-4-26b-a4b',
]);

// Alcuni modelli sono disponibili SOLO in regioni specifiche (rollout
// progressivo AWS, non tutte le regioni hanno tutti i modelli). Chiamarli
// sulla regione sbagliata dà "model ... isn't supported on this route"
// anche col prefisso /openai/ corretto — è un errore diverso da quello del
// prefisso, gestito separatamente qui sotto.
const MODEL_REGION_HINTS = {
  'xai.grok-4.3': 'us-west-2', // unica regione supportata al momento
  'openai.gpt-5.5': 'us-east-2',
  'openai.gpt-5.4': 'us-east-2',
};

// Ricorda, per la durata dell'istanza Lambda "calda", la combinazione
// regione+prefisso confermata per un dato modello (hint sopra + scoperte
// per tentativi) — così un modello nuovo che AWS aggiunge domani si
// auto-corregge dopo il primo tentativo, senza editare il file.
const routeCache = new Map();

function resolveRoute(model) {
  if (routeCache.has(model)) return routeCache.get(model);
  return {
    region: MODEL_REGION_HINTS[model] || DEFAULT_REGION,
    prefix: OPENAI_PREFIX_MODELS.has(model),
  };
}

function bedrockUrl(region, useOpenAIPrefix) {
  const base = `https://bedrock-mantle.${region}.api.aws`;
  return useOpenAIPrefix ? `${base}/openai/v1/chat/completions` : `${base}/v1/chat/completions`;
}

// Due segnali di routing distinti restituiti da AWS: uno per "modello non
// disponibile in questa regione", uno per "manca il prefisso /openai/".
// Nessuno dei due è un rifiuto sui parametri della richiesta.
function isRegionRoutingError(errorText = '') {
  return /isn'?t supported on this route/i.test(errorText);
}
function isPrefixRoutingError(errorText = '') {
  return /is not enabled for this account/i.test(errorText);
}

// Modelli per cui NON ha senso forzare il reasoning (classificatori/guardrail,
// modelli vision-only...). Pattern testati come substring case-insensitive
// sull'id del modello mandato da Janitor.
const NO_REASONING_PATTERNS = [
  /safeguard/i,      // openai.gpt-oss-safeguard-20b / 120b: modelli guardrail, non da chat/RP
  /palmyra-vision/i, // modello vision-only
];

// Override manuali per modelli specifici. Se con i test scopri che un
// modello vuole una forma diversa da "reasoning_effort", aggiungilo qui:
// non serve toccare il resto del file. "match" viene testato con .test(model).
const REASONING_OVERRIDES = [
  // Esempio (disattivato) — alcuni test informali su GLM-4.7-flash suggeriscono
  // che voglia un booleano invece dell'effort scalare. Se il retry scatta
  // sempre su questo modello, prova a scommentare:
  // { match: /zai\.glm-4\.7-flash/i, params: { reasoning: { enabled: true } } },
];

// Se true, aggiunge anche una direttiva nel system prompt che spinge il
// modello a ragionare step-by-step in testo normale. Utile SOLO per modelli
// senza un vero canale di reasoning separato (quindi che ignorano
// reasoning_effort) — per tutti gli altri è ridondante, e per il roleplay
// rischia di far comparire il ragionamento dentro la risposta in-character.
// Di default disattivato.
const INJECT_SYSTEM_PROMPT_DIRECTIVE = false;
const THINKING_DIRECTIVE =
  'Ragiona internamente passo-passo prima di rispondere, mantenendo la risposta visibile solo nel personaggio (in-character), senza mostrare il ragionamento.';

function shouldSkipReasoning(model = '') {
  return NO_REASONING_PATTERNS.some((re) => re.test(model));
}

function findOverride(model = '') {
  return REASONING_OVERRIDES.find((o) => o.match.test(model));
}

function maybeInjectSystemDirective(body) {
  if (!INJECT_SYSTEM_PROMPT_DIRECTIVE || !Array.isArray(body.messages)) return;
  const systemMsg = body.messages.find((m) => m.role === 'system');
  if (systemMsg) {
    systemMsg.content = `${THINKING_DIRECTIVE}\n\n${systemMsg.content}`;
  } else {
    body.messages.unshift({ role: 'system', content: THINKING_DIRECTIVE });
  }
}

// Muta `body` in-place aggiungendo il reasoning "al massimo" nella forma
// giusta per il modello richiesto, e restituisce una copia PROFONDA del
// body originale (pre-modifica) da usare per il retry di sicurezza.
function applyMaxThinking(body) {
  const original = structuredClone(body); // clone profondo: niente reference condivise con body.messages
  const model = body.model || '';
  const skip = shouldSkipReasoning(model);

  if (!skip) {
    const override = findOverride(model);
    if (override) {
      Object.assign(body, override.params);
    } else {
      // Campo unico documentato da AWS per bedrock-mantle Chat Completions,
      // valido "for all Amazon Bedrock models powered by Project Mantle".
      body.reasoning_effort = 'high';
    }

    if (!body.max_tokens || body.max_tokens < MIN_MAX_TOKENS_WITH_REASONING) {
      body.max_tokens = MIN_MAX_TOKENS_WITH_REASONING;
    }

    maybeInjectSystemDirective(body);
  }

  return { originalBody: original, wasModified: !skip };
}

// ============================================================================
// LOG DELLE CHIAMATE (in-memory) — vedi punto 11 in cima al file
// ============================================================================
const MAX_LOG_ENTRIES = 50; // quante richieste tenere in memoria contemporaneamente
const REASONING_PREVIEW_CHARS = 400; // quanti caratteri di reasoning salvare nell'anteprima

const requestLog = [];
let logCounter = 0;

function pushLog(entry) {
  logCounter += 1;
  const record = { id: logCounter, ts: new Date().toISOString(), ...entry };
  requestLog.unshift(record);
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.length = MAX_LOG_ENTRIES;
  // Stampato anche nei log "veri" di Vercel: è l'unica copia che sopravvive
  // al riavvio dell'istanza serverless (il log in-memory invece si azzera).
  console.log('[bedrock-proxy]', JSON.stringify(record));
  return record;
}

// Legge il testo del reasoning da un messaggio di risposta già parsato
// (risposta non-stream). Il nome campo standard è "reasoning_content"
// (così lo restituiscono i vari gateway OpenAI-compatibili per i modelli
// con reasoning su Mantle), ma per sicurezza controlla anche un paio di
// forme alternative viste in giro — se un modello nuovo usa un campo
// diverso, aggiungilo qui.
function getReasoningText(message) {
  if (!message) return null;
  if (typeof message.reasoning_content === 'string') return message.reasoning_content;
  if (typeof message.reasoning === 'string') return message.reasoning;
  if (message.reasoning && typeof message.reasoning.content === 'string') return message.reasoning.content;
  return null;
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderLogHtml(entries) {
  const rows = entries.map((e) => {
    const compat = e.reasoningSkipped
      ? '<span class="tag tag-grey">non richiesto</span>'
      : e.reasoningAccepted
        ? '<span class="tag tag-green">compatibile</span>'
        : '<span class="tag tag-red">rifiutato</span>';
    const reasoning = e.reasoningDetected
      ? '<span class="tag tag-green">sì</span>'
      : '<span class="tag tag-grey">no</span>';
    const status = e.ok === false
      ? `<span class="tag tag-red">${escapeHtml(e.httpStatus ?? 'errore')}</span>`
      : `<span class="tag tag-green">${escapeHtml(e.httpStatus ?? 'ok')}</span>`;
    const preview = e.reasoningPreview
      ? `<details><summary>anteprima ragionamento</summary><pre>${escapeHtml(e.reasoningPreview)}</pre></details>`
      : '';
    const note = [
      e.routeAutoCorrected ? 'route auto-corretta' : '',
      e.usedFallbackWithoutReasoning ? 'retry senza reasoning' : '',
      e.usedOverride ? 'override reasoning' : '',
      e.error ? `errore: ${escapeHtml(e.error)}` : '',
    ].filter(Boolean).join(' · ');
    return `<tr>
      <td>${escapeHtml(new Date(e.ts).toLocaleTimeString('it-IT'))}</td>
      <td>${escapeHtml(e.model)}</td>
      <td>${compat}</td>
      <td>${reasoning}${preview}</td>
      <td>${status}</td>
      <td class="url">${escapeHtml(e.url || '')}</td>
      <td class="note">${note}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log proxy Bedrock</title>
<meta http-equiv="refresh" content="15">
<style>
  body { background:#111; color:#eee; font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#999; font-size:13px; margin:0 0 16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #333; vertical-align:top; }
  th { color:#999; font-weight:600; }
  .tag { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; white-space:nowrap; }
  .tag-green { background:#1e4620; color:#7ee787; }
  .tag-red { background:#4a1e1e; color:#ff8080; }
  .tag-grey { background:#333; color:#aaa; }
  .url { font-family:monospace; font-size:11px; color:#999; word-break:break-all; }
  .note { font-size:11px; color:#e0a030; }
  pre { white-space:pre-wrap; font-size:11px; color:#ccc; background:#1a1a1a; padding:8px; border-radius:6px; max-width:60ch; }
  details summary { cursor:pointer; color:#7aa2f7; font-size:12px; margin-top:4px; }
</style>
</head>
<body>
<h1>Log chiamate proxy Bedrock</h1>
<p class="sub">${entries.length} richiest${entries.length === 1 ? 'a' : 'e'} in memoria su questa istanza · si aggiorna da sola ogni 15s · <a href="?log=json" style="color:#7aa2f7">vedi JSON</a></p>
<table>
<tr><th>Ora</th><th>Modello</th><th>Reasoning</th><th>Sta ragionando?</th><th>Stato</th><th>URL</th><th>Note</th></tr>
${rows || '<tr><td colspan="7">Nessuna richiesta ancora registrata su questa istanza.</td></tr>'}
</table>
</body>
</html>`;
}

// GET (o qualsiasi metodo diverso da POST/OPTIONS): senza "?log" risponde
// come prima ("Proxy Vercel Attivo!"), così non cambia nulla per eventuali
// health-check. Con "?log" mostra la tabella, con "?log=json" i dati grezzi.
function handleStatusOrLog(req, res) {
  const query = req.query || {};
  if (!('log' in query)) {
    return res.status(200).send('Proxy Vercel Attivo!');
  }

  if (process.env.PROXY_ACCESS_KEY) {
    const provided = req.headers['x-proxy-key'] || query.key;
    if (provided !== process.env.PROXY_ACCESS_KEY) {
      return res.status(401).json({ error: "Non autorizzato: aggiungi &key=LA_TUA_PROXY_ACCESS_KEY all'URL." });
    }
  }

  if (query.log === 'json') {
    return res.status(200).json({ count: requestLog.length, entries: requestLog });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(renderLogHtml(requestLog));
}

async function fetchBedrock(body, headers, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Sceglie regione+path giusti per il modello richiesto (hint noti + cache)
// e chiama Bedrock. Se la risposta segnala routing sbagliato, ritenta UNA
// volta con la correzione mirata a QUEL segnale (regione diversa se
// "isn't supported on this route", prefisso diverso se "is not enabled
// for this account") e da quel momento ricorda la combinazione corretta:
// niente più doppie chiamate dopo la prima volta che un modello "nuovo"
// viene usato.
// Restituisce { response, url, region, prefix, corrected } invece della
// sola response: url/region/prefix/corrected servono solo per il log delle
// chiamate (vedi punto 11 in cima al file), il comportamento di routing è
// invariato rispetto a prima.
async function callBedrockSmart(body, headers, timeoutMs) {
  const model = body.model || '';
  const route = resolveRoute(model);
  const url = bedrockUrl(route.region, route.prefix);

  let response = await fetchBedrock(body, headers, url, timeoutMs);
  let finalUrl = url;
  let finalRegion = route.region;
  let finalPrefix = route.prefix;
  let corrected = false;

  if (!response.ok) {
    const errorText = await response.clone().text().catch(() => '');
    let candidate = null;

    if (isRegionRoutingError(errorText) && route.region !== FALLBACK_REGION) {
      candidate = { region: FALLBACK_REGION, prefix: route.prefix };
    } else if (isPrefixRoutingError(errorText)) {
      candidate = { region: route.region, prefix: !route.prefix };
    }

    if (candidate) {
      const retryUrl = bedrockUrl(candidate.region, candidate.prefix);
      const retryResponse = await fetchBedrock(body, headers, retryUrl, timeoutMs);
      if (retryResponse.ok) {
        routeCache.set(model, candidate); // confermato: da ora usa subito questa combinazione per il modello
      }
      response = retryResponse;
      finalUrl = retryUrl;
      finalRegion = candidate.region;
      finalPrefix = candidate.prefix;
      corrected = true;
    }
  }

  return { response, url: finalUrl, region: finalRegion, prefix: finalPrefix, corrected };
}

async function handler(req, res) {
  // --- CORS (per Janitor / SillyTavern / Lorebally) ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    // GET senza "?log": stato del proxy, come prima. Con "?log" / "?log=json":
    // la pagina di log delle ultime chiamate (vedi punto 11 in cima al file).
    return handleStatusOrLog(req, res);
  }

  // --- Protezione opzionale anti-abuso: si attiva SOLO se imposti
  // PROXY_ACCESS_KEY su Vercel. Se non la imposti, nessun cambiamento. ---
  if (process.env.PROXY_ACCESS_KEY) {
    const provided = req.headers['x-proxy-key'];
    if (provided !== process.env.PROXY_ACCESS_KEY) {
      return res.status(401).json({ error: 'Non autorizzato: header x-proxy-key mancante o errato.' });
    }
  }

  // Accumula le informazioni per la voce di log di questa richiesta; viene
  // scritta con pushLog() su ogni percorso di uscita (successo, errore,
  // eccezione) cosi' compare sempre, non solo quando tutto va bene.
  let logEntry = null;

  try {
    let body = req.body;

    // Se il body viene ricevuto come stringa, fai il parse in JSON
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Body mancante o non valido.' });
    }

    const model = body.model || '(modello non specificato)';

    // Iniezione dinamica del thinking/reasoning, con copia di sicurezza per il retry
    const { originalBody, wasModified } = applyMaxThinking(body);

    logEntry = {
      model,
      stream: Boolean(body.stream),
      reasoningSkipped: !wasModified,
      usedOverride: Boolean(findOverride(model)),
      usedFallbackWithoutReasoning: false,
    };

    // Copia e pulizia degli header
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
        headers[key] = value;
      }
    }
    headers['content-type'] = 'application/json';

    // Iniezione opzionale della chiave lato server (vedi commento in testa al file)
    if (process.env.BEDROCK_API_KEY) {
      headers['authorization'] = `Bearer ${process.env.BEDROCK_API_KEY}`;
    }

    // --- Chiamata a Bedrock: sceglie da sola il path /openai/ o normale,
    // con timeout per non restare appesi fino al limite hard di Vercel ---
    let attempt = await callBedrockSmart(body, headers, FETCH_TIMEOUT_MS);

    // --- Retry dinamico: se il modello ha rifiutato i parametri di
    // reasoning appena aggiunti, ritenta UNA volta senza, invece di
    // bloccare la chat. Questo è il pezzo che ti protegge quando cambi
    // modello o quando ne esce uno nuovo con un formato diverso. ---
    if (!attempt.response.ok && wasModified) {
      attempt = await callBedrockSmart(originalBody, headers, FETCH_TIMEOUT_MS);
      logEntry.usedFallbackWithoutReasoning = true;
    }

    logEntry.url = attempt.url;
    logEntry.region = attempt.region;
    logEntry.openAIPrefix = attempt.prefix;
    logEntry.routeAutoCorrected = attempt.corrected;
    logEntry.httpStatus = attempt.response.status;
    logEntry.ok = attempt.response.ok;
    // "Compatibile con il reasoning" nella pratica = i parametri erano nella
    // richiesta mandata E Bedrock l'ha accettata (nessun retry, nessun errore).
    logEntry.reasoningAccepted = wasModified && !logEntry.usedFallbackWithoutReasoning && attempt.response.ok;

    // Se AWS restituisce ancora un errore, restituisci il JSON di errore
    if (!attempt.response.ok) {
      const errorData = await attempt.response.json().catch(() => ({ error: 'Errore risposta AWS' }));
      logEntry.error = (errorData && (errorData.error?.message || errorData.error)) || 'Errore sconosciuto';
      logEntry.reasoningDetected = false;
      pushLog(logEntry);
      return res.status(attempt.response.status).json(errorData);
    }

    // GESTIONE STREAMING (se il client richiede stream: true)
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(attempt.response.status);

      const reader = attempt.response.body.getReader();

      // Rilevazione "sta ragionando" in streaming: senza fare il parse
      // completo di ogni evento SSE (costoso e fragile su frammenti a
      // metà), cerca la comparsa del campo "reasoning_content" nel testo
      // grezzo dei chunk e ne accumula un'anteprima, senza toccare i byte
      // che vengono comunque inoltrati al client invariati.
      const decoder = new TextDecoder();
      const reasoningRe = /"reasoning_content"\s*:\s*"((?:\\.|[^"\\])*)"/g;
      let reasoningDetected = false;
      let reasoningPreview = '';
      let logged = false;

      const finalizeLog = (note) => {
        if (logged) return;
        logged = true;
        logEntry.reasoningDetected = reasoningDetected;
        if (reasoningPreview) logEntry.reasoningPreview = reasoningPreview;
        if (note) logEntry.note = note;
        pushLog(logEntry);
      };

      // Se Janitor chiude la connessione (utente cambia chat, riprova, ecc.),
      // interrompi anche la lettura da Bedrock invece di continuare a
      // generare (e pagare) token che nessuno riceverà.
      req.on('close', () => {
        reader.cancel().catch(() => {});
        finalizeLog('connessione chiusa dal client durante lo stream');
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);

        if (reasoningPreview.length < REASONING_PREVIEW_CHARS) {
          const chunkText = decoder.decode(value, { stream: true });
          reasoningRe.lastIndex = 0;
          let m;
          while ((m = reasoningRe.exec(chunkText)) && reasoningPreview.length < REASONING_PREVIEW_CHARS) {
            reasoningDetected = true;
            try {
              reasoningPreview += JSON.parse(`"${m[1]}"`); // decodifica gli escape JSON (\n, \", ecc.)
            } catch {
              reasoningPreview += m[1];
            }
          }
        }
      }
      finalizeLog();
      return res.end();
    }

    // GESTIONE RISPOSTA NORMALE (senza streaming)
    const data = await attempt.response.json();
    const reasoningText = getReasoningText(data?.choices?.[0]?.message);
    logEntry.reasoningDetected = Boolean(reasoningText && reasoningText.trim());
    if (reasoningText) logEntry.reasoningPreview = reasoningText.slice(0, REASONING_PREVIEW_CHARS);
    pushLog(logEntry);
    return res.status(attempt.response.status).json(data);

  } catch (err) {
    if (logEntry) {
      logEntry.error = err.message;
      logEntry.exception = true;
      pushLog(logEntry);
    }
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Timeout nella richiesta a Bedrock.' });
    }
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
module.exports.config = config;
