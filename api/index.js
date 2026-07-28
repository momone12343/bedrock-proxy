export default async function handler(req, res) {
  // Header CORS universali
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const TARGET_BASE = 'https://bedrock-mantle.us-east-1.api.aws/v1';

  try {
    // Gestione rotte dinamiche
    let path = req.url.replace(/^\/api/, '');
    if (!path || path === '/') {
      path = '/chat/completions';
    }

    const targetUrl = `${TARGET_BASE}${path}`;

    // Pulizia Header
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['accept-encoding'];

    const fetchOptions = {
      method: req.method,
      headers: headers
    };

    // Gestione BODY sicuro per chiamate POST
    if (req.method === 'POST') {
      let body = req.body || {};
      
      if (typeof body === 'string' && body.trim().length > 0) {
        try {
          body = JSON.parse(body);
        } catch (e) {
          // Lascia il body così com'è se non è un JSON valido
        }
      }

      if (typeof body === 'object' && body !== null) {
        if (!body.reasoning_effort) {
          body.reasoning_effort = 'high';
        }
        fetchOptions.body = JSON.stringify(body);
        headers['content-type'] = 'application/json';
      }
    }

    // Invia la richiesta a Bedrock Mantle
    const response = await fetch(targetUrl, fetchOptions);
    
    // Legge la risposta prima come TESTO per evitare il crash se è vuota
    const responseText = await response.text();

    if (!responseText || responseText.trim().length === 0) {
      return res.status(response.status).send('');
    }

    // Prova a convertire in JSON, altrimenti invia il testo così com'è
    try {
      const jsonData = JSON.parse(responseText);
      return res.status(response.status).json(jsonData);
    } catch (e) {
      return res.status(response.status).send(responseText);
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
