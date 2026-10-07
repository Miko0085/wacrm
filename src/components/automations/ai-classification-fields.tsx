"use client"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export function AiClassificationFields({
  config,
  onChange,
}: {
  config: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}) {
  return (
    <div className="space-y-3">
      <Field label="Instruction">
        <Textarea
          value={(config.instruction as string) ?? ""}
          onChange={(e) => onChange({ instruction: e.target.value })}
          placeholder="Understand the customer message, identify intents, extract qualification data, and decide whether a human is required."
          className="min-h-28 bg-muted text-foreground"
        />
      </Field>

      <Field label="Input">
        <Input
          value={(config.input_template as string) ?? "{{message.text}}"}
          onChange={(e) => onChange({ input_template: e.target.value })}
          className="bg-muted font-mono text-foreground"
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Conversation context">
          <Input
            type="number"
            min={1}
            max={20}
            value={(config.context_messages as number) ?? 5}
            onChange={(e) =>
              onChange({
                context_messages: Math.min(20, Math.max(1, Number(e.target.value) || 1)),
              })
            }
            className="bg-muted text-foreground"
          />
        </Field>
        <Field label="Minimum score">
          <Input
            type="number"
            min={0}
            max={100}
            value={(config.min_score as number) ?? 60}
            onChange={(e) =>
              onChange({
                min_score: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
              })
            }
            className="bg-muted text-foreground"
          />
        </Field>
      </div>

      <Field label="Positive intent">
        <select
          value={(config.positive_intent as string) ?? "positive"}
          onChange={(e) => onChange({ positive_intent: e.target.value })}
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
        >
          <option value="positive">positive</option>
        </select>
      </Field>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Decision only — this node does not send a WhatsApp reply. Uses the AI provider configured in AI Agents → Setup and exposes results to later steps through <code>{"{{vars.ai_*}}"}</code>, including <code>ai_primary_intent</code>, <code>ai_requires_human</code>, <code>ai_confidence</code>, and extracted qualification fields.
      </p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}
