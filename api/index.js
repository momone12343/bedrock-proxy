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

      const data = await bedrockResponse.json();
      return res.status(bedrockResponse.status).json(data);

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).send("Proxy Vercel Attivo!");
}
