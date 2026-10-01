import { z } from "zod";
import raw from "./presets.json";

/**
 * Camera presets, loaded from JSON and validated at import.
 *
 * The zod parse is the point. A typo in a preset file fails at boot with a
 * message naming the field, instead of silently dropping that entry from the
 * picker and leaving the user wondering why "Rack Focus" is missing.
 */
export const presetSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase kebab-case"),
  name: z.string().min(1).max(60),
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(300),
  promptFragment: z.string().min(1).max(500),
  negativeFragment: z.string().max(500).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "accent must be a 6-digit hex colour")
    .optional(),
});

export const presetsFileSchema = z.object({
  presets: z.array(presetSchema).min(1),
});

export type Preset = z.infer<typeof presetSchema>;

const parsed = presetsFileSchema.safeParse(raw);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  throw new Error(`src/lib/presets.json is invalid -> ${detail}`);
}

export const presets: Preset[] = parsed.data.presets;

const bySlug = new Map(presets.map((p) => [p.slug, p]));

export function getPreset(slug: string | null | undefined): Preset | undefined {
  return slug ? bySlug.get(slug) : undefined;
}

/** Distinct categories in file order, for grouping the picker. */
export function presetCategories(): string[] {
  return [...new Set(presets.map((p) => p.category))];
}