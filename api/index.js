export default async function handler(req, res) {
  // Header CORS universali (per Janitor AI, Lorebally e qualsiasi altra app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const TARGET_BASE = 'https://bedrock-mantle.us-east-1.api.aws/v1';

  try {
    // Gestione dinamica delle rotte (es. /chat/completions o /models)
    let path = req.url.replace(/^\/api/, '');
    if (!path || path === '/') {
      path = '/chat/completions';
    }

    const targetUrl = `${TARGET_BASE}${path}`;

    // Pulizia degli header per evitare conflitti di Host o Encoding
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['accept-encoding'];

    // CHIAMATE POST (Chat / Roleplay / Generazione)
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }

      // Attiva il ragionamento se non è già specificato dal client
      if (!body.reasoning_effort) {
        body.reasoning_effort = 'high';
      }

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    }

    // CHIAMATE GET (Test di connessione / Lista dei modelli da Lorebally)
    if (req.method === 'GET') {
      const response = await fetch(targetUrl, { method: 'GET', headers });
      const data = await response.json();
      return res.status(response.status).json(data);
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
