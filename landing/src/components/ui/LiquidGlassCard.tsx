"use client";

import { cn } from "@/lib/utils";
import { motion, HTMLMotionProps } from "motion/react";
import React from "react";

interface LiquidGlassCardProps extends HTMLMotionProps<"div"> {
    children: React.ReactNode;
    className?: string;
    glowColor?: "yellow" | "white" | "none";
}

export function LiquidGlassCard({
    children,
    className,
    glowColor = "none",
    ...props
}: LiquidGlassCardProps) {
    return (
        <motion.div
            whileHover={{ y: -2, scale: 1.01 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={cn(
                "relative z-0 overflow-hidden rounded-[32px] border border-white/10 bg-white/[0.02] p-8 backdrop-blur-2xl transition-all duration-500 hover:bg-white/[0.04] hover:border-white/20",
                className
            )}
            {...props}
        >
            {/* Subtle top inner highlight to simulate glass edge */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />

            {/* Optional ambient inner glow based on color */}
            {glowColor === "yellow" && (
                <div className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-[#FFBD2E]/10 blur-[60px]" />
            )}
            {glowColor === "white" && (
                <div className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-white/5 blur-[50px]" />
            )}

            {children}
        </motion.div>
    );
}
