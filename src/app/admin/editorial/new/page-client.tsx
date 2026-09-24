"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { generateDraftAction } from "@/features/editorial-ai/drafts/actions";
import type { GenerateDraftInput } from "@/features/editorial-ai/drafts/types";
import type { KnowledgeSource } from "@/lib/db";

interface NewDraftClientProps {
  user: { id: string; name?: string | null; email?: string | null; role?: string | null };
  sources: KnowledgeSource[];
}

export function NewDraftClient({ sources }: NewDraftClientProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(() => {
      setError(null);
    });
    setIsGenerating(true);

    const formData = new FormData(e.currentTarget);
    const selectedSourceIds = formData.getAll("sourceIds").map((s) => s.toString());

    const input: GenerateDraftInput = {
      contentType: (formData.get("contentType") as "GUIDE" | "FIELD_NOTE") || "GUIDE",
      topic: formData.get("topic") as string,
      workingTitle: formData.get("workingTitle") as string || undefined,
      audience: formData.get("audience") as string || undefined,
      angle: formData.get("angle") as string || undefined,
      objective: formData.get("objective") as string || undefined,
      notes: formData.get("notes") as string || undefined,
      sourceIds: selectedSourceIds.length > 0 ? selectedSourceIds : undefined,
    };

    try {
      const draft = await generateDraftAction(input);
      router.push(`/admin/editorial/${draft.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGenerating(false);
    }
  }

  const readySources = sources.filter((s) => s.status === "READY");

  return (
    <div style={{ padding: "24px", maxWidth: "800px" }}>
      <Link href="/admin/editorial" style={{ color: "#6b7280", fontSize: "13px", textDecoration: "none" }}>&larr; Back to Drafts</Link>
      <h1 style={{ fontSize: "24px", marginTop: "8px", marginBottom: "8px" }}>New Editorial Draft</h1>
      <p style={{ color: "#6b7280", fontSize: "13px", marginBottom: "20px" }}>
        Configure the generation parameters and the AI will produce a draft grounded in your knowledge library.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Content Type *</label>
          <select name="contentType" defaultValue="GUIDE" required disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px" }}>
            <option value="GUIDE">Guide (Aha Authority article)</option>
            <option value="FIELD_NOTE">Field Note (Quick insight)</option>
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Topic *</label>
          <input type="text" name="topic" placeholder="e.g. Why structured intake improves hiring signal" required disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px" }} />
          <p style={{ color: "#9ca3af", fontSize: "11px", marginTop: "2px" }}>The central subject for the draft. This drives knowledge retrieval.</p>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Working Title</label>
          <input type="text" name="workingTitle" placeholder="Optional guidance, you may revise" disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px" }} />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Audience</label>
          <input type="text" name="audience" placeholder="e.g. Talent acquisition leaders building evidence-based hiring processes" disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px" }} />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Angle</label>
          <input type="text" name="angle" placeholder="e.g. Why experience alone can hide weak hiring evidence" disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px" }} />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Objective</label>
          <textarea name="objective" placeholder="What should the reader be able to do after reading?" rows={2} disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px", resize: "vertical" }} />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>Additional Notes</label>
          <textarea name="notes" placeholder="Any specific points to address" rows={3} disabled={isGenerating} style={{ width: "100%", padding: "8px", border: "1px solid #d1d5db", borderRadius: "4px", fontSize: "14px", resize: "vertical" }} />
        </div>

        {readySources.length > 0 && (
          <div>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 500, marginBottom: "4px" }}>
              Source Filter (optional — leave empty to search all sources)
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "120px", overflow: "auto", border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px" }}>
              {readySources.map((s) => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 8px", fontSize: "13px", cursor: "pointer" }}>
                  <input type="checkbox" name="sourceIds" value={s.id} disabled={isGenerating} />
                  <span>{s.title}</span>
                  <span style={{ color: "#6b7280", fontSize: "11px" }}>({s.chunkCount} chunks)</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p style={{ color: "#ef4444", fontSize: "13px" }}>{error}</p>}

        <button type="submit" disabled={isGenerating || isPending} style={{ padding: "10px 20px", background: "#3b82f6", color: "white", border: "none", borderRadius: "6px", fontSize: "14px", cursor: isGenerating ? "not-allowed" : "pointer", alignSelf: "flex-start" }}>
          {isGenerating ? "Generating..." : "Generate Draft"}
        </button>
      </form>
    </div>
  );
}
