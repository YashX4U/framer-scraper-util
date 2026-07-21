import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
  const patterns = [
    /\{"slug":"([^"]+)","name":"([^"]+)"\}/g,
    /\{"name":"([^"]+)","slug":"([^"]+)"\}/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(rscData)) !== null) {
      const slug = pattern === patterns[0] ? match[1] : match[2];
      const name = pattern === patterns[0] ? match[2] : match[1];
      if (
        !seen.has(slug) &&
        slug &&
        name &&
        !slug.startsWith("http") &&
        slug !== "all"
      ) {
        seen.add(slug);
        cats.push({ slug, name });
      }
    }
  }
  return cats;
}

async function discoverCategories() {
  console.log("=".repeat(50));
  console.log("[discover] CATEGORY DISCOVERY");
  console.log("=".repeat(50));

  const pages = [
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

  for (const { url, type } of pages) {
    console.log(`\n[discover] Fetching ${type}s: ${url}`);
    try {
      const html = await fetchWithRetry(url);
      const rscData = extractRscData(html);
      const categories = extractCategoriesFromRsc(rscData);

      console.log(
        `[discover] Found ${categories.length} sub-categories for ${type}s`,
      );

      const rows = categories.map((cat) => ({
        slug: cat.slug,
        name: cat.name,
        marketplace_type: type,
      }));
      if (rows.length > 0) {
        const { error } = await db
          .from("categories")
          .upsert(rows, { onConflict: "slug,marketplace_type" });

        if (error) {
          // Fallback if composite constraint missing: check and insert missing categories
          console.log(`[discover] Upsert failed (${error.message}), fallback inserting individually...`);
          for (const cat of categories) {
            const { data: existing } = await db
              .from("categories")
              .select("id")
              .eq("slug", cat.slug)
              .eq("marketplace_type", type)
              .maybeSingle();

            if (!existing) {
              await db.from("categories").insert({
                slug: cat.slug,
                name: cat.name,
                marketplace_type: type,
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(
        `[discover] Failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // CRITICAL FIX: Force add the "All" categories so global ranks work
  console.log("\n[discover] Forcing 'All' global categories...");
  for (const type of ["template", "component", "plugin"]) {
    const { data: existing } = await db
      .from("categories")
      .select("id")
      .eq("slug", "all")
      .eq("marketplace_type", type)
      .maybeSingle();

    if (!existing) {
      await db.from("categories").insert({
        slug: "all",
        name: "All",
        marketplace_type: type,
      });
    }
  }

  const { count } = await db
    .from("categories")
    .select("*", { count: "exact", head: true });
  console.log(`\n[discover] COMPLETE! Total categories in DB: ${count}`);
}

discoverCategories();
