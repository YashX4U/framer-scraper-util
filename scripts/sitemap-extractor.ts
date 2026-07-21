import "dotenv/config";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];

interface SitemapEntry {
  url: string;
  type: "template" | "component" | "plugin";
  slug: string;
}

async function fetchWithRetry(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          Accept: "application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429) {
        const wait = Math.min(5000 * (attempt + 1), 30000);
        console.log(`[sitemap] Rate limited, waiting ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

function parseSitemap(xml: string): { entries: SitemapEntry[]; childSitemaps: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: SitemapEntry[] = [];
  const childSitemaps: string[] = [];

  // Check for child sitemaps in sitemap index
  $("sitemap loc").each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) childSitemaps.push(loc);
  });

  $("url").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    if (!loc) return;

    if (
      loc.endsWith("/templates/") ||
      loc.endsWith("/components/") ||
      loc.endsWith("/plugins/")
    ) {
      return;
    }

    let type: SitemapEntry["type"] | null = null;
    let slug = "";

    if (loc.includes("/templates/")) {
      type = "template";
      const match = loc.match(/\/templates\/([^/]+)\/?$/);
      slug = match ? match[1] : "";
    } else if (loc.includes("/components/")) {
      type = "component";
      const match = loc.match(/\/components\/([^/]+)\/?$/);
      slug = match ? match[1] : "";
    } else if (loc.includes("/plugins/")) {
      type = "plugin";
      const match = loc.match(/\/plugins\/([^/]+)\/?$/);
      slug = match ? match[1] : "";
    }

    if (type && slug && !slug.includes("page")) {
      entries.push({ url: loc, type, slug });
    }
  });

  return { entries, childSitemaps };
}

async function main() {
  console.log("=".repeat(50));
  console.log("[sitemap] SITEMAP EXTRACTOR");
  console.log("=".repeat(50));

  const sitemapUrls = [
    "https://www.framer.com/marketplace/sitemap.xml",
    "https://www.framer.com/community/sitemap.xml",
    "https://www.framer.com/sitemap.xml",
  ];

  const allEntries: SitemapEntry[] = [];
  const visitedUrls = new Set<string>();
  const queue = [...sitemapUrls];

  while (queue.length > 0) {
    const targetUrl = queue.shift()!;
    if (visitedUrls.has(targetUrl)) continue;
    visitedUrls.add(targetUrl);

    console.log(`[sitemap] Trying: ${targetUrl}`);
    try {
      const xml = await fetchWithRetry(targetUrl);
      const { entries, childSitemaps } = parseSitemap(xml);
      console.log(`[sitemap] Found ${entries.length} product URLs in ${targetUrl}`);
      allEntries.push(...entries);

      for (const childUrl of childSitemaps) {
        if (!visitedUrls.has(childUrl)) {
          queue.push(childUrl);
        }
      }
    } catch (err) {
      console.log(
        `[sitemap] Failed ${targetUrl}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Deduplicate entries by URL
  const uniqueMap = new Map<string, SitemapEntry>();
  for (const e of allEntries) {
    uniqueMap.set(e.url, e);
  }
  const entries = Array.from(uniqueMap.values());

  console.log(`\n[sitemap] Total unique product URLs found: ${entries.length}`);

  const byType = { template: 0, component: 0, plugin: 0 };
  for (const e of entries) byType[e.type]++;
  console.log(`[sitemap]   Templates:  ${byType.template}`);
  console.log(`[sitemap]   Components: ${byType.component}`);
  console.log(`[sitemap]   Plugins:    ${byType.plugin}`);

  if (entries.length === 0) {
    console.error(
      "[sitemap] No entries found - sitemap structure may have changed",
    );
    process.exit(1);
  }

  const BATCH_SIZE = 500;
  let totalInserted = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    const { error } = await db.from("pending_scrapes").upsert(
      batch.map((e) => ({
        url: e.url,
        slug: e.slug,
        marketplace_type: e.type,
        scraped_at: null,
      })),
      { onConflict: "url" },
    );

    if (error) {
      // Fallback: If upsert failed due to missing ON CONFLICT constraint, insert missing rows one by one or in batch
      console.log(`[sitemap] Upsert failed (${error.message}), trying fallback insert...`);
      for (const item of batch) {
        const { data: existing } = await db
          .from("pending_scrapes")
          .select("id")
          .eq("url", item.url)
          .maybeSingle();

        if (!existing) {
          await db.from("pending_scrapes").insert({
            url: item.url,
            slug: item.slug,
            marketplace_type: item.type,
            scraped_at: null,
          });
        }
      }
      totalInserted += batch.length;
    } else {
      totalInserted += batch.length;
    }

    console.log(
      `[sitemap] Processed ${totalInserted}/${entries.length} entries`,
    );
  }

  const { count } = await db
    .from("pending_scrapes")
    .select("*", { count: "exact", head: true });

  console.log("\n" + "=".repeat(50));
  console.log(`[sitemap] COMPLETE! Total URLs in DB: ${count}`);
  console.log("[sitemap] Now run batch-scraper.ts to fetch product data");
  console.log("=".repeat(50));
}

main();
