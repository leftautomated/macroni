"use client";

import { LiquidGlassCard } from "@/components/ui/LiquidGlassCard";
import { Copyleft, MonitorSmartphone, MousePointerClick, PlayCircle, ShieldCheck, ChevronRight, Mic, Video, MousePointer2, Settings, Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import Image from "next/image";

import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useWebHaptics } from "web-haptics/react";
import { api } from "../../convex/_generated/api";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function WaitlistForm({ className, joined, onJoined }: { className?: string; joined: boolean; onJoined: () => void }) {
  const haptic = useWebHaptics();
  const joinWaitlist = useMutation(api.waitlist.join);
  const [email, setEmail] = useState("");
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!EMAIL_REGEX.test(email)) {
      setError(true);
      setShake(true);
      haptic.trigger("error");
      setTimeout(() => setShake(false), 500);
      setTimeout(() => setError(false), 3000);
      inputRef.current?.focus();
      return;
    }
    setError(false);
    setLoading(true);
    try {
      await joinWaitlist({ email });
      onJoined();
      haptic.trigger("success");
    } catch {
      setError(true);
      setTimeout(() => setError(false), 3000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <div className="flex justify-center">
        <motion.div
          layout
          className={`overflow-hidden rounded-full ${joined ? "" : "w-full"}`}
          style={{
            background: joined ? "#ffffff" : "#111111",
            border: joined ? "1px solid transparent" : "1px solid rgba(255,255,255,0.1)",
            boxShadow: joined ? "none" : "0 25px 50px -12px rgba(0,0,0,0.25)",
            ...(shake ? { animation: "shake 0.4s ease-in-out" } : {}),
          }}
          transition={{ layout: { type: "spring", stiffness: 300, damping: 28 } }}
        >
          <AnimatePresence mode="popLayout">
            {joined ? (
              <motion.div
                key="success"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="flex items-center gap-2.5 px-6 py-3"
              >
                <Check className="h-5 w-5 text-black" strokeWidth={2.5} />
                <span className="text-sm font-medium text-black whitespace-nowrap">Joined Waitlist</span>
              </motion.div>
            ) : (
              <motion.form
                key="form"
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex w-full items-center p-1.5"
                onSubmit={handleSubmit}
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (error) setError(false); }}
                  placeholder="Enter email address..."
                  className="flex-1 bg-transparent px-4 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="shrink-0 whitespace-nowrap rounded-full bg-brand-yellow px-5 py-2.5 text-sm font-medium text-black transition-all hover:bg-[#E5B853] disabled:opacity-70"
                >
                  {loading ? "Joining..." : "Join Waitlist"}
                </button>
              </motion.form>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute left-0 right-0 mt-2 text-center text-sm text-red-400"
          >
            Please enter a valid email address
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

function FAQItem({ item }: { item: { q: string; a: string } }) {
  const [isOpen, setIsOpen] = useState(false);
  const haptic = useWebHaptics();
  return (
    <div className="border-b border-white/10">
      <button
        onClick={() => { haptic.trigger("light"); setIsOpen(!isOpen); }}
        className="flex w-full items-center justify-between py-6 text-left"
      >
        <span className="text-lg font-medium text-white">{item.q}</span>
        <motion.div animate={{ rotate: isOpen ? 90 : 0 }} className="text-white/40">
          <ChevronRight className="h-5 w-5" />
        </motion.div>
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <p className="pb-6 text-white/60">{item.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function LandingPage() {
  const [activeSection, setActiveSection] = useState("overview");
  const [mounted, setMounted] = useState(false);
  const [joined, setJoined] = useState(false);
  const haptic = useWebHaptics();

  useEffect(() => {
    setMounted(true);
    const handleScroll = () => {
      const sections = ["overview", "features", "faq"];

      for (const section of sections) {
        const el = document.getElementById(section);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= window.innerHeight / 3 && rect.bottom >= window.innerHeight / 3) {
            setActiveSection(section);
            break;
          }
        }
      }
    };

    window.addEventListener("scroll", handleScroll);
    handleScroll(); // Initial check
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="relative min-h-dvh w-full overflow-hidden bg-black font-sans selection:bg-brand-yellow selection:text-black">
      {/* Background Orbs */}
      <div className="pointer-events-none fixed inset-0 -z-20 overflow-hidden">
        {/* Subtle, localized glows instead of massive colored orbs */}
        <div className="absolute left-1/2 top-0 -translate-x-1/2 h-[500px] w-[800px] rounded-full bg-white/5 blur-[120px]" />
      </div>

      {/* Navbar */}
      <nav className="fixed left-1/2 top-8 z-50 flex h-14 w-11/12 max-w-[500px] -translate-x-1/2 items-center justify-between rounded-full border border-white/10 bg-white/3 px-6 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <Image src="/logo.svg" alt="Macroni Logo" width={24} height={24} className="h-6 w-6" />
          <span className="text-base font-bold tracking-tight text-white">macroni</span>
        </div>
        <div className="flex gap-6">
          {["overview", "features", "faq"].map((section) => (
            <button
              key={section}
              onClick={() => {
                haptic.trigger("selection");
                document.getElementById(section)?.scrollIntoView({ behavior: "smooth" });
              }}
              className={`relative flex items-center justify-center text-sm font-medium transition-colors ${activeSection === section ? "text-white" : "text-white/60 hover:text-white"
                } ${section !== "faq" ? "capitalize" : ""}`}
            >
              {section === "faq" ? "FAQ" : section}
              {activeSection === section && mounted && (
                <motion.div
                  layoutId="navbar-dot"
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-white/50"
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Overview Section */}
      <main id="overview" className="mx-auto flex max-w-[960px] flex-col items-center justify-center px-6 pb-20 pt-32 text-center sm:pt-48 md:px-12 md:pt-56">

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.1, ease: "easeOut" }}
          className="mb-6 max-w-4xl text-4xl font-medium tracking-tight text-white sm:text-5xl md:text-[72px] leading-[1.05]"
        >
          Your Desktop, <span style={{ fontFamily: "var(--font-geist-pixel-square)" }}>Automated.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
          className="mx-auto mb-10 max-w-2xl text-lg text-white/40 sm:text-xl font-normal leading-normal"
        >
          Record your workflows once. Let Macroni's AI handle the rest.<br className="hidden sm:block" />
          Build, share, and monetize your macros securely.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3, ease: "easeOut" }}
          className="w-full max-w-lg mx-auto"
        >
          <WaitlistForm joined={joined} onJoined={() => setJoined(true)} />
        </motion.div>

        {/* Floating App Mockup */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.5, type: "spring", stiffness: 100 }}
          className="relative mt-20 flex w-full justify-center max-w-5xl h-[200px] items-center sm:mt-32 sm:h-[300px]"
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-brand-yellow/10 rounded-full blur-[100px] pointer-events-none" />

          <motion.div
            drag
            dragConstraints={{ left: -300, right: 300, top: -100, bottom: 100 }}
            dragElastic={0.1}
            whileDrag={{ scale: 1.05, cursor: "grabbing" }}
            className="relative z-10 mx-auto flex w-fit items-center gap-2 rounded-full border border-white/10 bg-[#111111]/90 p-2 shadow-[0_20px_60px_rgba(0,0,0,0.8)] backdrop-blur-2xl cursor-grab"
            title="Drag me!"
          >
            <div className="hidden items-center gap-3 px-4 pr-6 border-r border-white/10 sm:flex">
              <div className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
              <span className="text-sm font-medium text-white font-mono tracking-wide">00:14</span>
            </div>

            <div className="flex items-center gap-1 px-1.5 sm:gap-1.5 sm:px-3">
              <button onClick={() => haptic.trigger("light")} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 transition-colors text-white/50 hover:text-white sm:h-11 sm:w-11">
                <Mic className="h-4 w-4 sm:h-5 sm:w-5" />
              </button>
              <button onClick={() => haptic.trigger("light")} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 transition-colors text-white shadow-inner sm:h-11 sm:w-11">
                <Video className="h-4 w-4 sm:h-5 sm:w-5" />
              </button>
              <button onClick={() => haptic.trigger("light")} className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-yellow/15 text-brand-yellow hover:bg-brand-yellow/25 transition-colors border border-brand-yellow/20 sm:h-11 sm:w-11">
                <MousePointer2 className="h-4 w-4 sm:h-5 sm:w-5" />
              </button>
              <button onClick={() => haptic.trigger("light")} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 transition-colors text-white/50 hover:text-white sm:h-11 sm:w-11">
                <Settings className="h-4 w-4 sm:h-5 sm:w-5" />
              </button>
            </div>

            <div className="pl-1.5 pr-0.5 border-l border-white/10 sm:pl-3 sm:pr-1">
              <button onClick={() => haptic.trigger("light")} className="flex h-9 w-9 items-center justify-center rounded-[14px] bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors sm:h-11 sm:w-11 sm:rounded-[18px]">
                <div className="h-3 w-3 rounded-sm bg-red-500 sm:h-3.5 sm:w-3.5" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      </main>

      {/* Features Bento Grid */}
      <section id="features" className="mx-auto max-w-[960px] px-6 py-20 sm:py-32 md:px-12">
        <div className="mb-12 text-center sm:mb-20">
          <h2 className="text-3xl font-bold tracking-tight text-white md:text-5xl">Limitless <span style={{ fontFamily: "var(--font-geist-pixel-square)" }}>Automation</span></h2>
          <p className="mt-4 text-lg text-neutral-400">Powered by advanced computer vision and local AI models.</p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <LiquidGlassCard className="col-span-1 md:col-span-2 min-h-[300px] flex flex-col md:flex-row items-center gap-8 sm:min-h-[400px] lg:gap-16" glowColor="yellow">
            <div className="flex-1">
              <h3 className="mb-4 text-3xl font-bold tracking-tight text-white">Intelligent Recording</h3>
              <p className="mb-10 text-white/60 text-lg leading-relaxed">
                Macroni understands what you're doing, not just where you click. It recognizes elements across apps, making macros resilient to UI updates.
              </p>
            </div>

            {/* Visual Code block */}
            <div className="flex-1 w-full relative h-full min-h-[250px] mt-8 md:mt-0">
              <div className="absolute inset-0 rounded-2xl border border-white/10 bg-[#050505] p-6 font-mono text-[13px] shadow-2xl overflow-hidden flex flex-col justify-center">
                <div className="text-white/60"><span className="text-brand-yellow">await</span> macroni.<span className="text-white">find</span>(<span className="text-green-400">"Export Button"</span>);</div>
                <div className="mt-3 text-white/60"><span className="text-brand-yellow">await</span> macroni.<span className="text-white">click</span>();</div>
                <div className="mt-3 text-white/60"><span className="text-brand-yellow">await</span> macroni.<span className="text-white">type</span>(<span className="text-green-400">"report_2026.pdf"</span>);</div>
                <div className="mt-4 flex">
                  <div className="h-4 w-2 bg-white/20 animate-pulse" />
                </div>
              </div>
            </div>
          </LiquidGlassCard>

          <LiquidGlassCard glowColor="none" className="min-h-[280px] p-0 flex flex-col sm:min-h-[380px]">
            <div className="relative flex-1 flex flex-col justify-between p-8 md:p-12 overflow-hidden rounded-[32px]">
              <div
                className="pointer-events-none absolute inset-0 z-0 opacity-40 mix-blend-screen"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg width='32' height='32' viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M15 15V7h2v8h8v2h-8v8h-2v-8H7v-2h8z' fill='%23F0CD78' fill-opacity='0.15' fill-rule='evenodd'/%3E%3C/svg%3E")`,
                  backgroundPosition: 'bottom center'
                }}
              />
              <div className="pointer-events-none absolute inset-0 z-0 bg-linear-to-b from-black via-black/80 to-transparent" />

              <div className="relative z-10 w-full flex-1">
                <h3 className="mb-4 text-2xl font-bold tracking-tight text-white">Macro Marketplace</h3>
                <p className="text-lg text-white/60 leading-relaxed max-w-sm">
                  Discover, buy, and sell advanced macros built by the community. Create value from your workflows.
                </p>
              </div>
            </div>
          </LiquidGlassCard>

          <LiquidGlassCard glowColor="none" className="min-h-[280px] p-0 flex flex-col sm:min-h-[380px]">
            <div className="relative flex-1 flex flex-col justify-between p-8 md:p-12 overflow-hidden rounded-[32px]">
              <div
                className="pointer-events-none absolute inset-0 z-0 opacity-40 mix-blend-screen"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg width='24' height='24' viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='4' cy='4' r='2' fill='%23F0CD78' fill-opacity='0.15'/%3E%3C/svg%3E")`,
                  backgroundPosition: 'bottom center'
                }}
              />
              <div className="pointer-events-none absolute inset-0 z-0 bg-linear-to-b from-black via-black/80 to-transparent" />

              <div className="relative z-10 w-full flex-1">
                <h3 className="mb-4 text-2xl font-bold tracking-tight text-white">Local Privacy First</h3>
                <p className="text-lg text-white/60 leading-relaxed max-w-md">
                  Your screen never leaves your device. All semantic understanding happens securely offline using on-device models. We don't spy on your workflow.
                </p>
              </div>
            </div>
          </LiquidGlassCard>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="mx-auto max-w-[960px] px-6 py-20 sm:py-32 md:px-12">
        <div className="mb-10 text-center sm:mb-16">
          <h2 className="text-3xl font-medium tracking-tight text-white sm:text-4xl md:text-5xl">FAQ</h2>
        </div>

        <div className="flex flex-col">
          {[
            {
              q: "How do I get access?",
              a: "Macroni is currently in a closed developer preview. By joining the waitlist, you'll be among the first to get access when we open up the beta.",
            },
            {
              q: "Will this be a free or paid product?",
              a: "Macroni will have a generous free tier for personal use. Advanced features and team collaboration tools will be available on a paid subscription.",
            },
            {
              q: "What platforms are supported?",
              a: "Macroni currently supports macOS 13 (Ventura) and later. Windows 11 support is currently in active development.",
            },
          ].map((item, index) => (
            <FAQItem key={index} item={item} />
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section id="download" className="py-20 relative sm:py-32">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[500px] rounded-full bg-white/5 blur-[120px]" />
        <div className="mx-auto max-w-[960px] px-6 text-center relative z-10">
          <div className="py-20 px-0 md:px-16 text-center">
            <h2 className="mb-10 text-3xl font-extrabold tracking-tighter text-white sm:text-4xl md:text-[56px] leading-[1.1]">What will you <span style={{ fontFamily: "var(--font-geist-pixel-square)" }}>automate</span>?</h2>
            <WaitlistForm className="mx-auto w-full max-w-lg" joined={joined} onJoined={() => setJoined(true)} />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full bg-transparent">
        <div className="mx-auto flex max-w-[960px] flex-wrap items-center justify-center gap-4 px-6 py-12 text-[#888888] sm:gap-8">
          <a
            href="https://www.leftautomated.com/"
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-2 text-sm font-medium transition-colors hover:text-white"
          >
            Made by LeftAutomated
            <img src="https://www.leftautomated.com/favicon.png" alt="LeftAutomated Logo" className="h-4 w-4 opacity-50 transition-opacity group-hover:opacity-100" />
          </a>
          <div className="h-1 w-1 rounded-full bg-[#333333]" />
          <a
            href="https://x.com/leftautomated"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium transition-colors hover:text-white"
            aria-label="X (formerly Twitter)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 24.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
          </a>
          <a
            href="https://github.com/leftautomated"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium transition-colors hover:text-white"
            aria-label="GitHub"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path></svg>
          </a>
        </div>
      </footer>
    </div>
  );
}
