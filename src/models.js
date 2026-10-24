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
    couponCode: String,
    discount: { type: Number, default: 0 },
    // "online" | "cod" | "marketplace"
    paymentMethod: String,
    codFee: { type: Number, default: 0 },
    // "website" or the selling platform (meesho, flipkart, amazon, ...).
    source: { type: String, default: "website" },
    // The platform's own order id, for marketplace orders.
    externalOrderId: String,
    images: [String],
    note: String,
    // Internal note added by CRM admins (not visible to the customer).
    adminNote: String,
    shippingAddress: ShippingAddressSchema,
    status: String,
    paymentStatus: String,

    // Razorpay payment tracking
    razorpayOrderId: { type: String, index: true, sparse: true },
    razorpayPaymentId: { type: String, sparse: true },
    razorpaySignature: String,
    paidAt: Date,

    // Failed payment tracking
    paymentFailedAt: Date,
    paymentFailureReason: String,

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

const CouponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    type: { type: String, enum: ["percent", "flat"], required: true },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, default: 0, min: 0 },
    minOrderValue: { type: Number, default: 0, min: 0 },
    usageLimit: { type: Number, default: 0, min: 0 },
    usedCount: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const User = models.User || model("User", UserSchema);
export const Order = models.Order || model("Order", OrderSchema);
export const Blog = models.Blog || model("Blog", BlogSchema);
export const Coupon = models.Coupon || model("Coupon", CouponSchema);
