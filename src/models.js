import mongoose from "mongoose";

const { Schema, model, models } = mongoose;

// These schemas mirror the collections created by the main Next.js app so the
// CRM reads/writes the same data.

const UserSchema = new Schema(
  {
    name: String,
    email: { type: String, index: true },
    phone: String,
    passwordHash: String,
    role: { type: String, enum: ["user", "admin"], default: "user" },
    referralCode: { type: String, index: true },
    referredBy: { type: Schema.Types.ObjectId, ref: "User" },
    walletBalance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const ShippingAddressSchema = new Schema(
  {
    fullName: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    state: String,
    pincode: String,
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    product: String,
    quantity: Number,
    unitLabel: String,
    subtotal: Number,
    gst: Number,
    total: Number,
    amount: Number,
    currency: String,
    images: [String],
    note: String,
    shippingAddress: ShippingAddressSchema,
    status: String,
    paymentStatus: String,
    referrer: { type: Schema.Types.ObjectId, ref: "User", index: true },
    referralReward: { type: Number, default: 0 },
    referralCredited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const BlogSchema = new Schema(
  {
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: String,
    content: String, // HTML from the rich text editor
    coverImage: String,
    metaTitle: String,
    metaDescription: String,
    metaKeywords: String,
    author: { type: String, default: "swarnamaala.in" },
    published: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export const User = models.User || model("User", UserSchema);
export const Order = models.Order || model("Order", OrderSchema);
export const Blog = models.Blog || model("Blog", BlogSchema);
