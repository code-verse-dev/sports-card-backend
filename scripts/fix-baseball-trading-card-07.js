/**
 * Fix Baseball Trading Card 07 product URLs.
 *
 * Problem: variants use paths like sports/baseball/baseball-trading-card-07/red
 * with no design-root row. Shop/category links resolve slug "red", which collides
 * with Birth Announcement Baseball 02.
 *
 * Creates a design-root row at sports/baseball/baseball-trading-card-07 and
 * repoints all variants to it (same pattern as Baseball Trading Card 01–03).
 *
 * Run (from sports-card-backend):
 *   node scripts/fix-baseball-trading-card-07.js           # dry run
 *   node scripts/fix-baseball-trading-card-07.js --apply   # write to DB
 */
import "../load-env.js";

import { connectDB, dbConnected } from "../db.js";
import { Template } from "../models/Template.js";

const APPLY = process.argv.includes("--apply");
const DESIGN_BASE = "sports/baseball/baseball-trading-card-07";
const DESIGN_NAME = "Baseball Trading Card 07";

async function run() {
  await connectDB();
  if (!dbConnected()) {
    console.error("MONGODB_URI not set. Aborting.");
    process.exit(1);
  }

  const variants = await Template.find({
    $or: [
      { templateId: new RegExp(`/${DESIGN_BASE.replace(/\//g, "\\/")}/`) },
      { id: new RegExp(`/${DESIGN_BASE.replace(/\//g, "\\/")}/`) },
    ],
  }).lean();

  const root = await Template.findOne({
    $or: [{ templateId: DESIGN_BASE }, { id: DESIGN_BASE }],
  }).lean();

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Variants found: ${variants.length}`);
  console.log(`Design root exists: ${!!root}\n`);

  if (!variants.length) {
    console.log("No Baseball Trading Card 07 variants found. Nothing to do.");
    return;
  }

  const sample = variants[0];
  const categoryId = sample.categoryId;
  const subcategoryId = sample.subcategoryId;

  if (!root) {
    const parentTemplate = variants.find((t) => t.isParent) ?? variants[0];
    console.log(`${APPLY ? "CREATE" : "WOULD CREATE"} design root: ${DESIGN_BASE}`);
    console.log(`  name: ${DESIGN_NAME}`);
    console.log(`  clone layout from: ${parentTemplate.name}`);

    if (APPLY) {
      await Template.create({
        name: DESIGN_NAME,
        parentName: DESIGN_NAME,
        categoryId,
        subcategoryId,
        id: DESIGN_BASE,
        templateId: DESIGN_BASE,
        isParent: true,
        parentId: null,
        template: parentTemplate.template,
        preview: parentTemplate.preview,
        front: parentTemplate.front,
        back: parentTemplate.back,
        productDetails: parentTemplate.productDetails,
        productDetailsTitle: parentTemplate.productDetailsTitle,
        properties: parentTemplate.properties,
      });
    }
  }

  const rootId = root?._id?.toString();
  let rootKey = DESIGN_BASE;
  if (!root && APPLY) {
    const created = await Template.findOne({ templateId: DESIGN_BASE }).lean();
    rootKey = created?.id || created?.templateId || DESIGN_BASE;
  } else if (root) {
    rootKey = root.id || root.templateId || DESIGN_BASE;
  }

  for (const v of variants) {
    const legacyIds = new Set(Array.isArray(v.legacyIds) ? v.legacyIds.map(String) : []);
    const updates = {
      parentId: rootKey,
      parentName: DESIGN_NAME,
      isParent: false,
    };
    if (v.isParent) {
      console.log(`${APPLY ? "UPDATE" : "WOULD UPDATE"} ${v.name}: clear isParent, parentId -> ${rootKey}`);
    } else {
      console.log(`${APPLY ? "UPDATE" : "WOULD UPDATE"} ${v.name}: parentId -> ${rootKey}`);
    }
    if (APPLY) {
      await Template.updateOne({ _id: v._id }, { $set: updates, $addToSet: { legacyIds: { $each: [...legacyIds] } } });
    }
  }

  if (root && !root.isParent) {
    console.log(`${APPLY ? "UPDATE" : "WOULD UPDATE"} root row: set isParent=true`);
    if (APPLY) {
      await Template.updateOne({ _id: root._id }, { $set: { isParent: true, parentName: DESIGN_NAME, name: DESIGN_NAME } });
    }
  }

  console.log("\nDone.");
  if (!APPLY) {
    console.log("Re-run with --apply to write changes.");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
