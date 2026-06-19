export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
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

    // Use Gemini 2.0 Flash image editing (imagen-3 style inpainting via gemini)
    // We send: original image + mask image + instruction to remove/fill
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: { mime_type: 'image/jpeg', data: imageBase64 }
              },
              {
                inline_data: { mime_type: 'image/png', data: maskBase64 }
              },
              {
                text: `The second image is a mask where white areas indicate regions the user wants removed from the first image.
Remove everything in the white masked areas from the first image and fill the background naturally and seamlessly, as if those objects were never there.
Return ONLY the edited image with objects removed. Make the fill look realistic and match the surrounding background.`
              }
            ]
          }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            temperature: 1,
            maxOutputTokens: 8192
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      throw new Error(err.error?.message || 'Gemini API failed');
    }

    const data = await geminiRes.json();

    // Find the image part in response
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart) {
      throw new Error('Gemini did not return an edited image. Try a different model or brush area.');
    }

    return res.status(200).json({
      editedImageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType
    });

  } catch (err) {
    console.error('Erase API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
