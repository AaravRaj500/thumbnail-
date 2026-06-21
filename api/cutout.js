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

    // Use text-only Gemini 2.5 Flash (FREE) to get bounding box of person
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
              { text: `Detect the main person or subject in this image.
Return ONLY a JSON object with their bounding box as percentage of image dimensions (0-100):
{"x1": left%, "y1": top%, "x2": right%, "y2": bottom%, "found": true}
If no person found: {"found": false}
No explanation, no markdown, just JSON.` }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 100,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );

    const raw = await geminiRes.text();
    if (!geminiRes.ok) {
      let msg = 'Gemini error';
      try { msg = JSON.parse(raw).error?.message || msg; } catch(e) {}
      throw new Error(msg);
    }

    const data = JSON.parse(raw);
    const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No bounding box returned');

    const bbox = JSON.parse(match[0]);
    if (!bbox.found) throw new Error('No person detected in frame. Try a clearer frame with a visible person.');

    return res.status(200).json({ bbox });

  } catch (err) {
    console.error('Cutout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
