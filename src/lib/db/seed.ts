import { getDb, guides, users } from "./index";
import { getAuth } from "../auth";
import { migrateLocalDb } from "./migrate";
import { eq } from "drizzle-orm";

export async function seedDatabase() {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // Ignored if file doesn't exist
    }
  }

  console.log("🌱 Running local D1 migrations...");
  await migrateLocalDb();

  const db = await getDb();
  const auth = await getAuth();

  // 1. Seed initial admin from environment
  const adminEmail = process.env.ADMIN_INITIAL_EMAIL;
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
  const adminName = process.env.ADMIN_INITIAL_NAME || "Ahmed Awad";

  if (!adminEmail || !adminPassword) {
    console.log("ℹ️ ADMIN_INITIAL_EMAIL or ADMIN_INITIAL_PASSWORD not configured. Skipping admin creation.");
    return;
  }

  const existingUser = await db.select().from(users).where(eq(users.email, adminEmail)).get();

  if (!existingUser) {
    console.log(`👤 Creating initial admin account (${adminEmail}) via Better Auth...`);
    const newUser = await auth.api.signUpEmail({
      body: {
        email: adminEmail,
        password: adminPassword,
        name: adminName,
      },
    });

    if (newUser?.user?.id) {
      // Explicitly grant admin role (per Correction 1: normal users default to "user", staff is granted explicitly)
      await db.update(users).set({ role: "admin" }).where(eq(users.id, newUser.user.id));
      console.log(`✅ Admin role explicitly granted to ${adminEmail}`);
    }
  } else {
    if (existingUser.role !== "admin") {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, existingUser.id));
    }
    console.log(`ℹ️ Admin account already exists (${adminEmail})`);
  }

  // 2. Seed initial approved guide (Talent Acquisition Strategy)
  const existingGuide = await db.select().from(guides).where(eq(guides.slug, "talent-acquisition-strategy")).get();

  if (!existingGuide) {
    console.log("📖 Seeding approved baseline guide: Talent Acquisition Strategy Is Not a Hiring Plan...");
    const now = new Date();
    const blocks = [
      {
        id: "b-intro-1",
        type: "paragraph",
        text: "Most talent acquisition strategies start in the wrong place. They start with sourcing channels, recruitment technology, employer branding, KPIs, or a new ATS.",
      },
      {
        id: "b-intro-2",
        type: "paragraph",
        text: "Those things matter. But they are decisions you make **after** you understand the hiring problem. A real talent acquisition strategy starts with the business.",
      },
      {
        id: "b-quote-1",
        type: "blockquote",
        text: "The tool comes after the diagnosis.",
      },
      {
        id: "b-h2-1",
        type: "heading",
        level: 2,
        text: "Start with the hiring situation",
        anchor: "s1",
      },
      {
        id: "b-p-3",
        type: "paragraph",
        text: "Not every vacancy deserves the same recruitment approach. Hiring 50 customer service employees is a very different problem from finding a scarce cybersecurity specialist — and neither should be treated the same way as appointing an executive who will shape the direction of the business.",
      },
      {
        id: "b-p-4",
        type: "paragraph",
        text: "Yet many organisations still run all three through roughly the same process. Same workflow. Same sourcing channels. Same recruiter capacity. Same KPIs. That is where strategy begins to break down.",
      },
      {
        id: "b-p-5",
        type: "paragraph",
        text: "I look at the hiring portfolio through three simple dimensions:",
      },
      {
        id: "b-list-1",
        type: "list",
        style: "bullet",
        items: [
          "**Strategic relevance** — how much does this role influence the organisation's ability to deliver its strategy?",
          "**Talent availability** — how easy or difficult is the required talent to find in the market?",
          "**Hiring demand** — are we hiring one person occasionally, or dozens of people repeatedly?",
        ],
      },
      {
        id: "b-h2-2",
        type: "heading",
        level: 2,
        text: "Four different hiring problems",
        anchor: "s2",
      },
      {
        id: "b-p-6",
        type: "paragraph",
        text: "When you look at talent acquisition this way, the hiring portfolio separates into different situations: Simple Hiring, Difficult Mass Hiring, Specialist Hiring, and Strategic Hiring. Same organisation. Four very different hiring problems. One recruitment model cannot solve all of them equally well.",
      },
      {
        id: "b-callout-1",
        type: "callout",
        tone: "evidence",
        label: "EVIDENCE",
        text: "Run a rough cut of your last 20 hires against these three dimensions. Most teams discover they spent strategic-hiring effort on simple-hiring roles — and vice versa.",
      },
      {
        id: "b-h2-3",
        type: "heading",
        level: 2,
        text: "Strategy is about making choices",
        anchor: "s3",
      },
      {
        id: "b-p-7",
        type: "paragraph",
        text: "Strategy is not a long document describing everything the TA team does. It is a set of choices about **where to invest, where to standardise and where to differentiate**.",
      },
      {
        id: "b-p-8",
        type: "paragraph",
        text: "Once the hiring situation is clear, better decisions follow about recruiter capacity and team structure, sourcing and talent intelligence, employer value proposition, assessment methods, candidate experience, technology and automation, external search partners, and metrics.",
      },
      {
        id: "b-p-9",
        type: "paragraph",
        text: 'The question is no longer "What are the best recruitment practices?" It becomes: **"What is the right recruitment approach for this hiring problem?"** — a much more useful question.',
      },
      {
        id: "b-h2-4",
        type: "heading",
        level: 2,
        text: "From business strategy to talent acquisition",
        anchor: "s4",
      },
      {
        id: "b-p-10",
        type: "paragraph",
        text: "I think about the process as three levels: **WHY → WHAT → HOW**. WHY is the business strategy. WHAT is the talent requirement. HOW is the talent acquisition response. Jump straight to the HOW and talent acquisition becomes reactive. Connect all three and TA starts operating as a business function.",
      },
      {
        id: "b-quote-2",
        type: "blockquote",
        text: "Good talent acquisition strategy is not about recruiting more efficiently. It is about making better talent decisions before the search even begins.",
      },
    ];

    await db.insert(guides).values({
      id: "guide-ta-strategy-001",
      title: "Talent Acquisition Strategy Is Not a Hiring Plan",
      slug: "talent-acquisition-strategy",
      excerpt: "The real way to develop a talent acquisition strategy: start with the hiring situation, not the toolkit.",
      body: JSON.stringify(blocks),
      author: "Ahmed Awad",
      category: "Strategy",
      tags: "Strategy, Architecture, Leadership",
      status: "published",
      metaTitle: "Talent Acquisition Strategy Is Not a Hiring Plan",
      metaDescription: "Start with the hiring situation, not the toolkit. The real way to develop a talent acquisition strategy from Ahmed Awad.",
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    });
    console.log("✅ Baseline guide seeded successfully!");
  } else {
    console.log("ℹ️ Baseline guide already exists");
  }
}
