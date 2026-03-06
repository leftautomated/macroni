import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Macroni - Your Desktop, Automated.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          padding: "60px 80px",
        }}
      >
        {/* Logo */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="https://macroni.app/logo.svg"
          alt=""
          width={80}
          height={80}
          style={{ marginBottom: 32 }}
        />

        {/* Title */}
        <div
          style={{
            fontSize: 64,
            fontWeight: 600,
            color: "#ffffff",
            textAlign: "center",
            lineHeight: 1.15,
            letterSpacing: "-0.03em",
            marginBottom: 20,
          }}
        >
          Your Desktop, Automated.
        </div>

        {/* Subtitle */}
        <div
          style={{
            fontSize: 28,
            color: "rgba(255,255,255,0.4)",
            textAlign: "center",
            lineHeight: 1.5,
            maxWidth: 700,
          }}
        >
          Record your workflows once. Let Macroni&apos;s AI handle the rest.
        </div>

      </div>
    ),
    { ...size }
  );
}
