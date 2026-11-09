"use client";
import { PageHeader, Select, Input, Textarea, Button } from "../../_ui";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { generateDraftAction } from "@/features/editorial-ai/drafts/actions";
import type { GenerateDraftInput } from "@/features/editorial-ai/drafts/types";
import type { KnowledgeSource } from "@/lib/db";
import { unwrapActionResult } from "@/lib/action-result";

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
      const draft = unwrapActionResult(await generateDraftAction(input));
      router.push(`/admin/editorial/${draft.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGenerating(false);
    }
  }

  const readySources = sources.filter((s) => s.status === "READY");

  return (
    <div >
      <Link className="s-muted s-text-sm" href="/admin/editorial" >&larr; Back to Drafts</Link>
      <PageHeader eyebrow="Editorial AI" title={<>New Editorial Draft</>} />
      <p className="s-muted s-text-sm s-margin-bottom-20px" >
        Choose a topic and the sources to draw from. You’ll review and refine the draft before publishing.
      </p>

      <form className="ui-card s-row s-column s-gap-16px" onSubmit={handleSubmit} >
        <div>
          <label htmlFor="new-field-2816" className="s-block s-text-sm s-margin-bottom-4px" >Content Type *</label>
          <Select id="new-field-2816" className="s-full s-padding-8px s-text-sm" name="contentType" defaultValue="GUIDE" required disabled={isGenerating} >
            <option value="GUIDE">Guide (Aha Authority article)</option>
            <option value="FIELD_NOTE">Field Note (Quick insight)</option>
          </Select>
        </div>

        <div>
          <label htmlFor="new-field-3334" className="s-block s-text-sm s-margin-bottom-4px" >Topic *</label>
          <Input id="new-field-3334" className="s-full s-padding-8px s-text-sm" type="text" name="topic" placeholder="e.g. Why structured intake improves hiring signal" required disabled={isGenerating} />
          <p className="s-muted s-text-xs s-margin-top-2px" >The central subject for the draft. This drives knowledge retrieval.</p>
        </div>

        <div>
          <label htmlFor="new-field-3890" className="s-block s-text-sm s-margin-bottom-4px" >Working Title</label>
          <Input id="new-field-3890" className="s-full s-padding-8px s-text-sm" type="text" name="workingTitle" placeholder="Optional guidance, you may revise" disabled={isGenerating} />
        </div>

        <div>
          <label htmlFor="new-field-4273" className="s-block s-text-sm s-margin-bottom-4px" >Audience</label>
          <Input id="new-field-4273" className="s-full s-padding-8px s-text-sm" type="text" name="audience" placeholder="e.g. Talent acquisition leaders building evidence-based hiring processes" disabled={isGenerating} />
        </div>

        <div>
          <label htmlFor="new-field-4688" className="s-block s-text-sm s-margin-bottom-4px" >Angle</label>
          <Input id="new-field-4688" className="s-full s-padding-8px s-text-sm" type="text" name="angle" placeholder="e.g. Why experience alone can hide weak hiring evidence" disabled={isGenerating} />
        </div>

        <div>
          <label htmlFor="new-field-5087" className="s-block s-text-sm s-margin-bottom-4px" >Objective</label>
          <Textarea id="new-field-5087" className="s-full s-padding-8px s-text-sm s-resize-vertical" name="objective" placeholder="What should the reader be able to do after reading?" rows={2} disabled={isGenerating} />
        </div>

        <div>
          <label htmlFor="new-field-5513" className="s-block s-text-sm s-margin-bottom-4px" >Additional Notes</label>
          <Textarea id="new-field-5513" className="s-full s-padding-8px s-text-sm s-resize-vertical" name="notes" placeholder="Any specific points to address" rows={3} disabled={isGenerating} />
        </div>

        {readySources.length > 0 && (
          <div>
            <label className="s-block s-text-sm s-margin-bottom-4px" >
              Source Filter (optional — leave empty to search all sources)
            </label>
            <div className="s-row s-column s-gap-4px s-max-height-120px s-overflow-auto s-padding-4px ui-card" >
              {readySources.map((s) => (
                <label className="s-row s-align-items-center s-gap-6px s-padding-4px-8px s-text-sm" key={s.id} >
                  <Input type="checkbox" name="sourceIds" value={s.id} disabled={isGenerating} />
                  <span>{s.title}</span>
                  <span className="s-muted s-text-xs" >({s.chunkCount} chunks)</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <p className="s-danger s-text-sm" >{error}</p>}

        <Button className="s-padding-10px-20px s-muted s-text-sm s-align-self-flex-start btn primary" type="submit" disabled={isGenerating || isPending} >
          {isGenerating ? "Generating..." : "Generate Draft"}
        </Button>
      </form>
    </div>
  );
}
