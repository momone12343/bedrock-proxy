export default async function handler(req, res) {
  // Header CORS universali
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Se apri il link dal browser (richiesta GET alla radice), rispondi che è attivo
  const rawPath = req.url.replace(/^\/api/, '');
  if (req.method === 'GET' && (!rawPath || rawPath === '/' || rawPath === '')) {
    return res.status(200).send('Vercel Proxy Attivo!');
  }

  const TARGET_BASE = 'https://bedrock-mantle.us-east-1.api.aws/v1';
  let path = rawPath;
  if (!path || path === '/') {
    path = '/chat/completions';
  }

  const targetUrl = `${TARGET_BASE}${path}`;

  // Pulizia Header
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];

  try {
    // Gestione chiamate POST (Invio messaggi da Janitor / Lorebally)
    if (req.method === 'POST') {
      let body = req.body || {};
      if (typeof body === 'string' && body.trim().length > 0) {
        try { body = JSON.parse(body); } catch (e) {}
      }

      if (typeof body === 'object' && body !== null) {
        if (!body.reasoning_effort) {
          body.reasoning_effort = 'high';
        }
      }

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const responseText = await response.text();
      if (!responseText) return res.status(response.status).send('');

      try {
        return res.status(response.status).json(JSON.parse(responseText));
      } catch (e) {
        return res.status(response.status).send(responseText);
      }
    }

    // Gestione chiamate GET per liste modelli (es. /models)
    if (req.method === 'GET') {
      const response = await fetch(targetUrl, { method: 'GET', headers });
      const responseText = await response.text();
      if (!responseText) return res.status(response.status).send('');

      try {
        return res.status(response.status).json(JSON.parse(responseText));
      } catch (e) {
        return res.status(response.status).send(responseText);
      }
    }

    return res.status(405).json({ error: 'Metodo non supportato' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
