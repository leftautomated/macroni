import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { api } from "./_generated/api";

export const join = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (existing) return;
    await ctx.db.insert("waitlist", { email });
    await ctx.scheduler.runAfter(0, api.sendConfirmation.send, { email });
  },
});
