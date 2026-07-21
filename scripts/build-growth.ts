// scripts/build-growth.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function buildGrowth() {
  console.log("[growth] Building 7-day growth data...");

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Get all products with their current views
  const { data: products, error } = await db
    .from("products")
    .select("id, title, views");

  if (error || !products) {
    console.error("[growth] Error fetching products:", error?.message);
    return;
  }

  // Get snapshots from 7 days ago
  const { data: oldSnapshots } = await db
    .from("snapshots")
    .select("product_id, views, captured_at")
    .lt("captured_at", sevenDaysAgo.toISOString())
    .order("captured_at", { ascending: false });

  // Get the most recent snapshot for each product from 7+ days ago
  const oldViewsMap = new Map<string, number>();
  if (oldSnapshots) {
    for (const snap of oldSnapshots) {
      if (!oldViewsMap.has(snap.product_id)) {
        oldViewsMap.set(snap.product_id, snap.views);
      }
    }
  }

  // Build growth rows
  const growthRows: any[] = [];

  for (const product of products) {
    const viewsNow = product.views || 0;
    const views7dAgo = oldViewsMap.get(product.id) || 0;

    const growthPct =
      views7dAgo > 0
        ? Math.round(((viewsNow - views7dAgo) / views7dAgo) * 100 * 100) / 100
        : viewsNow > 0
          ? 100
          : 0;

    growthRows.push({
      id: product.id,
      title: product.title,
      views_now: viewsNow,
      views_7d_ago: views7dAgo || null,
      growth_pct_7d: growthPct,
    });
  }

  // Upsert to product_growth_7d
  if (growthRows.length > 0) {
    const { error: upsertError } = await db
      .from("product_growth_7d")
      .upsert(growthRows, { onConflict: "id" });

    if (upsertError) {
      console.error("[growth] Upsert error:", upsertError.message);
    } else {
      console.log(`[growth] Updated ${growthRows.length} products`);
    }
  }

  console.log("[growth] Complete!");
}

buildGrowth();
