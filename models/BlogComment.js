import mongoose from "mongoose";

const blogCommentSchema = new mongoose.Schema(
  {
    blogPost: { type: mongoose.Schema.Types.ObjectId, ref: "BlogPost", required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerUser", required: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

blogCommentSchema.index({ blogPost: 1, createdAt: -1 });

export const BlogComment = mongoose.model("BlogComment", blogCommentSchema, "blog_comments");
