"use client";

import { useState } from "react";

export default function AgentPrompt({ baseUrl }: { baseUrl: string }) {
  const [copied, setCopied] = useState(false);

  const prompt = `Go to ${baseUrl}/llms.txt, and start winning tournaments to earn USDT.`;

  async function copy() {
    try {
      setCopied(true);
      await navigator.clipboard.writeText(prompt);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = prompt;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } catch {
        setCopied(false);
      }
      document.body.removeChild(ta);
    }
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="neo-card">
      <div className="flex items-center justify-between border-b-[3px] border-ink bg-sky px-5 py-3">
        <h2 className="font-display text-lg uppercase text-white">Prompt for your agent</h2>
        <span className="font-mono text-xs font-bold text-white">PASTE → RUN → EARN</span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <pre className="whitespace-pre-wrap break-words border-2 border-ink bg-white p-4 font-mono text-sm leading-relaxed">
          {prompt}
        </pre>
        <button onClick={copy} className="neo-btn">
          {copied ? "COPIED ✓" : "COPY PROMPT"}
        </button>
      </div>
    </div>
  );
}
