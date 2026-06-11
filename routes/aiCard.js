import express from "express";
import { buildDetailsFromSimpleRequest, generateAiCardSide } from "../services/aiCardGenerate.js";

const router = express.Router();

const MAX_BODY = 12_000;

router.post("/generate", express.json({ limit: MAX_BODY }), async (req, res) => {
  try {
    const side = req.body?.side;
    if (side !== "front" && side !== "back") {
      return res.status(400).json({ error: 'Invalid side. Use "front" or "back".' });
    }

    const frontNotes = String(req.body?.frontNotes ?? req.body?.customerNotes ?? "").trim();
    const backNotes = String(req.body?.backNotes ?? req.body?.customerNotes ?? "").trim();
    const sideNotes = side === "back" ? backNotes : frontNotes;
    if (!sideNotes) {
      return res.status(400).json({
        error: side === "back" ? "Back card details are required." : "Front card details are required.",
      });
    }

    const category = String(req.body?.category ?? "").trim();
    if (!category) {
      return res.status(400).json({ error: "Category is required." });
    }

    const image = String(req.body?.image ?? "").trim();
    const templateId = String(req.body?.templateId ?? "").trim();
    if (!image && !templateId) {
      return res.status(400).json({ error: "Template image or templateId is required." });
    }

    const sizeOptionId = String(req.body?.sizeOptionId ?? "2.5x3.5").trim();
    const details = await buildDetailsFromSimpleRequest({
      side,
      category,
      image,
      templateId,
      frontNotes,
      backNotes,
    });
    const result = await generateAiCardSide({ side, sizeOptionId, details });
    res.json({
      ...result,
      previewUrl: `/api/uploads/${result.id}`,
    });
  } catch (e) {
    console.error("[ai-card] generate:", e?.message || e);
    const msg = e?.message || "Generation failed";
    const status = msg.includes("not configured") ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});

export default router;
