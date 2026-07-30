import dns from "node:dns";
import mongoose from "mongoose";

// Some networks block DNS SRV lookups needed by mongodb+srv:// URIs.
// Point Node at public resolvers that support SRV.
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  /* ignore */
}

let connected = false;

export async function connectDB(uri) {
  if (connected) return mongoose;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  connected = true;
  console.log("[crm] connected to MongoDB");
  return mongoose;
}
