// scripts/build-rankings.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function buildRankings() {
  console.log("[rankings] Building product rankings...");

  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  // Get today's category snapshots with product info
  const { data: todaySnapshots, error } = await db
    .from("category_snapshots")
    .select(
      `
      product_id,
      category_id,
      position,
      categories!inner(name, slug, marketplace_type),
      products!inner(
        id, title, thumbnail, url, creator, creator_url, creator_avatar,
        category, marketplace_type, is_free, published_at, first_seen_at,
        likes, comments_count, price
      )
    `,
    )
    .eq("snap_date", today);

  if (error) {
    console.error("[rankings] Error:", error.message);
    return;
  }

  if (!todaySnapshots || todaySnapshots.length === 0) {
    console.log("[rankings] No snapshots for today");
    return;
  }

  // Get yesterday's positions for rank changes
  const { data: yesterdaySnapshots } = await db
    .from("category_snapshots")
    .select("product_id, category_id, position")
    .eq("snap_date", yesterday);

  const yesterdayMap = new Map<string, number>();
  if (yesterdaySnapshots) {
    for (const snap of yesterdaySnapshots) {
      yesterdayMap.set(`${snap.product_id}_${snap.category_id}`, snap.position);
    }
  }

  // Get historical best/worst ranks for each product
  const { data: historicalRanks } = await db
    .from("category_snapshots")
    .select("product_id, category_id, position");

  const bestRankMap = new Map<string, number>();
  const worstRankMap = new Map<string, number>();
  const firstPositionMap = new Map<string, number>();

  if (historicalRanks) {
    for (const snap of historicalRanks) {
      const key = `${snap.product_id}_${snap.category_id}`;

      if (!bestRankMap.has(key) || snap.position < bestRankMap.get(key)!) {
        bestRankMap.set(key, snap.position);
      }
      if (!worstRankMap.has(key) || snap.position > worstRankMap.get(key)!) {
        worstRankMap.set(key, snap.position);
      }
      if (!firstPositionMap.has(key)) {
        firstPositionMap.set(key, snap.position);
      }
    }
  }

  // Get 7d ago likes/comments
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  const { data: oldSnapshots } = await db
    .from("snapshots")
    .select("product_id, likes, comments_count")
    .lt("captured_at", sevenDaysAgo.toISOString())
    .order("captured_at", { ascending: false });

  const oldDataMap = new Map<string, { likes: number; comments: number }>();
  if (oldSnapshots) {
    for (const snap of oldSnapshots) {
      if (!oldDataMap.has(snap.product_id)) {
        oldDataMap.set(snap.product_id, {
          likes: snap.likes,
          comments: snap.comments_count,
        });
      }
    }
  }

  // Build ranking rows
  const rankings: any[] = [];
  const seen = new Set<string>();

  for (const snap of todaySnapshots) {
    const key = `${snap.product_id}_${snap.category_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const prevPos = yesterdayMap.get(key) || null;
    const rankChange = prevPos ? prevPos - snap.position : 0;
    const bestRank = bestRankMap.get(key) || snap.position;
    const worstRank = worstRankMap.get(key) || snap.position;
    const firstPos = firstPositionMap.get(key) || snap.position;
    const oldData = oldDataMap.get(snap.product_id);

    const product = snap.products as any;
    const category = snap.categories as any;

    rankings.push({
      id: `${snap.product_id}_${snap.category_id}`,
      product_id: snap.product_id,
      title: product.title,
      thumbnail: product.thumbnail,
      url: product.url,
      creator: product.creator,
      creator_url: product.creator_url,
      creator_avatar: product.creator_avatar,
      category: category.name,
      marketplace_type: category.marketplace_type,
      is_free: product.is_free,
      published_at: product.published_at,
      first_seen_at: product.first_seen_at,
      likes: product.likes,
      position: snap.position,
      comments_count: product.comments_count,
      price: product.price,
      views: 0,
      impressions: 0,
      prev_position: prevPos,
      rank_change: rankChange,
      best_rank: bestRank,
      worst_rank: worstRank,
      likes_7d_ago: oldData?.likes || null,
      comments_7d_ago: oldData?.comments || null,
      first_position: firstPos,
    });
  }

  // Upsert to product_rankings
  if (rankings.length > 0) {
    const { error: upsertError } = await db
      .from("product_rankings")
      .upsert(rankings, { onConflict: "id" });

    if (upsertError) {
      console.error("[rankings] Upsert error:", upsertError.message);
    } else {
      console.log(`[rankings] Updated ${rankings.length} rankings`);
    }
  }

  console.log("[rankings] Complete!");
}

buildRankings();
