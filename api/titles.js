export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 5 req/min per IP
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!global._rateMap) global._rateMap = {};
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReq = 5;
  if (!global._rateMap[ip]) global._rateMap[ip] = [];
  global._rateMap[ip] = global._rateMap[ip].filter(t => now - t < windowMs);
  if (global._rateMap[ip].length >= maxReq) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  global._rateMap[ip].push(now);

  try {
    const { imageBase64, mode, personName } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Server not configured' });

    let prompt;

    if (mode === 'detect') {
      // Try to identify person and generate quotes
      prompt = `You are analyzing a video frame for social media thumbnail creation.

TASK 1: Try to identify if there is a recognizable person in this image (celebrity, athlete, politician, influencer, historical figure, etc.)

TASK 2: If you identify them, generate 4 powerful motivational/inspirational quotes in their voice and style — short, punchy, ALL CAPS, 4-8 words each. Make them sound like something THIS specific person would say, based on their known philosophy and personality.

TASK 3: If you CANNOT identify the person with reasonable confidence, set personFound to false.

Respond ONLY with valid JSON, no markdown, no explanation:

If person identified:
{"personFound": true, "person": "Full Name", "quotes": ["QUOTE ONE", "QUOTE TWO", "QUOTE THREE", "QUOTE FOUR"]}

If NOT identified:
{"personFound": false}`;

    } else if (mode === 'named') {
      // User told us the name, generate quotes for them
      prompt = `Generate 4 powerful motivational/inspirational quotes in the voice and style of ${personName}.

Rules:
- Short and punchy, 4-8 words each
- ALL CAPS
- Sound authentically like ${personName} — match their known philosophy, energy, and domain
- No hashtags, no emojis
- Varied — mix defiance, ambition, discipline, resilience themes

Respond ONLY with a JSON array of 4 strings. No markdown, no explanation:
["QUOTE ONE", "QUOTE TWO", "QUOTE THREE", "QUOTE FOUR"]`;
    }

    const parts = [{ text: prompt }];
    if (mode === 'detect') {
      parts.unshift({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
    } else {
      // For named mode, still send image for context
      parts.unshift({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 400,
            thinkingConfig: { thinkingBudget: 0 } // faster, no thinking needed
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      throw new Error(err.error?.message || 'Gemini API failed');
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    if (mode === 'detect') {
      let parsed;
      try { parsed = JSON.parse(clean); }
      catch { return res.status(200).json({ personFound: false }); }

      if (!parsed.personFound) {
        return res.status(200).json({ personFound: false });
      }
      return res.status(200).json({
        personFound: true,
        person: parsed.person,
        quotes: parsed.quotes || []
      });

    } else {
      // named mode — expect array of quotes
      let quotes;
      try {
        quotes = JSON.parse(clean);
        if (!Array.isArray(quotes)) throw new Error();
      } catch {
        // Fallback: extract lines
        quotes = clean.split('\n')
          .map(l => l.replace(/^[\d\-\.\*\s"']+|["']+$/g, '').trim().toUpperCase())
          .filter(l => l.length > 3 && l.length < 80)
          .slice(0, 4);
      }
      return res.status(200).json({ quotes });
    }

  } catch (err) {
    console.error('ThumbAI API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
