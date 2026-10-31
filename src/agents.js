// Sales agents: add/edit/remove agents, assign an agent to an order, and
// count how many orders each agent brought in.
import mongoose from "mongoose";
import { Agent, Order } from "./models.js";
import { requireAdmin } from "./auth.js";

const isId = (v) => mongoose.isValidObjectId(v);
const clip = (v, max) => String(v ?? "").trim().slice(0, max);

// Order counts per agent: total, paid, delivered, and revenue (excl. cancelled).
async function agentCounts() {
  const rows = await Order.aggregate([
    { $match: { agent: { $ne: null } } },
    {
      $group: {
        _id: "$agent",
        orders: { $sum: 1 },
        paid: { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
        revenue: {
          $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, { $ifNull: ["$total", { $ifNull: ["$amount", 0] }] }, 0] },
        },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

export function registerAgentRoutes(app) {
  app.get("/api/agents", requireAdmin, async (_req, res) => {
    try {
      const [agents, counts, unassigned] = await Promise.all([
        Agent.find({}).sort({ active: -1, name: 1 }).lean(),
        agentCounts(),
        Order.countDocuments({ agent: null }),
      ]);
      res.json({
        agents: agents.map((a) => ({
          ...a,
          stats: counts.get(String(a._id)) ?? { orders: 0, paid: 0, delivered: 0, revenue: 0 },
        })),
        unassigned,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load agents." });
    }
  });

  app.post("/api/agents", requireAdmin, async (req, res) => {
    try {
      const name = clip(req.body?.name, 80);
      if (!name) return res.status(400).json({ error: "Enter the agent's name." });
      const agent = await Agent.create({ name, phone: clip(req.body?.phone, 20) || undefined });
      res.json({ agent: { ...agent.toObject(), stats: { orders: 0, paid: 0, delivered: 0, revenue: 0 } } });
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: "An agent with this name already exists." });
      console.error(err);
      res.status(500).json({ error: "Failed to add agent." });
    }
  });

  app.patch("/api/agents/:id", requireAdmin, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ error: "Agent not found." });
      const b = req.body || {};
      const update = {};
      if (b.name !== undefined) {
        update.name = clip(b.name, 80);
        if (!update.name) return res.status(400).json({ error: "Enter the agent's name." });
      }
      if (b.phone !== undefined) update.phone = clip(b.phone, 20);
      if (b.active !== undefined) update.active = !!b.active;
      const agent = await Agent.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
      if (!agent) return res.status(404).json({ error: "Agent not found." });
      res.json({ agent });
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ error: "An agent with this name already exists." });
      console.error(err);
      res.status(500).json({ error: "Failed to update agent." });
    }
  });

  // Deleting an agent keeps their orders; the orders just become unassigned.
  app.delete("/api/agents/:id", requireAdmin, async (req, res) => {
    try {
      if (!isId(req.params.id)) return res.status(404).json({ error: "Agent not found." });
      const agent = await Agent.findByIdAndDelete(req.params.id);
      if (!agent) return res.status(404).json({ error: "Agent not found." });
      const r = await Order.updateMany({ agent: agent._id }, { $set: { agent: null } });
      res.json({ ok: true, unassignedOrders: r.modifiedCount ?? 0 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete agent." });
    }
  });

  // Assign (or clear with agentId: null) the agent on an order.
  app.patch("/api/orders/:id/agent", requireAdmin, async (req, res) => {
    try {
      const agentId = req.body?.agentId || null;
      let agent = null;
      if (agentId) {
        if (!isId(agentId)) return res.status(400).json({ error: "Invalid agent." });
        agent = await Agent.findById(agentId).select("name").lean();
        if (!agent) return res.status(400).json({ error: "That agent no longer exists." });
      }
      const order = await Order.findByIdAndUpdate(req.params.id, { $set: { agent: agentId } }, { new: true }).select("_id");
      if (!order) return res.status(404).json({ error: "Order not found." });
      res.json({ ok: true, agent });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to assign agent." });
    }
  });
}
