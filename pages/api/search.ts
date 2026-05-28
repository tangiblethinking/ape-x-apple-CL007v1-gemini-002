import type { NextApiRequest, NextApiResponse } from 'next';

const VERIFIED_DOMAINS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workday.com',
  'myworkdayjobs.com',
  'icims.com',
  'jobvite.com',
  'smartrecruiters.com',
];

function extractTitles(instructions: string): string[] {
  const match = instructions.match(/TARGET TITLES:\s*(.+)/);
  if (!match) return [];
  const raw = match[1].trim();
  if (raw === '[Complete Setup Wizard to configure]') return [];
  const delimiter = raw.includes(' | ') ? ' | ' : ',';
  return raw.split(delimiter).map(t => t.trim()).filter(Boolean);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { instructions, serperKeyOverride } = req.body;
  const serperKey = serperKeyOverride || process.env.SERPER_API_KEY;

  if (!serperKey) return res.status(400).json({ error: 'No Serper API key configured. Add it in Settings.' });

  const titles = extractTitles(instructions || '');
  if (!titles.length) return res.status(400).json({ error: 'No target titles found. Complete the Setup Wizard first.' });

  const query = titles.join(' OR ');

  try {
    // Job bot pattern: one parallel Serper request per verified ATS domain
    const results = await Promise.all(
      VERIFIED_DOMAINS.map(async (domain) => {
        try {
          const r = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: `${query} site:${domain}`, num: 5 }),
          });
          if (!r.ok) return [];
          const data = await r.json();
          return (data.organic || []).map((result: { title: string; link: string; snippet?: string }) => ({
            title: result.title,
            link: result.link,
            snippet: result.snippet || '',
            source: (() => {
              try {
                const hostname = new URL(result.link).hostname;
                return hostname.replace('boards.', '').replace('jobs.', '');
              } catch {
                return domain;
              }
            })(),
          }));
        } catch {
          return [];
        }
      })
    );

    // Flatten and deduplicate by link
    const seen = new Set<string>();
    const jobs = results.flat().filter((job) => {
      if (seen.has(job.link)) return false;
      seen.add(job.link);
      return true;
    });

    return res.status(200).json({ jobs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return res.status(500).json({ error: message });
  }
}
