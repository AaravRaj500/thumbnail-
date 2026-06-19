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

    // Step 1: Ask Gemini 2.5 Flash to generate a segmentation mask for the main person
    const segRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
              { text: `Detect the main person or subject in this image and return a segmentation mask.
Output a JSON object with this exact format and nothing else:
{"box_2d": [y1, x1, y2, x2], "mask": "<base64 PNG mask>"}

Where:
- box_2d contains normalized coordinates (0-1000 scale) as [top, left, bottom, right]
- mask is a base64-encoded PNG image (same dimensions as input) where the person is WHITE and background is BLACK

Return ONLY the JSON. No explanation, no markdown.` }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );

    const segRaw = await segRes.text();
    if (!segRes.ok) {
      let msg = 'Segmentation failed';
      try { msg = JSON.parse(segRaw).error?.message || msg; } catch(e) {}
      throw new Error(msg);
    }

    const segData = JSON.parse(segRaw);
    const segText = segData.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';

    // Try to extract JSON from response
    const jsonMatch = segText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No mask data returned. Try a clearer image with a visible person.');

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch(e) { throw new Error('Could not parse mask data from Gemini.'); }

    if (!parsed.mask) throw new Error('No mask in response. Make sure there is a clear person in the frame.');

    return res.status(200).json({ maskBase64: parsed.mask });

  } catch (err) {
    console.error('Cutout API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
