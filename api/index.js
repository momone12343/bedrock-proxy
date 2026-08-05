export default async function handler(req, res) {
  // Gestione CORS per Janitor / Lorebally
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      let body = req.body;
      
      // Se il body viene ricevuto come stringa, fai il parse in JSON
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }

      // Iniezione forzata della modalità Thinking
      body.reasoning_effort = "high";

      // Copia e pulizia degli header
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'content-length') {
          headers[key] = value;
        }
      }
      headers['content-type'] = 'application/json';

      // Inoltro a Bedrock Mantle
      const bedrockResponse = await fetch('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });

      // Se AWS restituisce un errore (status non 200), restituisci il JSON di errore
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
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).send("Proxy Vercel Attivo!");
}
