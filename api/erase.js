export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!global._eraseMap) global._eraseMap = {};
  const now = Date.now();
  if (!global._eraseMap[ip]) global._eraseMap[ip] = [];
  global._eraseMap[ip] = global._eraseMap[ip].filter(t => now - t < 60000);
  if (global._eraseMap[ip].length >= 5) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  global._eraseMap[ip].push(now);

  try {
    const { imageBase64, maskBase64 } = req.body;
    if (!imageBase64 || !maskBase64) return res.status(400).json({ error: 'Image and mask required' });
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Server not configured' });

    // v1beta + gemini-2.5-flash-image, NO responseModalities in body
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'The second image is a white-on-black mask. Remove everything covered by white areas in the first image. Fill those areas naturally with background so it looks seamless, like the objects were never there. Return only the edited image.' },
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
              { inline_data: { mime_type: 'image/png',  data: maskBase64  } }
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
      throw new Error(txt?.text?.slice(0, 150) || 'No image returned. Try painting a larger area.');
    }

    return res.status(200).json({ editedImageBase64: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType });
  } catch (err) {
    console.error('Erase error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
