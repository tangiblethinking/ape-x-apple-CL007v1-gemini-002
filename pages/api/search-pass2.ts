import type { NextApiRequest, NextApiResponse } from 'next';
import { callAI, extractJSON, AIProvider, GEMINI_JOB_ARRAY_SCHEMA } from '../../lib/ai-providers';
import { getClaudeSearchPrompt } from '../../lib/claude-instructions';
import { getGeminiSearchPrompt } from '../../lib/gemini-instructions';

interface TrustedResult {
  title: string;
  company: string;
  url: string;
  snippet: string;
  source: string;
}

interface AggregatorResult {
  title: string;
  company: string;
  aggregator_url: string;
  snippet: string;
  aggregator: string;
}

interface VerifiedAggregator extends AggregatorResult {
  verified_url?: string;
  verified: boolean;
}

// ── JSON repair: close unclosed arrays/objects from truncated AI output ──
function repairJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const arrayStart = s.indexOf('[');
  if (arrayStart === -1) return '[]';
  s = s.slice(arrayStart);
  let depth = 0, inString = false, escaped = false, lastCompleteObjectEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') { depth--; if (depth === 1) lastCompleteObjectEnd = i; }
  }
  try { JSON.parse(s); return s; } catch { /* needs repair */ }
  if (lastCompleteObjectEnd > 0) {
    let truncated = s.slice(0, lastCompleteObjectEnd + 1).trim();
    truncated = truncated.replace(/,\s*$/, '');
    return truncated + ']';
  }
  return '[]';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    trusted, aggregators, instructions, specialInstructions,
    apiKeyOverride, serperKeyOverride, titlesSearched, aiProvider,
  } = req.body;

  const provider: AIProvider = aiProvider || 'claude';
  const envKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
  const apiKey = apiKeyOverride || envKey;
  const serperKey = serperKeyOverride || process.env.SERPER_API_KEY;

  if (!apiKey) return res.status(400).json({ error: 'No API key configured. Add it in Settings.' });
  if (!serperKey) return res.status(400).json({ error: 'No Serper API key configured.' });

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Verify aggregator results via Serper
  const verifiedAggregators: VerifiedAggregator[] = [];
  for (const agg of (aggregators as AggregatorResult[])) {
    if (!agg.company || agg.company === 'Unknown') {
      verifiedAggregators.push({ ...agg, verified: false }); continue;
    }
    try {
      const verifyQuery = `"${agg.title}" "${agg.company}" careers apply job`;
      const serperRes = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: verifyQuery, num: 5 }),
      });
      if (serperRes.ok) {
        const data = await serperRes.json();
        const results = (data.organic || []) as { link: string; title: string }[];
        const aggregatorDomains = ['linkedin.com','indeed.com','ziprecruiter.com','glassdoor.com',
          'monster.com','careerbuilder.com','dice.com','builtin.com','simplyhired.com',
          'snagajob.com','flexjobs.com','talent.com','google.com'];
        const companyResult = results.find(r => {
          try { return !aggregatorDomains.some(d => new URL(r.link).hostname.toLowerCase().includes(d)); }
          catch { return false; }
        });
        verifiedAggregators.push(companyResult
          ? { ...agg, verified: true, verified_url: companyResult.link }
          : { ...agg, verified: false });
      } else {
        verifiedAggregators.push({ ...agg, verified: false });
      }
    } catch {
      verifiedAggregators.push({ ...agg, verified: false });
    }
  }

  const trustedText = (trusted as TrustedResult[]).map(r =>
    `[ATS]${r.company}|${r.title}|${r.url}|${r.snippet}`).join('\n');
  const verifiedAggText = verifiedAggregators.filter(r => r.verified).map(r =>
    `[AGG-V]${r.company}|${r.title}|${r.verified_url}|${r.snippet}`).join('\n');
  const unverifiedAggText = verifiedAggregators.filter(r => !r.verified).map(r =>
    `[AGG-U]${r.company}|${r.title}|${r.aggregator_url}|${r.snippet}`).join('\n');
  const allResultsText = [trustedText, verifiedAggText, unverifiedAggText].filter(Boolean).join('\n');

  const finalInstructions = specialInstructions
    ? `${instructions}\n\nSPECIAL:\n${specialInstructions}` : instructions;

  const systemPrompt = provider === 'gemini'
    ? getGeminiSearchPrompt(instructions, specialInstructions || null, titlesSearched || [], today)
    : getClaudeSearchPrompt(instructions, specialInstructions || null, titlesSearched || [], today);

  try {
    // Only attach a responseSchema for Gemini. Claude returns JSON via prompt;
    // attaching a schema to the Gemini call constrains its output to the
    // correct job-array shape (previously misrouted to profile schema).
    const aiResponse = await callAI(
      provider,
      apiKey,
      [{ role: 'user', content: `Format: [TYPE]Company|Title|URL|Snippet\n\n${allResultsText}` }],
      systemPrompt,
      16000,
      provider === 'gemini' ? GEMINI_JOB_ARRAY_SCHEMA : undefined
    );

    if (aiResponse.error) {
      return res.status(500).json({ error: `AI error in Pass 2: ${aiResponse.error}` });
    }

    let jobs;
    try {
      const jsonStr = extractJSON(aiResponse.text);
      jobs = JSON.parse(jsonStr);
    } catch {
      try {
        jobs = JSON.parse(repairJson(aiResponse.text));
      } catch {
        return res.status(500).json({ error: `Failed to parse job results. Raw length: ${aiResponse.text.length}` });
      }
    }

    return res.status(200).json({ jobs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error in Pass 2';
    return res.status(500).json({ error: message });
  }
}
