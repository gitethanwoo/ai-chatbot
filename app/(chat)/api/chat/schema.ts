import { z } from 'zod/v4';
import { chatModels, type ChatModelId } from '@/lib/ai/models';

const chatModelIds = chatModels.map((model) => model.id) as [
  ChatModelId,
  ...ChatModelId[],
];
const chatModelIdSchema = z.enum(chatModelIds);

const textPartSchema = z.object({
  type: z.enum(['text']),
  text: z.string().min(1).max(200000), // Increased to 500k to support full transcript content
});

const filePartSchema = z.object({
  type: z.enum(['file']),
  mediaType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  name: z.string().min(1).max(100),
  url: z.string().url(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

const agentMentionSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][\w-]{0,63}$/i),
  prompt: z.string().max(200000).default(''),
});

export const postRequestBodySchema = z.object({
  id: z.string().uuid(),
  message: z.object({
    id: z.string().uuid(),
    role: z.enum(['user']),
    parts: z.array(partSchema),
  }),
  reasoningEffort: z.enum(['low', 'medium', 'high']),
  selectedVisibilityType: z.enum(['public', 'private']),
  selectedChatModel: chatModelIdSchema.optional(),
  agentSlug: z.string().optional(),
  agentContext: z
    .object({
      agentName: z.string().min(1),
      agentDescription: z.string().optional(),
      agentPrompt: z.string().optional(),
    })
    .optional(),
  activeTools: z.array(z.string()).optional(),
  agentVectorStoreId: z.string().min(1).optional(),
  agentMentions: z.array(agentMentionSchema).optional(),
  rawInput: z.string().max(200000).optional(),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
