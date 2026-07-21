import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const BATCH_INDEX = parseInt(process.env.BATCH_INDEX || "0", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "100", 10);
const DELAY_MIN = parseInt(process.env.DELAY_MIN || "150", 10);
const DELAY_MAX = parseInt(process.env.DELAY_MAX || "400", 10);
const MARKETPLACE_TYPE = process.env.MARKETPLACE_TYPE || null;
const RUN_MODE = process.env.RUN_MODE || "both";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildHeaders(): Record<string, string> {
  const ua = randomUA();
  return {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    DNT: "1",
  };
}

let requestCount = 0;
function randomDelay(): Promise<void> {
  requestCount++;
  let delay: number;

  // First 5 requests: act cautious (500ms - 1200ms) to pass initial bot checks
  if (requestCount <= 5) {
    delay = 500 + Math.random() * 700;
  }
  // After that: drop to fast burner mode (150ms - 400ms)
  else {
    delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
  }

  return new Promise((r) => setTimeout(r, delay));
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

interface ProductData {
  id: string;
  title: string;
  slug: string;
  type: string;
  introduction?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  author?: {
    name: string;
    slug?: string;
    avatar?: string;
    image?: string;
    profileImage?: string;
    picture?: string;
    photo?: string;
  };
  attributes?: {
    price?: string | null;
    paid?: boolean;
    categories?: { id: number | string; name: string; slug: string }[];
  };
  post?: {
    likes?: { count: number };
    comments?: { count: number };
  };
  media?: { url: string }[];
}

function extractProductFromRsc(rscData: string): ProductData | null {
  const patterns = ['{"id":"', '{"resolved":true,"id":"'];

  for (const pattern of patterns) {
    let searchAt = 0;

    while (true) {
      const start = rscData.indexOf(pattern, searchAt);
      if (start === -1) break;

      const snippet = rscData.substring(start, start + 500);
      if (!snippet.includes('"title":"')) {
        searchAt = start + 1;
        continue;
      }

      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;

      for (let i = start; i < rscData.length; i++) {
        const ch = rscData[i];
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === "\\") {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (!inStr) {
          if (ch === "{") depth++;
          if (ch === "}") {
            depth--;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
      }

      if (end === -1) break;

      const objStr = rscData.substring(start, end).replace(/"\$\d+"/g, "null");

      try {
        const obj = JSON.parse(objStr) as ProductData;
        if (obj.id && obj.title && obj.type) {
          return obj;
        }
      } catch {
        // Not valid JSON, try next match
      }

      searchAt = end;
    }
  }

  return null;
}

function extractProductsListFromRsc(
  rscData: string,
): { id: string; title: string }[] {
  const products: { id: string; title: string }[] = [];
  const seenIds = new Set<string>();

  // Strategy 1: Find the "items":[...] array Framer uses on listing pages.
  // This gives items in the EXACT order shown on the page.
  // We use bracket matching instead of regex to handle large arrays safely.
  const itemsKey = '"items":[';
  let keyPos = 0;
  while (keyPos < rscData.length) {
    const ki = rscData.indexOf(itemsKey, keyPos);
    if (ki === -1) break;
    const arrStart = ki + '"items":'.length; // position of '['
    // Bracket-match to find the end of this array
    let depth = 0;
    let inStr = false;
    let esc = false;
    let arrEnd = -1;
    for (let i = arrStart; i < rscData.length; i++) {
      const ch = rscData[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === "[" || ch === "{") depth++;
        if (ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) { arrEnd = i + 1; break; }
        }
      }
    }
    if (arrEnd !== -1) {
      const rawArr = rscData.substring(arrStart, arrEnd);
      // Only attempt parse if it looks like it contains product objects
      if (rawArr.includes('"slug"') && rawArr.includes('"title"')) {
        try {
          const cleaned = rawArr.replace(/"?\$\d+"?/g, "null");
          const arr = JSON.parse(cleaned);
          if (Array.isArray(arr) && arr.length > 0) {
            for (const item of arr) {
              const id = item?.id;
              const title = item?.title || item?.name || item?.node?.title;
              if (id && title && !seenIds.has(id)) {
                seenIds.add(id);
                products.push({ id, title });
              }
            }
            if (products.length > 0) {
              return products;
            }
          }
        } catch {
          // fall through to strategy 2
        }
      }
      keyPos = arrEnd;
    } else {
      keyPos = ki + 1;
    }
  }

  // Strategy 2: Scan for individual product objects. A Framer product on a listing page
  // always has BOTH "id" (UUID) AND "slug" fields. This filters out nav items, categories,
  // and author objects which only have id+name but no slug.
  let searchAt = 0;
  while (true) {
    const start = rscData.indexOf('{"id":"', searchAt);
    if (start === -1) break;

    // Walk the full object boundaries
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < rscData.length; i++) {
      const ch = rscData[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
    }
    if (end === -1) break;

    const objStr = rscData.substring(start, end).replace(/"?\$\d+"?/g, "null");
    try {
      const obj = JSON.parse(objStr);
      const id = obj.id;
      // MUST have both id AND slug to be a product (not a category/nav/author object)
      const slug = obj.slug;
      const title = obj.title || obj.name || obj.node?.title || obj.node?.name;

      if (id && slug && title && !seenIds.has(id)) {
        seenIds.add(id);
        products.push({ id, title });
      }
    } catch {
      // skip malformed JSON
    }
    searchAt = end;
  }

  return products;
}

async function fetchWithRetry(url: string, retries = 2): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 429) {
        const wait = Math.min(8000 * (attempt + 1), 45000);
        console.log(`    [429] Rate limited, waiting ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (res.status === 404) {
        throw new Error("404 Not Found");
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

async function scrapeProductPage(
  url: string,
  expectedType: string,
): Promise<{
  id: string;
  title: string;
  creator: string;
  creator_url: string;
  creator_avatar: string;
  category: string;
  is_free: boolean;
  thumbnail: string;
  description: string;
  published_at: string | null;
  price: number;
  likes: number;
  comments_count: number;
  updated_at: string | null;
  raw_categories: { slug: string; name: string }[];
}> {
  const html = await fetchWithRetry(url);
  const rscData = extractRscData(html);

  if (!rscData) {
    throw new Error("No RSC data found");
  }

  const product = extractProductFromRsc(rscData);
  if (!product) {
    throw new Error("Could not extract product data");
  }

  if (product.type !== expectedType) {
    throw new Error(
      `Type mismatch: expected ${expectedType}, got ${product.type}`,
    );
  }

  const price = product.attributes?.price;
  const isFree = !price || price === "Free" || price === "0" || price === null;
  const numPrice =
    price && price !== "Free"
      ? parseFloat(price.replace(/[^0-9.]/g, "")) || 0
      : 0;
  const isPluginPaid = product.attributes?.paid === true;

  const authorSlug = product.author?.slug;
  const creatorUrl = authorSlug
    ? `https://www.framer.com/community/creator/@${authorSlug}/`
    : "";

  const cats = product.attributes?.categories || [];

  return {
    id: product.id,
    title: product.title,
    creator: product.author?.name || "Unknown",
    creator_url: creatorUrl,
    creator_avatar:
      product.author?.avatar ||
      product.author?.image ||
      product.author?.profileImage ||
      product.author?.picture ||
      product.author?.photo ||
      "",
    category:
      cats
        .map((c) => c.name)
        .filter(Boolean)
        .join(", ") || "",
    is_free: expectedType === "plugin" ? !isPluginPaid : isFree,
    thumbnail: product.media?.[0]?.url || "",
    description: product.introduction || "",
    published_at: product.publishedAt || product.createdAt || null,
    price: expectedType === "plugin" ? 0 : numPrice,
    likes: product.post?.likes?.count || 0,
    comments_count: product.post?.comments?.count || 0,
    updated_at: product.updatedAt || null,
    raw_categories: cats.map((c) => ({ slug: c.slug, name: c.name })),
  };
}

async function upsertProductCategories(
  productId: string,
  marketplaceType: string,
  categories: { slug: string; name: string }[],
) {
  if (categories.length === 0) return;

  for (const cat of categories) {
    const { data: existing } = await db
      .from("categories")
      .select("id")
      .eq("slug", cat.slug)
      .eq("marketplace_type", marketplaceType)
      .maybeSingle();

    let categoryId: number;
    if (existing) {
      categoryId = existing.id;
    } else {
      const { data: inserted } = await db
        .from("categories")
        .insert({
          slug: cat.slug,
          name: cat.name,
          marketplace_type: marketplaceType,
        })
        .select("id")
        .single();
      if (!inserted) throw new Error("Failed to insert category");
      categoryId = inserted.id;
    }

    await db
      .from("product_categories")
      .upsert(
        { product_id: productId, category_id: categoryId },
        { onConflict: "product_id,category_id" },
      );
  }
}

async function scrapeCategoryRanks() {
  const { data: categories, error } = await db
    .from("categories")
    .select("*")
    .order("marketplace_type")
    .order("slug");
  if (error || !categories || categories.length === 0) {
    console.error(
      "[cats] Failed to fetch categories or none found:",
      error?.message,
    );
    return;
  }

  console.log(
    `[cats] Scraping EXACT sequence for ${categories.length} categories`,
  );

  let totalSnapshots = 0;
  let catErrors = 0;

  for (const cat of categories) {
    try {
      const type = cat.marketplace_type;
      const pluralType = type + "s";

      // FIX: Build correct URL for "all" vs sub-categories
      const url =
        cat.slug === "all"
          ? `https://www.framer.com/community/marketplace/${pluralType}/all/`
          : `https://www.framer.com/community/marketplace/${pluralType}/categories/${cat.slug}/`;

      console.log(`[cats] ${cat.name} (${type}) -> ${url}`);

      let pageUrl: string | null = url;
      let position = 0;
      let pageNum = 0;
      const allRowsForCategory: { product_id: string; position: number }[] = [];
      const snapDate = new Date().toISOString().split("T")[0];
      const capturedAt = new Date().toISOString();

      while (pageUrl) {
        pageNum++;
        const html = await fetchWithRetry(pageUrl);
        const rscData = extractRscData(html);
        const products = extractProductsListFromRsc(rscData);

        if (products.length === 0) {
          console.log(`  page ${pageNum}: empty, stopping.`);
          break;
        }

        for (let i = 0; i < products.length; i++) {
          allRowsForCategory.push({
            product_id: products[i].id,
            position: position + i + 1,
          });
        }

        position += products.length;

        const cursorMatch = rscData.match(/"cursor":"([^"]+)"/);
        if (cursorMatch) {
          pageUrl = `${url}?cursor=${encodeURIComponent(cursorMatch[1])}`;
          console.log(
            `  page ${pageNum}: ${products.length} items, cursor found, fetching next`,
          );
          await randomDelay();
        } else {
          console.log(
            `  page ${pageNum}: ${products.length} items, no more pages`,
          );
          pageUrl = null;
        }
      }

      console.log(`  Total scraped from Framer: ${allRowsForCategory.length} items`);

      if (allRowsForCategory.length > 0) {
        // CRITICAL: Only insert snapshots for product_ids that exist in the products table.
        // This avoids FK violations. Products scraped by the parallel batch jobs are in the
        // products table; any IDs missing here are from items not yet scraped.
        const allIds = allRowsForCategory.map((r) => r.product_id);

        // Check in chunks of 500 to avoid URL length limits
        const existingIds = new Set<string>();
        for (let ci = 0; ci < allIds.length; ci += 500) {
          const chunk = allIds.slice(ci, ci + 500);
          const { data: existing } = await db
            .from("products")
            .select("id")
            .in("id", chunk);
          if (existing) {
            for (const row of existing) existingIds.add(row.id);
          }
        }

        const validRows = allRowsForCategory
          .filter((r) => existingIds.has(r.product_id))
          .map((r) => ({
            product_id: r.product_id,
            category_id: cat.id,
            position: r.position,
            captured_at: capturedAt,
            snap_date: snapDate,
          }));

        const missing = allRowsForCategory.length - validRows.length;
        if (missing > 0) {
          console.log(`  WARNING: ${missing} items not yet in products table (still being scraped by other jobs), skipping their snapshots`);
        }

        if (validRows.length > 0) {
          // Delete old snapshots for this category+date first, then insert fresh ones
          // This ensures we always have the correct order (no stale duplicates)
          await db
            .from("category_snapshots")
            .delete()
            .eq("category_id", cat.id)
            .eq("snap_date", snapDate);

          const CHUNK = 500;
          let inserted = 0;
          for (let ci = 0; ci < validRows.length; ci += CHUNK) {
            const chunk = validRows.slice(ci, ci + CHUNK);
            const { error: ie } = await db
              .from("category_snapshots")
              .insert(chunk);
            if (ie) {
              console.error(`  DB insert error (chunk ${ci}): ${ie.message}`);
            } else {
              inserted += chunk.length;
            }
          }
          totalSnapshots += inserted;
          console.log(`  Inserted ${inserted} / ${allRowsForCategory.length} snapshots (${missing} skipped, not yet in products table)`);
        }
      }

      await randomDelay();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cats] FAILED ${cat.slug}: ${msg}`);
      catErrors++;
    }
  }

  console.log(
    `[cats] Done: ${totalSnapshots} snapshots across ${categories.length} categories (${catErrors} errors)`,
  );
}

async function runProductScrapes() {
  let query = db
    .from("pending_scrapes")
    .select("*")
    .is("scraped_at", null)
    .order("id");

  if (MARKETPLACE_TYPE) {
    query = query.eq("marketplace_type", MARKETPLACE_TYPE);
  }

  let countQuery = db
    .from("pending_scrapes")
    .select("*", { count: "exact", head: true })
    .is("scraped_at", null);

  if (MARKETPLACE_TYPE) {
    countQuery = countQuery.eq("marketplace_type", MARKETPLACE_TYPE);
  }

  const { count: totalCount } = await countQuery;

  const offset = BATCH_INDEX * BATCH_SIZE;
  const { data: entries, error } = await query.range(
    offset,
    offset + BATCH_SIZE - 1,
  );

  if (error) {
    console.error("[batch] Query error:", error.message);
    process.exit(1);
  }

  if (!entries || entries.length === 0) {
    console.log("[batch] No entries to process in this batch");
    return;
  }

  console.log(
    `[batch] Processing ${entries.length} products (offset: ${offset})`,
  );
  console.log("");

  let success = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const progress = `[${i + 1}/${entries.length}]`;

    try {
      if (i > 0) {
        await randomDelay();
      }

      const productData = await scrapeProductPage(
        entry.url,
        entry.marketplace_type,
      );

      if (productData.raw_categories.length > 0) {
        await upsertProductCategories(
          productData.id,
          entry.marketplace_type,
          productData.raw_categories,
        );
      }

      const { error: upsertError } = await db.from("products").upsert(
        {
          id: productData.id,
          title: productData.title,
          creator: productData.creator,
          creator_url: productData.creator_url,
          creator_avatar: productData.creator_avatar,
          url: entry.url,
          category: productData.category,
          marketplace_type: entry.marketplace_type,
          is_free: productData.is_free,
          thumbnail: productData.thumbnail,
          description: productData.description,
          published_at: productData.published_at,
        },
        { onConflict: "id" },
      );

      if (upsertError) {
        throw new Error(`Upsert failed: ${upsertError.message}`);
      }

      const { error: snapError } = await db.from("snapshots").insert({
        product_id: productData.id,
        price: productData.price,
        views: 0,
        impressions: 0,
        unique_visitors: 0,
        likes: productData.likes,
        comments_count: productData.comments_count,
        position: 0,
        updated_at: productData.updated_at,
      });

      if (snapError) {
        console.error(
          `    ${progress} Snapshot error (product saved): ${snapError.message}`,
        );
      }

      await db
        .from("pending_scrapes")
        .update({ scraped_at: new Date().toISOString() })
        .eq("id", entry.id);

      success++;

      if (success % 10 === 0 || i === entries.length - 1) {
        console.log(`    ${progress} done: ${success} ok, ${failed} failed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed++;

      if (msg.includes("404")) {
        await db
          .from("pending_scrapes")
          .update({ scraped_at: new Date().toISOString() })
          .eq("id", entry.id);
        skipped++;
      } else {
        errors.push(`${entry.slug}: ${msg}`);
      }

      if (errors.length <= 5 || failed % 10 === 0) {
        console.log(`    ${progress} FAILED ${entry.slug}: ${msg}`);
      }
    }
  }

  console.log("");
  console.log("=".repeat(50));
  console.log(`[batch] PRODUCT SCRAPE COMPLETE`);
  console.log(`[batch]   Success: ${success}`);
  console.log(`[batch]   Failed:  ${failed} (404s skipped: ${skipped})`);
  console.log(`[batch]   Total:   ${entries.length}`);

  if (errors.length > 0 && errors.length <= 10) {
    console.log("[batch] Errors:");
    errors.forEach((e) => console.log(`  - ${e}`));
  }
  console.log("=".repeat(50));

  if (failed > entries.length * 0.5) {
    process.exit(1);
  }
}

async function main() {
  console.log("=".repeat(50));
  console.log(`[batch] BATCH SCRAPER #${BATCH_INDEX}`);
  console.log(
    `[batch] Size: ${BATCH_SIZE}, Delay: ${DELAY_MIN}-${DELAY_MAX}ms`,
  );
  console.log(`[batch] Mode: ${RUN_MODE}`);
  if (MARKETPLACE_TYPE) console.log(`[batch] Type filter: ${MARKETPLACE_TYPE}`);
  console.log("=".repeat(50));

  if (RUN_MODE === "products" || RUN_MODE === "both") {
    await runProductScrapes();
  }

  if (RUN_MODE === "categories" || RUN_MODE === "both") {
    console.log("\n");
    await scrapeCategoryRanks();
  }

  console.log("");
  console.log("=".repeat(50));
  console.log(`[batch] ALL DONE`);
  console.log("=".repeat(50));
}

main();
