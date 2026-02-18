const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
// Visit this URL to confirm your server is running

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Predict Perfect backend is running ✅',
    endpoints: ['/generate-questions', '/auto-score']
  });
});

// ─── Generate Questions ───────────────────────────────────────────────────────
// Called by QuestionGenerator.jsx in the admin panel

app.post('/generate-questions', async (req, res) => {
  console.log('[generate-questions] Request received');

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    console.error('[generate-questions] Missing ANTHROPIC_API_KEY');
    return res.status(500).json({ error: 'Server configuration error: API key missing' });
  }

  try {
    // Calculate the upcoming Monday→Sunday window
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon ... 6=Sat
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const quizWindow = `${fmt(nextMonday)} to ${fmt(nextSunday)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: `You are helping create prediction questions for a weekly prediction game. Generate 12 prediction questions (3 per category) for the quiz week running from ${quizWindow}.

CRITICAL: All questions must be about events that will be DECIDED or RESOLVED during this specific week (${quizWindow}). Do NOT generate questions about events that will have already happened before ${fmt(nextMonday)}, and do NOT generate questions about events happening after ${fmt(nextSunday)}. The quiz opens on ${fmt(nextMonday)} and locks on ${fmt(nextSunday)} — every question must be answerable by ${fmt(nextSunday)}.

Requirements:
- 3 SPORTS questions (specific games, tournaments, player performance happening this week)
- 3 POLITICS & NEWS questions (votes, decisions, announcements expected this week)
- 3 ECONOMICS & FINANCE questions (data releases, market moves, earnings reports this week)
- 3 ANOMALIES questions (wildcards: weather records, viral moments, unexpected science, unusual events)

For each question:
- Make it specific and verifiable — someone must be able to check the result by ${fmt(nextSunday)}
- Include 2-4 clear answer options
- Binary (Yes/No, Win/Loss) preferred, multiple choice fine

Today's date (when questions are being generated): ${today.toLocaleDateString('en-GB')}
Quiz week: ${quizWindow}

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "questions": [
    {
      "category": "sports",
      "question_text": "Will the Lakers beat the Celtics in their next game?",
      "options": ["Win", "Loss"]
    },
    {
      "category": "anomalies",
      "question_text": "Will a new world record be set at the World Athletics Championships this week?",
      "options": ["Yes", "No"]
    }
  ]
}`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[generate-questions] Claude API error:', response.status, errorText);
      return res.status(502).json({ error: `Claude API error: ${response.status}` });
    }

    const data = await response.json();
    console.log('[generate-questions] Success');

    // Extract the text content
    const textContent = data.content?.find(item => item.type === 'text');
    if (!textContent) {
      return res.status(502).json({ error: 'No text content in Claude response' });
    }

    // Clean up any accidental markdown formatting and parse JSON
    const cleanText = textContent.text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleanText);

    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      return res.status(502).json({ error: 'Invalid response format from Claude' });
    }

    res.json({ questions: parsed.questions });

  } catch (err) {
    console.error('[generate-questions] Server error:', err.message);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// ─── Auto-Score with Web Search ───────────────────────────────────────────────
// Called by AutoScoreWithAPIs.jsx in the admin panel

app.post('/auto-score', async (req, res) => {
  console.log('[auto-score] Request received');

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    console.error('[auto-score] Missing ANTHROPIC_API_KEY');
    return res.status(500).json({ error: 'Server configuration error: API key missing' });
  }

  const { questions } = req.body;

  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'No questions provided' });
  }

  // Helper to safely parse options (copied from frontend)
  const parseOptions = (options) => {
    if (Array.isArray(options)) return options;
    if (typeof options === 'string') {
      if (options.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(options);
          if (Array.isArray(parsed)) return parsed;
        } catch (e) {}
      }
      if (options.includes(',')) {
        return options.split(',').map(opt => opt.trim()).filter(Boolean);
      }
      if (options.trim()) return [options.trim()];
    }
    return [];
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search'
          }
        ],
        messages: [
          {
            role: 'user',
            content: `You are scoring prediction questions. For each question, search the web to find the actual outcome, then determine the correct answer.

Current date: ${new Date().toLocaleDateString()}

Questions to score:
${questions.map((q, i) => {
  const options = parseOptions(q.options);
  return `${i + 1}. [${q.category}] ${q.question_text}
   Options: ${options.join(', ')}
   Question ID: ${q.id}`;
}).join('\n\n')}

For each question:
1. Search the web for the actual outcome
2. Determine which option is correct
3. Provide the source/evidence
4. Rate your confidence (high/medium/low)

IMPORTANT: Only suggest answers for questions where the event has already occurred and you can find definitive results. For questions about future events or where you cannot find results, mark as "not_available".

Respond with valid JSON (no markdown):
{
  "results": [
    {
      "question_index": 0,
      "question_id": "actual-question-id",
      "correct_answer": "Win",
      "confidence": "high",
      "evidence": "Lakers defeated Celtics 112-109 on Feb 15, 2025",
      "source": "ESPN"
    }
  ]
}`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[auto-score] Claude API error:', response.status, errorText);
      return res.status(502).json({ error: `Claude API error: ${response.status}` });
    }

    const data = await response.json();
    console.log('[auto-score] Success, processing response...');

    // Extract all text blocks (web search returns multiple content blocks)
    let fullText = '';
    for (const item of data.content) {
      if (item.type === 'text') {
        fullText += item.text + '\n';
      }
    }

    // Extract the JSON object from the response text
    const jsonMatch = fullText.match(/\{[\s\S]*"results"[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[auto-score] No JSON found in response:', fullText);
      return res.status(502).json({ error: 'Could not extract results from Claude response' });
    }

    const cleanText = jsonMatch[0]
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = JSON.parse(cleanText);

    if (!parsed.results || !Array.isArray(parsed.results)) {
      return res.status(502).json({ error: 'Invalid response format from Claude' });
    }

    console.log(`[auto-score] Returning ${parsed.results.length} results`);
    res.json({ results: parsed.results });

  } catch (err) {
    console.error('[auto-score] Server error:', err.message);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Predict Perfect backend running on port ${PORT}`);
});
