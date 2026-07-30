import "dotenv/config";
import { connectDB } from "./db.js";
import { User } from "./models.js";

// Usage: node src/makeAdmin.js user@example.com
const email = (process.argv[2] || "").trim().toLowerCase();

if (!email) {
  console.error("Usage: node src/makeAdmin.js <email>");
  process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Missing MONGODB_URI");
  process.exit(1);
}

await connectDB(uri);
const user = await User.findOneAndUpdate(
  { email },
  { $set: { role: "admin" } },
  { new: true }
);

if (!user) {
  console.error(`No user found with email ${email}. Ask them to sign up first.`);
  process.exit(1);
}

console.log(`${user.name} (${user.email}) is now an admin.`);
process.exit(0);
