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

function parseSitemap(xml: string): SitemapEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: SitemapEntry[] = [];

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

  return entries;
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

  let xml = "";
  let usedUrl = "";

  for (const url of sitemapUrls) {
    console.log(`[sitemap] Trying: ${url}`);
    try {
      xml = await fetchWithRetry(url);
      usedUrl = url;
      console.log(`[sitemap] Found sitemap at: ${url}`);
      break;
    } catch (err) {
      console.log(
        `[sitemap] Failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!xml) {
    console.error("[sitemap] Could not fetch any sitemap");
    process.exit(1);
  }

  console.log("[sitemap] Parsing entries...");
  const entries = parseSitemap(xml);

  console.log(`[sitemap] Found ${entries.length} product URLs`);

  const byType = { template: 0, component: 0, plugin: 0 };
  for (const e of entries) byType[e.type]++;
  console.log(`[sitemap]   Templates:  ${byType.template}`);
  console.log(`[sitemap]   Components: ${byType.component}`);
  console.log(`[sitemap]   Plugins:    ${byType.plugin}`);

  if (entries.length === 0) {
    console.error(
      "[sitemap] No entries found - sitemap structure may have changed",
    );
    console.log("[sitemap] Raw XML length:", xml.length);
    console.log("[sitemap] First 500 chars:", xml.substring(0, 500));
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
      console.error(
        `[sitemap] Error inserting batch ${i / BATCH_SIZE}:`,
        error.message,
      );
    } else {
      totalInserted += batch.length;
    }

    console.log(
      `[sitemap] Inserted ${totalInserted}/${entries.length} entries`,
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
