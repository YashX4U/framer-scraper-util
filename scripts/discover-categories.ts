import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const MARKETPLACE_PAGES: { url: string; type: string }[] = [
  {
    url: "https://www.framer.com/community/marketplace/templates/all",
    type: "template",
  },
  {
    url: "https://www.framer.com/community/marketplace/components/all",
    type: "component",
  },
  {
    url: "https://www.framer.com/community/marketplace/plugins/all",
    type: "plugin",
  },
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];

function buildHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  };
}

async function fetchWithRetry(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        const wait = Math.min(5000 * (attempt + 1), 30000);
        console.log(`  [429] Rate limited, waiting ${wait}ms`);
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

function unescapeRsc(str: string): string {
  let r = str.replace(/\\\\/g, "\x00").replace(/\\"/g, "\x01");
  r = r.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  r = r.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return r.replace(/\x00/g, "\\").replace(/\x01/g, '"');
}

function extractRscData(html: string): string {
  const prefix = 'self.__next_f.push([1,"';
  const parts: string[] = [];
  let pos = 0;
  while (true) {
    const s = html.indexOf(prefix, pos);
    if (s === -1) break;
    const contentStart = s + prefix.length;
    let strEnd = -1;
    for (let i = contentStart; i < html.length; i++) {
      if (html[i] === "\\") {
        i++;
        continue;
      }
      if (html[i] === '"') {
        strEnd = i;
        break;
      }
    }
    if (strEnd === -1) break;
    parts.push(html.substring(contentStart, strEnd));
    pos = strEnd + 1;
  }
  return parts.map(unescapeRsc).join("");
}

interface Category {
  slug: string;
  name: string;
}

function extractCategoriesFromRsc(rscData: string): Category[] {
  const cats: Category[] = [];
  const seen = new Set<string>();

  // Look for category-like objects: {"slug":"...","name":"..."}
  const slugNamePattern = /\{"slug":"([^"]+)","name":"([^"]+)"\}/g;
  let match;
  while ((match = slugNamePattern.exec(rscData)) !== null) {
    const slug = match[1];
    const name = match[2];
    if (!seen.has(slug) && slug && name && !slug.startsWith("http")) {
      seen.add(slug);
      cats.push({ slug, name });
    }
  }

  // Also try reversed order: {"name":"...","slug":"..."}
  const nameSlugPattern = /\{"name":"([^"]+)","slug":"([^"]+)"\}/g;
  while ((match = nameSlugPattern.exec(rscData)) !== null) {
    const name = match[1];
    const slug = match[2];
    if (!seen.has(slug) && slug && name && !slug.startsWith("http")) {
      seen.add(slug);
      cats.push({ slug, name });
    }
  }

  return cats;
}

function extractCategoriesFromHtml(html: string): Category[] {
  const cats: Category[] = [];
  const seen = new Set<string>();

  // Match category links: /community/marketplace/{type}s/categories/{slug}/
  const linkPattern =
    /\/community\/marketplace\/\w+s\/categories\/([a-z0-9-]+)\//g;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const slug = match[1];
    if (!seen.has(slug)) {
      seen.add(slug);
      // Convert slug to name: "my-category" → "My Category"
      const name = slug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      cats.push({ slug, name });
    }
  }

  return cats;
}

async function discoverCategories() {
  console.log("=".repeat(50));
  console.log("[discover] CATEGORY DISCOVERY");
  console.log("=".repeat(50));

  let totalInserted = 0;

  for (const { url, type } of MARKETPLACE_PAGES) {
    console.log(`\n[discover] Fetching ${type}s: ${url}`);

    try {
      const html = await fetchWithRetry(url);
      const rscData = extractRscData(html);

      // Try RSC extraction first, fall back to HTML parsing
      let categories = extractCategoriesFromRsc(rscData);
      if (categories.length === 0) {
        categories = extractCategoriesFromHtml(html);
      }

      console.log(
        `[discover] Found ${categories.length} categories for ${type}s`,
      );

      if (categories.length === 0) {
        console.log(
          `[discover] WARNING: No categories found. Page structure may have changed.`,
        );
        console.log(
          `[discover] RSC data length: ${rscData.length}, HTML length: ${html.length}`,
        );
        continue;
      }

      // Upsert all categories for this marketplace type
      const rows = categories.map((cat) => ({
        slug: cat.slug,
        name: cat.name,
        marketplace_type: type,
      }));

      const { error } = await db.from("categories").upsert(rows, {
        onConflict: "slug,marketplace_type",
      });

      if (error) {
        console.error(`[discover] DB error for ${type}s: ${error.message}`);
      } else {
        totalInserted += categories.length;
        for (const cat of categories) {
          console.log(`  + ${cat.name} (${cat.slug})`);
        }
      }
    } catch (err) {
      console.error(
        `[discover] Failed to fetch ${type}s: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Small delay between pages
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Summary
  const { count } = await db
    .from("categories")
    .select("*", { count: "exact", head: true });

  console.log("\n" + "=".repeat(50));
  console.log(`[discover] COMPLETE! Total categories in DB: ${count}`);
  console.log("=".repeat(50));
}

discoverCategories();
