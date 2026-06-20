export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!global._genMap) global._genMap = {};
  const now = Date.now();
  if (!global._genMap[ip]) global._genMap[ip] = [];
  global._genMap[ip] = global._genMap[ip].filter(t => now - t < 60000);
  if (global._genMap[ip].length >= 8) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
  global._genMap[ip].push(now);

  try {
    const { imageBase64, mood } = req.body;
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Server not configured' });

    let prompt;

    if (imageBase64) {
      // Analyze frame to detect mood + generate prompt
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
                { text: `Analyze this video frame and detect the overall mood/theme (motivational, sad, romantic, intense, calm, aggressive, inspirational, dark, uplifting, etc).

Then generate a Stable Diffusion image prompt for a CINEMATIC PORTRAIT of a person that perfectly matches this mood for a social media thumbnail.

Rules for the prompt:
- Describe a person (not a specific celebrity — a generic powerful-looking person)
- Match the mood exactly (determined face for motivational, tearful for sad, soft gaze for romantic, etc)
- Always include: cinematic lighting, shallow depth of field, dark dramatic background, photorealistic, 8k, professional photography
- The person should fill most of the frame
- 1-3 sentences max

Respond ONLY with this JSON:
{"mood": "detected mood here", "prompt": "your image prompt here", "quote_style": "short quote theme that fits this mood e.g. never give up / love is everything / rise above"}`
                }
              ]
            }],
            generationConfig: {
              temperature: 0.8,
              maxOutputTokens: 300,
              thinkingConfig: { thinkingBudget: 0 }
            }
          })
        }
      );

      const raw = await geminiRes.text();
      if (!geminiRes.ok) {
        let m = 'Gemini error';
        try { m = JSON.parse(raw).error?.message || m; } catch(e) {}
        throw new Error(m);
      }

      const data = JSON.parse(raw);
      const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Could not parse mood analysis.');
      const parsed = JSON.parse(jsonMatch[0]);

      return res.status(200).json({
        mood: parsed.mood,
        prompt: parsed.prompt,
        quoteStyle: parsed.quote_style
      });

    } else if (mood) {
      // Manual mood selected — generate prompt for it
      const moodPrompts = {
        motivational: 'A powerful determined person with intense focused eyes, jaw set with resolve, dramatic side lighting, dark moody background, cinematic portrait, photorealistic, 8k, shallow depth of field',
        sad: 'A person with sorrowful eyes looking down, soft diffused lighting, blurred rainy background, emotional cinematic portrait, photorealistic, 8k, film grain',
        romantic: 'A person with soft warm gaze, golden hour lighting, blurred bokeh background, intimate cinematic portrait, warm tones, photorealistic, 8k',
        intense: 'A person with fierce piercing eyes staring directly at camera, high contrast dramatic lighting, dark background, cinematic close-up portrait, photorealistic, 8k',
        calm: 'A person with peaceful serene expression, soft natural lighting, blurred nature background, cinematic portrait, photorealistic, 8k',
        dark: 'A person with brooding mysterious expression, low key dramatic lighting, deep shadows, cinematic noir portrait, photorealistic, 8k',
        aggressive: 'A person with fierce aggressive expression, sharp dramatic lighting, dark stormy background, cinematic portrait, photorealistic, 8k',
        uplifting: 'A person with joyful triumphant expression arms raised, golden sunlight, cinematic portrait shot from below, photorealistic, 8k'
      };
      prompt = moodPrompts[mood] || moodPrompts.motivational;
      return res.status(200).json({ mood, prompt, quoteStyle: mood });
    } else {
      throw new Error('Provide imageBase64 or mood');
    }

  } catch (err) {
    console.error('Generate API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
