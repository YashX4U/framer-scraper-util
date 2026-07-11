import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log("=".repeat(50));
  console.log("SCRAPE STATUS");
  console.log("=".repeat(50));

  const { count: totalProducts } = await db
    .from("products")
    .select("*", { count: "exact", head: true });
  console.log(`Products in DB: ${totalProducts}`);

  for (const type of ["template", "component", "plugin"]) {
    const { count } = await db
      .from("products")
      .select("*", { count: "exact", head: true })
      .eq("marketplace_type", type);
    console.log(`  ${type}s: ${count}`);
  }

  const { count: pendingTotal } = await db
    .from("pending_scrapes")
    .select("*", { count: "exact", head: true })
    .is("scraped_at", null);
  console.log(`\nPending scrapes: ${pendingTotal}`);

  for (const type of ["template", "component", "plugin"]) {
    const { count } = await db
      .from("pending_scrapes")
      .select("*", { count: "exact", head: true })
      .eq("marketplace_type", type)
      .is("scraped_at", null);
    console.log(`  ${type}s: ${count}`);
  }

  const { data: latestSnap } = await db
    .from("snapshots")
    .select("captured_at")
    .order("captured_at", { ascending: false })
    .limit(1);

  if (latestSnap && latestSnap[0]) {
    console.log(`\nLatest snapshot: ${latestSnap[0].captured_at}`);
  }

  console.log("=".repeat(50));
}

main();
