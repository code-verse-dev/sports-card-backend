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
