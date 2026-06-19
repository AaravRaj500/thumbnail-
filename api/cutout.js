export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!global._cutoutMap) global._cutoutMap = {};
  const now = Date.now();
  if (!global._cutoutMap[ip]) global._cutoutMap[ip] = [];
  global._cutoutMap[ip] = global._cutoutMap[ip].filter(t => now - t < 60000);
  if (global._cutoutMap[ip].length >= 5) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  global._cutoutMap[ip].push(now);

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Server not configured' });

    // v1beta + gemini-2.5-flash-image, NO responseModalities
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Remove the background from this image completely. Keep only the main person or subject. Make the background fully transparent. Return the result as a PNG with transparent background.' },
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
            ]
          }]
        })
      }
    );

    const raw = await geminiRes.text();
    if (!geminiRes.ok) {
      let msg = 'Gemini API error';
      try { msg = JSON.parse(raw).error?.message || msg; } catch(e) {}
      throw new Error(msg);
    }

    let data;
    try { data = JSON.parse(raw); }
    catch(e) { throw new Error('Bad response: ' + raw.slice(0, 120)); }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imagePart) {
      const txt = parts.find(p => p.text);
      throw new Error(txt?.text?.slice(0, 150) || 'No cutout returned. Make sure there is a clear person in the frame.');
    }

    return res.status(200).json({ cutoutBase64: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType });
  } catch (err) {
    console.error('Cutout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
