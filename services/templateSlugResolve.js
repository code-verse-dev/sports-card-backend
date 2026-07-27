/**
 * Resolve a product URL slug to the best matching template document.
 * Handles design-folder slugs (baseball-trading-card-07) and disambiguates
 * color-only slugs (red) using optional category/subcategory filters.
 */

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extra path patterns for slugs like martial-arts (sports/martial-arts/card/…). */
function slugPathAlternatives(param) {
  const s = String(param ?? "").trim();
  if (!s) return [];
  const alts = new Set([s]);
  const compositeCard = s.match(/^(.+)-card$/i);
  if (compositeCard) alts.add(`${compositeCard[1]}/card`);
  return [...alts];
}

function templatePath(record) {
  return String(record.templateId ?? record.id ?? "").trim();
}

function pickBestTemplateCandidate(candidates, param, filters = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const categoryId = String(filters.categoryId ?? "").trim();
  const subcategoryId = String(filters.subcategoryId ?? "").trim();

  let pool = [...candidates];
  if (categoryId) {
    const byCat = pool.filter((t) => String(t.categoryId ?? "").trim() === categoryId);
    if (byCat.length) pool = byCat;
  }
  if (subcategoryId) {
    const bySub = pool.filter((t) => String(t.subcategoryId ?? "").trim() === subcategoryId);
    if (bySub.length) pool = bySub;
  }

  const escaped = escapeRegex(param);
  const exactEnd = pool.find((t) => {
    const path = templatePath(t);
    return path === param || path.endsWith(`/${param}`);
  });
  if (exactEnd) return exactEnd;

  const folderRe = new RegExp(`/${escaped}(/|$)`);
  const folderMatches = pool.filter((t) => folderRe.test(templatePath(t)));
  const folderPool = folderMatches.length ? folderMatches : pool;

  const root = folderPool.find((t) => !String(t.parentId ?? "").trim());
  if (root) return root;

  const parent = folderPool.find((t) => t.isParent);
  if (parent) return parent;

  return [...folderPool].sort(
    (a, b) => templatePath(a).length - templatePath(b).length
  )[0];
}

/**
 * Build Mongo queries used after exact id/templateId/legacyIds match fails.
 */
export function buildTemplateSlugOrQueries(param) {
  const patterns = slugPathAlternatives(param);
  const queries = [];
  for (const p of patterns) {
    const escaped = escapeRegex(p);
    queries.push(
      { id: new RegExp(`/${escaped}$`) },
      { templateId: new RegExp(`/${escaped}$`) },
      { id: new RegExp(`/${escaped}/`) },
      { templateId: new RegExp(`/${escaped}/`) }
    );
  }
  return queries;
}

export { pickBestTemplateCandidate };
