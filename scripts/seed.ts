import { seedDatabase } from "../src/lib/db/seed";

async function main() {
  try {
    await seedDatabase();
    console.log("🌱 Database seeding complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

main();
