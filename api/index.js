export default async function handler(req, res) {
  // Gestione Header CORS per Janitor e Lorebally
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }

      // Iniezione parametro Reasoning per Kimi K2.5
      body.reasoning_effort = 'high';

      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];

      const response = await fetch('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).send('Vercel Proxy Kimi K2.5 Attivo!');
}
