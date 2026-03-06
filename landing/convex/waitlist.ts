import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { api } from "./_generated/api";

export const join = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await ctx.db.insert("waitlist", { email });
    await ctx.scheduler.runAfter(0, api.sendConfirmation.send, { email });
  },
});
