export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Server not configured' });
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Remove the background completely. Keep only the main person. Make background transparent. Return PNG with transparent background.' },
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
            ]
          }]
        })
      }
    );
    const raw = await geminiRes.text();
    if (!geminiRes.ok) { let m='Error'; try{m=JSON.parse(raw).error?.message||m;}catch(e){} throw new Error(m); }
    const data = JSON.parse(raw);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const img = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    if (!img) { const t=parts.find(p=>p.text); throw new Error(t?.text?.slice(0,150)||'No cutout returned.'); }
    return res.status(200).json({ cutoutBase64: img.inlineData.data, mimeType: img.inlineData.mimeType });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}
