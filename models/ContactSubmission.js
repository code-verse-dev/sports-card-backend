import mongoose from "mongoose";

const contactSubmissionSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    message: { type: String, required: true, trim: true },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

export const ContactSubmission = mongoose.model(
  "ContactSubmission",
  contactSubmissionSchema,
  "contact_submissions"
);
