import { Resend } from "resend";
import { v } from "convex/values";
import { action } from "./_generated/server";

export const send = action({
  args: { email: v.string() },
  handler: async (_, { email }) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "Macroni <noreply@macroni.app>",
      to: email,
      subject: "You're on the Macroni waitlist!",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
          <h1 style="font-size: 24px; font-weight: 600; color: #111; margin-bottom: 16px;">Welcome to the waitlist!</h1>
          <p style="font-size: 16px; line-height: 1.6; color: #444; margin-bottom: 24px;">
            Thanks for signing up for Macroni. We're building the future of desktop automation, and you'll be among the first to try it.
          </p>
          <p style="font-size: 16px; line-height: 1.6; color: #444; margin-bottom: 24px;">
            We'll reach out as soon as your spot opens up.
          </p>
          <p style="font-size: 14px; color: #999;">— The Macroni Team</p>
        </div>
      `,
    });
  },
});
