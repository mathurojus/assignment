import { z } from "zod";

/** POST /api/v1/images */
export const imageGenerateBody = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  n: z.number().int().min(1).max(10).optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  output_format: z.string().optional(),
  background: z.string().optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  seed: z.number().int().optional(),
  stream: z.boolean().optional(),
  input_references: z
    .array(
      z.object({
        type: z.literal("image_url"),
        image_url: z.object({
          url: z.string().url(),
        }),
      }),
    )
    .optional(),
  user: z.string().optional(),
  provider: z
    .object({
      only: z.array(z.string()).optional(),
      order: z.array(z.string()).optional(),
      ignore: z.array(z.string()).optional(),
      sort: z.union([z.string(), z.object({}).passthrough()]).optional(),
      allow_fallbacks: z.boolean().optional(),
      options: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
});

/** POST /api/v1/videos */
export const videoGenerateBody = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  duration: z.number().int().min(1).max(30).optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
  frame_images: z
    .array(
      z.object({
        type: z.literal("image_url"),
        image_url: z.object({
          url: z.string().url(),
        }),
        frame_type: z.enum(["first_frame", "last_frame"]),
      }),
    )
    .optional(),
  input_references: z
    .array(
      z.object({
        type: z.literal("image_url"),
        image_url: z.object({
          url: z.string().url(),
        }),
      }),
    )
    .optional(),
  generate_audio: z.boolean().optional(),
  seed: z.number().int().optional(),
  callback_url: z.string().url().optional(),
  provider: z
    .object({
      options: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
});
