import mongoose from "mongoose";

const blogPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    excerpt: { type: String, default: "" },
    contentHtml: { type: String, default: "" },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date },
    metaTitle: { type: String, default: "" },
    metaDescription: { type: String, default: "" },
    /** Absolute or site-relative URL for `<link rel="canonical">` when you wire the public blog. */
    canonicalUrl: { type: String, default: "" },
    /** Open Graph / social overrides; empty means fall back to meta title/description and featured image. */
    ogTitle: { type: String, default: "" },
    ogDescription: { type: String, default: "" },
    /** Upload id (uuid) for OG image when different from featured image. */
    ogImageId: { type: String, default: "" },
    authorName: { type: String, default: "" },
    /** Admin upload id (uuid) for listing cards / hero when the storefront uses DB posts. */
    featuredImageId: { type: String, default: "" },
    faqs: {
      type: [
        {
          question: { type: String, default: "" },
          answer: { type: String, default: "" },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

export const BlogPost = mongoose.model("BlogPost", blogPostSchema, "blog_posts");
