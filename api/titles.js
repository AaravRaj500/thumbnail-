export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: simple in-memory (resets on cold start — fine for 50 users)
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!global._rateMap) global._rateMap = {};
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxReq = 5; // max 5 requests per minute per IP

  if (!global._rateMap[ip]) global._rateMap[ip] = [];
  global._rateMap[ip] = global._rateMap[ip].filter(t => now - t < windowMs);
  if (global._rateMap[ip].length >= maxReq) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  global._rateMap[ip].push(now);

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Server not configured' });

    const prompt = `You are a YouTube thumbnail title expert. Look at this video frame and generate 5 short, catchy, click-worthy thumbnail titles.

Rules:
- Max 6 words each
- ALL CAPS or Title Case  
- Use power words (INSANE, NEVER, FIRST TIME, EXPOSED, etc.)
- Add 1 emoji per title
- Make them curiosity-driven or shocking
- Vary the styles (shocking, funny, epic, motivational, mysterious)

Respond ONLY with a JSON array of 5 strings. No explanation, no markdown. Example:
["INSANE FIRST ATTEMPT 😱", "I CAN'T BELIEVE THIS 🔥", "NOBODY EXPECTED THIS 💀", "This Changed Everything ⚡", "GONE WRONG... 😂"]`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
              { text: prompt }
            ]
          }],
          generationConfig: { temperature: 0.9, maxOutputTokens: 300 }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      throw new Error(err.error?.message || 'Gemini API failed');
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let titles;
    try {
      titles = JSON.parse(clean);
    } catch {
      // Fallback: split by newlines
      titles = text.split('\n')
        .map(l => l.replace(/^[\d\-\.\*\s"]+|["]+$/g, '').trim())
        .filter(l => l.length > 3)
        .slice(0, 5);
    }

    return res.status(200).json({ titles });

  } catch (err) {
    console.error('ThumbAI API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
