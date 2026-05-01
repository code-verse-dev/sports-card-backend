import mongoose from "mongoose";

const blogLikeSchema = new mongoose.Schema(
  {
    blogPost: { type: mongoose.Schema.Types.ObjectId, ref: "BlogPost", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerUser", required: true, index: true },
  },
  { timestamps: true }
);

blogLikeSchema.index({ blogPost: 1, userId: 1 }, { unique: true });

export const BlogLike = mongoose.model("BlogLike", blogLikeSchema, "blog_likes");
