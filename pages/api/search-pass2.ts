import type { NextApiRequest, NextApiResponse } from 'next';
import { callAI, extractJSON, AIProvider, GEMINI_JOB_ARRAY_SCHEMA } from '../../lib/ai-providers';
import { getClaudeSearchPrompt } from '../../lib/claude-instructions';

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

// ── Gemini-only: build a clean bounded prompt from raw search results ──────
// Does NOT send userInstructions to Gemini. Gemini cannot fetch URLs and
// fails the Layer 1/2 audit protocol written for Claude. Instead give Gemini
// only: titles, a brief profile line, and the output schema via GEMINI_JOB_ARRAY_SCHEMA.
// This mirrors exactly what makes the job bot's Gemini calls succeed.
function buildGeminiPrompt(
  titlesSearched: string[],
  instructions: string,
  today: string
): string {
  // Extract candidate name and most recent role from instructions for context
  const nameMatch = instructions.match(/for\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
  const roleMatch = instructions.match(/MOST RECENT ROLE:\s*(.+)/);
  const salaryMatch = instructions.match(/SALARY TARGET:\s*(.+)/);

  const candidateLine = [
    nameMatch ? `Candidate: ${nameMatch[1]}` : '',
    roleMatch ? `Most recent role: ${roleMatch[1].trim()}` : '',
    salaryMatch ? `Salary target: ${salaryMatch[1].trim()}` : '',
  ].filter(Boolean).join(' | ');

  const titlesLine = titlesSearched.length > 0
    ? titlesSearched.join(', ')
    : 'roles matching the candidate profile';

  return `You are a job search assistant. Today is ${today}.

TARGET TITLES: ${titlesLine}
${candidateLine}

TASK: Evaluate each job search result below and return a JSON array of job card objects.

INPUT FORMAT: Each line is prefixed [ATS], [AGG-V], or [AGG-U] followed by Company|Title|URL|Snippet.

RULES:
1. INCLUDE the job if the title matches or is a close variant of the TARGET TITLES above.
2. INCLUDE the job if location is unspecified, remote, or hybrid — treat unspecified as remote-eligible.
3. EXCLUDE only if the title is clearly unrelated, or the posting is obviously not a real job (press release, generic careers page with no specific role).
4. Assign rating: 9-10 near-perfect title match | 7-8 strong variant | 5-6 adjacent role | below 5 exclude.
5. Set isRemote/isHybrid/isOnsite based on snippet content. Default isRemote=true when unspecified.

auditLabel values:
- [ATS] → "✓ Direct ATS Verified ${today}"
- [AGG-V] → "✓ Company Domain Verified ${today}"
- [AGG-U] → "✓ Aggregator Listed ${today}"

Output ONLY the JSON array. No markdown. No explanation.`;
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

  // ── FIX 1: Parallel aggregator verification, capped at 10 ──────────────
  // Was: sequential for-loop over all aggregators (~47 × ~800ms = ~38s → timeout)
  // Now: Promise.all over top 10 → ~3s total
  const AGGREGATOR_DOMAINS = [
    'linkedin.com', 'indeed.com', 'ziprecruiter.com', 'glassdoor.com',
    'monster.com', 'careerbuilder.com', 'dice.com', 'builtin.com',
    'simplyhired.com', 'snagajob.com', 'flexjobs.com', 'talent.com', 'google.com',
  ];

  const aggregatorsCapped = (aggregators as AggregatorResult[])
    .filter(a => a.company && a.company !== 'Unknown')
    .slice(0, 10);

  const verifiedAggregators: VerifiedAggregator[] = await Promise.all(
    aggregatorsCapped.map(async (agg) => {
      try {
        const verifyQuery = `"${agg.title}" "${agg.company}" careers apply job`;
        const serperRes = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: verifyQuery, num: 5 }),
        });
        if (!serperRes.ok) return { ...agg, verified: false };
        const data = await serperRes.json();
        const results = (data.organic || []) as { link: string; title: string }[];
        const companyResult = results.find(r => {
          try { return !AGGREGATOR_DOMAINS.some(d => new URL(r.link).hostname.toLowerCase().includes(d)); }
          catch { return false; }
        });
        return companyResult
          ? { ...agg, verified: true, verified_url: companyResult.link }
          : { ...agg, verified: false };
      } catch {
        return { ...agg, verified: false };
      }
    })
  );
  // ────────────────────────────────────────────────────────────────────────

  const trustedText = (trusted as TrustedResult[]).map(r =>
    `[ATS]${r.company}|${r.title}|${r.url}|${r.snippet}`).join('\n');
  const verifiedAggText = verifiedAggregators.filter(r => r.verified).map(r =>
    `[AGG-V]${r.company}|${r.title}|${r.verified_url}|${r.snippet}`).join('\n');
  const unverifiedAggText = verifiedAggregators.filter(r => !r.verified).map(r =>
    `[AGG-U]${r.company}|${r.title}|${r.aggregator_url}|${r.snippet}`).join('\n');
  const allResultsText = [trustedText, verifiedAggText, unverifiedAggText].filter(Boolean).join('\n');

  const finalInstructions = specialInstructions
    ? `${instructions}\n\nSPECIAL:\n${specialInstructions}` : instructions;

  // ── FIX 2: Gemini gets a clean bounded prompt, not the full userInstructions ──
  // Claude gets the full instructions as before (unchanged, working).
  // Gemini gets only titles + profile line + simple include/exclude rules.
  // This mirrors the job bot pattern: Gemini never sees Layer 1/2 fetch-audit logic.
  const systemPrompt = provider === 'gemini'
    ? buildGeminiPrompt(titlesSearched || [], instructions, today)
    : getClaudeSearchPrompt(finalInstructions, specialInstructions || null, titlesSearched || [], today);

  try {
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
