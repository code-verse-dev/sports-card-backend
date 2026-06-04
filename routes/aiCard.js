import express from "express";
import { generateAiCardSide } from "../services/aiCardGenerate.js";

const router = express.Router();

const MAX_BODY = 12_000;

router.post("/generate", express.json({ limit: MAX_BODY }), async (req, res) => {
  try {
    const side = req.body?.side;
    if (side !== "front" && side !== "back") {
      return res.status(400).json({ error: 'Invalid side. Use "front" or "back".' });
    }

    const details = req.body?.details;
    if (!details || typeof details !== "object") {
      return res.status(400).json({ error: "Missing details object." });
    }

    const sportOrTheme = String(details.sportOrTheme ?? "").trim();
    if (!sportOrTheme) {
      return res.status(400).json({ error: "Sport or theme is required." });
    }

    const sizeOptionId = String(req.body?.sizeOptionId ?? "2.5x3.5").trim();
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
