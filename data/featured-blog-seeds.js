/**
 * Matches sports-cards-frontend/src/data/featuredBlogPosts.ts (legacy blog routes).
 * Used by POST /api/admin/blog-posts/seed-featured to upsert into MongoDB.
 */
export const FEATURED_BLOG_SEEDS = [
  {
    slug: "police-heroes-custom-cards",
    title: "8 Creative Ways to Celebrate Police Heroes with Custom Cards",
    excerpt:
      "From individual officer recognition and K9 hero cards to community outreach and fallen hero tributes—discover thoughtful ideas to honor law enforcement with custom trading cards that build morale and strengthen community trust.",
  },
  {
    slug: "k9-storytelling-custom-cards",
    title: "How Custom Cards Are Changing K9 Storytelling Today",
    excerpt:
      "K9 teams build trust, save lives and form strong partnerships. Custom cards help departments share the journeys and achievements of working dogs in schools, community events and beyond.",
  },
  {
    slug: "pet-photos-trading-cards",
    title: "How to Turn Your Pet's Photos into Collectible Trading Cards",
    excerpt:
      "Turn pet photos into keepsakes you can hold. From capturing the perfect photo to choosing themes, templates, and quality materials—create custom pet cards for gifts, birthdays, and more.",
  },
  {
    slug: "football-trader-card",
    title: "Steps to Create a Football Trader Card for Your Athlete",
    excerpt:
      "From choosing templates and adding photos to customizing design and printing—create custom football trading cards that celebrate every player and every victory.",
  },
];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal HTML body for seeded posts (full UX remains on existing React pages at /blog/:slug). */
export function seedContentHtml(excerpt) {
  const safe = escapeHtml(excerpt);
  return `<p>${safe}</p><p><em>Open the full article using the same link as before; content is also editable in Admin → Blog posts.</em></p>`;
}
