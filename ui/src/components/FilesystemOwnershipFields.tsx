import type { FilesystemOwnershipPolicy } from "@paperclipai/shared";
import { Field, ToggleField } from "./agent-config-primitives";
import { Button } from "./ui/button";

interface FilesystemOwnershipFieldsProps {
  value: FilesystemOwnershipPolicy | null;
  onChange: (value: FilesystemOwnershipPolicy | null) => void;
  error: string | null;
}

export function FilesystemOwnershipFields({ value, onChange, error }: FilesystemOwnershipFieldsProps) {
  return (
    <div className="flex flex-col gap-3">
      <ToggleField
        label="Exclusive filesystem ownership"
        hint="Coordinate participating controllers through the directory owner's authority. Wait for overlapping work and retain ownership until jobs and cleanup settle. Requires an enrolled Hermes worker."
        checked={value !== null}
        onChange={(enabled) => onChange(enabled ? { authority: "", principal: "", roots: [""] } : null)}
      />
      {value && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Authority ID" hint="The durable authority ID supplied by the target's administrator.">
              <input
                aria-label="Authority ID"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={value.authority}
                onChange={(event) => onChange({ ...value, authority: event.target.value })}
              />
            </Field>
            <Field label="Enrolled principal" hint="The controller identity enrolled on that authority.">
              <input
                aria-label="Enrolled principal"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={value.principal}
                onChange={(event) => onChange({ ...value, principal: event.target.value })}
              />
            </Field>
          </div>
          {value.roots.map((root, index) => (
            <Field key={index} label={`Ownership root ${index + 1}`} hint="Existing absolute directory on the target. Path spelling and whitespace are preserved; the authority resolves aliases and overlapping scopes.">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  aria-label={`Ownership root ${index + 1}`}
                  className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={root}
                  onChange={(event) => onChange({ ...value, roots: value.roots.map((path, i) => i === index ? event.target.value : path) })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ownership root ${index + 1}`}
                  disabled={value.roots.length === 1}
                  onClick={() => onChange({ ...value, roots: value.roots.filter((_, i) => i !== index) })}
                >
                  Remove
                </Button>
              </div>
            </Field>
          ))}
          <Button type="button" className="self-start" variant="outline" size="sm"
            disabled={value.roots.length >= 32} onClick={() => onChange({ ...value, roots: [...value.roots, ""] })}>
            Add ownership root
          </Button>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}
