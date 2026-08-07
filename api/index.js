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
//    reasoning è attivo (2048 -> 4096).
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
//                        spese sul tuo account AWS.
// ============================================================================

const config = {
  // 300s = default E massimo sul piano Hobby (con Fluid Compute, attivo di
  // default sui progetti nuovi). Su Pro/Enterprise si può salire fino a
  // 800s senza altro, o fino a 1800s (beta) con configurazione aggiuntiva.
  maxDuration: 300,
};

const BEDROCK_URL = 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions';
const FETCH_TIMEOUT_MS = 280_000; // resta sotto i 300s di maxDuration, per rispondere con un errore leggibile invece di un hard-kill
const MIN_MAX_TOKENS_WITH_REASONING = 4096; // alzato da 2048: più margine tra ragionamento "high" e risposta visibile

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

async function callBedrock(body, headers, signal) {
  return fetch(BEDROCK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
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
    return res.status(200).send('Proxy Vercel Attivo!');
  }

  // --- Protezione opzionale anti-abuso: si attiva SOLO se imposti
  // PROXY_ACCESS_KEY su Vercel. Se non la imposti, nessun cambiamento. ---
  if (process.env.PROXY_ACCESS_KEY) {
    const provided = req.headers['x-proxy-key'];
    if (provided !== process.env.PROXY_ACCESS_KEY) {
      return res.status(401).json({ error: 'Non autorizzato: header x-proxy-key mancante o errato.' });
    }
  }

  try {
    let body = req.body;

    // Se il body viene ricevuto come stringa, fai il parse in JSON
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Body mancante o non valido.' });
    }

    // Iniezione dinamica del thinking/reasoning, con copia di sicurezza per il retry
    const { originalBody, wasModified } = applyMaxThinking(body);

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

    // --- Chiamata a Bedrock con timeout, per non restare appesi fino al
    // limite hard di Vercel senza un errore leggibile ---
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let bedrockResponse;
    try {
      bedrockResponse = await callBedrock(body, headers, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    // --- Retry dinamico: se il modello ha rifiutato i parametri di
    // reasoning appena aggiunti, ritenta UNA volta senza, invece di
    // bloccare la chat. Questo è il pezzo che ti protegge quando cambi
    // modello o quando ne esce uno nuovo con un formato diverso. ---
    if (!bedrockResponse.ok && wasModified) {
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), FETCH_TIMEOUT_MS);
      try {
        bedrockResponse = await callBedrock(originalBody, headers, controller2.signal);
      } finally {
        clearTimeout(timeout2);
      }
    }

    // Se AWS restituisce ancora un errore, restituisci il JSON di errore
    if (!bedrockResponse.ok) {
      const errorData = await bedrockResponse.json().catch(() => ({ error: 'Errore risposta AWS' }));
      return res.status(bedrockResponse.status).json(errorData);
    }

    // GESTIONE STREAMING (se il client richiede stream: true)
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(bedrockResponse.status);

      const reader = bedrockResponse.body.getReader();

      // Se Janitor chiude la connessione (utente cambia chat, riprova, ecc.),
      // interrompi anche la lettura da Bedrock invece di continuare a
      // generare (e pagare) token che nessuno riceverà.
      req.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    // GESTIONE RISPOSTA NORMALE (senza streaming)
    const data = await bedrockResponse.json();
    return res.status(bedrockResponse.status).json(data);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Timeout nella richiesta a Bedrock.' });
    }
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
module.exports.config = config;
    
