import {
  convertToModelMessages,
  createUIMessageStream,
  generateText,
  JsonToSseTransformStream,
  type LanguageModelUsage,
  smoothStream,
  stepCountIs,
  streamText,
  validateUIMessages,
} from 'ai';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  DEFAULT_CHAT_MODEL,
  getChatModelById,
  resolveProviderModelId,
} from '@/lib/ai/models';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getDatabaseUserFromWorkOS,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatLastContextById,
  getAgentWithUserState,
  getAgentBySlug,
  getVectorStoreFilesByUser,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID, getTextFromMessage } from '@/lib/utils';
import type { DBMessage } from '@/lib/db/schema';
import { generateTitleFromUserMessage } from '../../actions';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { searchTranscriptsByKeyword } from '@/lib/ai/tools/search-transcripts-by-keyword';
import { searchTranscriptsByUser } from '@/lib/ai/tools/search-transcripts-by-user';
import { getTranscriptDetails } from '@/lib/ai/tools/get-transcript-details';
import { listAccessibleSlackChannels } from '@/lib/ai/tools/list-accessible-slack-channels';
import { fetchSlackChannelHistory } from '@/lib/ai/tools/fetch-slack-channel-history';
import { getSlackThreadReplies } from '@/lib/ai/tools/get-slack-thread-replies';
import { getBulkSlackHistory } from '@/lib/ai/tools/get-bulk-slack-history';
import { listGoogleCalendarEvents } from '@/lib/ai/tools/list-google-calendar-events';
import { listGmailMessages } from '@/lib/ai/tools/list-gmail-messages';
import { getGmailMessageDetails } from '@/lib/ai/tools/get-gmail-message-details';
import { getFileContents } from '@/lib/ai/tools/get-file-contents';
// Note: Mem0 tool definitions are intentionally not imported here to avoid
// exposing them to the LLM tool registry. Definitions remain available under
// `lib/ai/tools/*mem0*` and `lib/mem0/*` for future re‑enablement.
import {
  isProductionEnvironment,
  isDevelopmentEnvironment,
} from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { AgentMention, ChatMessage } from '@/lib/types';
import type { VisibilityType } from '@/components/visibility-selector';
import { openai, type OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import type { SharedV2ProviderOptions } from '@ai-sdk/provider';

export const maxDuration = 800; // This function can run for a maximum of 5 seconds

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

function createToolRegistry({
  dataStream,
  aiToolsSession,
  userId,
  vectorStoreId,
  providerNamespace,
  includeTranscriptDetails,
}: {
  dataStream: any;
  aiToolsSession: any;
  userId: string;
  vectorStoreId?: string;
  providerNamespace: string;
  includeTranscriptDetails: boolean;
}) {
  const tools: Record<string, any> = {
    requestSuggestions: requestSuggestions({
      session: aiToolsSession,
      dataStream,
    }),
    searchTranscriptsByKeyword: searchTranscriptsByKeyword({
      session: aiToolsSession,
      dataStream,
    }),
    searchTranscriptsByUser: searchTranscriptsByUser({
      session: aiToolsSession,
      dataStream,
    }),
    listAccessibleSlackChannels: listAccessibleSlackChannels({
      session: aiToolsSession,
      dataStream,
    }),
    fetchSlackChannelHistory: fetchSlackChannelHistory({
      session: aiToolsSession,
      dataStream,
    }),
    getSlackThreadReplies: getSlackThreadReplies({
      session: aiToolsSession,
      dataStream,
    }),
    getBulkSlackHistory: getBulkSlackHistory({
      session: aiToolsSession,
      dataStream,
    }),
    listGoogleCalendarEvents: listGoogleCalendarEvents({
      session: aiToolsSession,
      dataStream,
    }),
    listGmailMessages: listGmailMessages({
      session: aiToolsSession,
      dataStream,
    }),
    getGmailMessageDetails: getGmailMessageDetails({
      session: aiToolsSession,
      dataStream,
    }),
  };

  const nonConfigurableToolIds = new Set<string>();
  let fileSearchRegistered = false;

  if (providerNamespace === 'openai' && vectorStoreId) {
    tools.file_search = openai.tools.fileSearch({
      vectorStoreIds: [vectorStoreId],
    });
    fileSearchRegistered = true;
  }

  tools.get_file_contents = getFileContents({
    session: aiToolsSession,
    userId,
    vectorStoreId: vectorStoreId ?? '',
  });

  if (vectorStoreId) {
    nonConfigurableToolIds.add('get_file_contents');
    if (fileSearchRegistered) {
      nonConfigurableToolIds.add('file_search');
    }
  }

  if (includeTranscriptDetails) {
    tools.getTranscriptDetails = getTranscriptDetails({
      session: aiToolsSession,
      dataStream,
    });
  }

  return { tools, nonConfigurableToolIds, fileSearchRegistered };
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    if (isDevelopmentEnvironment) {
      console.error('🚨 Request parsing error:', {
        error,
        message: (error as Error)?.message,
        stack: (error as Error)?.stack,
        name: (error as Error)?.name,
        timestamp: new Date().toISOString(),
        url: request.url,
        method: request.method,
      });
    }
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    if (isDevelopmentEnvironment) {
      console.log('🧪 Processing chat request:', {
        requestBody: {
          id: requestBody.id,
          messageId: requestBody.message?.id,
          agentSlug: requestBody.agentSlug,
          selectedVisibilityType: requestBody.selectedVisibilityType,
          activeTools: requestBody.activeTools,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const {
      id,
      message,
      reasoningEffort,
      selectedVisibilityType,
      selectedChatModel: requestedChatModel,
      agentSlug,
      agentContext: previewAgentContext,
      activeTools: requestedActiveTools,
      agentVectorStoreId,
      agentMentions,
      rawInput,
    }: {
      id: string;
      message: ChatMessage;
      reasoningEffort: 'low' | 'medium' | 'high';
      selectedVisibilityType: VisibilityType;
      selectedChatModel?: string;
      agentSlug?: string;
      agentContext?: {
        agentName: string;
        agentDescription?: string;
        agentPrompt?: string;
      };
      activeTools?: Array<string>;
      agentVectorStoreId?: string;
      agentMentions?: Array<AgentMention>;
      rawInput?: string;
    } = requestBody;

    const session = await withAuth();

    if (!session?.user) {
      if (isDevelopmentEnvironment) {
        console.error('🚨 Authentication failed:', {
          hasSession: !!session,
          hasUser: !!session?.user,
          timestamp: new Date().toISOString(),
        });
      }
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    // Get the database user from the WorkOS user
    const databaseUser = await getDatabaseUserFromWorkOS({
      id: session.user.id,
      email: session.user.email,
      firstName: session.user.firstName ?? undefined,
      lastName: session.user.lastName ?? undefined,
    });

    if (!databaseUser) {
      if (isDevelopmentEnvironment) {
        console.error('🚨 Database user not found:', {
          workOSUserId: session.user.id,
          email: session.user.email,
          timestamp: new Date().toISOString(),
        });
      }
      return new ChatSDKError(
        'unauthorized:chat',
        'User not found',
      ).toResponse();
    }

    // Fetch agent data if agentSlug provided; otherwise allow preview agent context passthrough
    let agentContext = null as
      | (Awaited<ReturnType<typeof getAgentWithUserState>> | null)
      | null;
    if (agentSlug) {
      const agentData = await getAgentWithUserState({
        slug: agentSlug,
        userId: databaseUser.id,
      });
      agentContext = agentData;
    }

    const chat = await getChatById({ id });

    // Debug: confirm preview agent context is received
    if (!agentSlug && previewAgentContext) {
      console.log('🧪 Preview agentContext received:', {
        hasName: !!previewAgentContext.agentName,
        hasPrompt: !!previewAgentContext.agentPrompt,
      });
    }

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: databaseUser.id,
        title,
        visibility: selectedVisibilityType,
        agentId: agentContext?.agent?.id,
      });
    } else {
      if (chat.userId !== databaseUser.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const normalizedAgentMentions = Array.isArray(agentMentions)
      ? agentMentions
          .map((mention) => ({
            slug: mention.slug.toLowerCase(),
            prompt: mention.prompt ?? '',
          }))
          .filter((mention) => mention.slug.length > 0)
      : [];

    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];

    const latestUserText = getTextFromMessage(message);
    const reconstructedUserInput = rawInput
      ? rawInput
      : [latestUserText, ...normalizedAgentMentions.map((mention) =>
            mention.prompt
              ? `Instruction for @${mention.slug}: ${mention.prompt}`
              : `Reference to @${mention.slug}`,
          )]
          .filter(Boolean)
          .join(`\n\n`);

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
      email: session.user.email,
      name:
        session.user.firstName && session.user.lastName
          ? `${session.user.firstName} ${session.user.lastName}`
          : (session.user.firstName ?? undefined),
      date: new Date().toISOString(),
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });
    // Check role for tool availability
    const isMemberRole = session.role === 'member';
    console.log(
      `🔐 User ${session.user.email} role: ${session.role} (${isMemberRole ? 'MEMBER - limited access' : 'ELEVATED - full access'})`,
    );

    // Create session adapter for AI tools with database user ID
    const aiToolsSession = {
      user: {
        id: databaseUser.id, // Use database user ID instead of WorkOS user ID
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
      },
      role: session.role, // Move role to session level to match Session interface
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    } as any;

    let finalUsage: LanguageModelUsage | undefined;

    const resolvedVectorStoreId = agentSlug
      ? (agentContext?.agent?.vectorStoreId ?? undefined)
      : (agentVectorStoreId ?? undefined);

    const knowledgeFileMetadata = resolvedVectorStoreId
      ? await getVectorStoreFilesByUser({
          userId: databaseUser.id,
          vectorStoreId: resolvedVectorStoreId,
        })
      : [];

    const knowledgeFileSummaries = knowledgeFileMetadata.map((file) => ({
      id: file.vectorStoreFileId,
      name: file.fileName,
      sizeBytes: file.fileSizeBytes ?? null,
    }));

    const selectedChatModelId =
      getChatModelById(requestedChatModel ?? '')?.id ?? DEFAULT_CHAT_MODEL;
    const providerModelId = resolveProviderModelId(selectedChatModelId);
    const [providerNamespace] = providerModelId.split('/');
    const isOpenAIModel = providerNamespace === 'openai';
    const isXaiModel = providerNamespace === 'xai';

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const includeTranscriptDetails = !isMemberRole;
        if (includeTranscriptDetails) {
          console.log(
            `✅ Adding getTranscriptDetails tool for elevated role: ${session.role} (${session.user.email})`,
          );
        } else {
          console.log(
            `🚫 Excluding getTranscriptDetails tool for member role: ${session.user.email}`,
          );
        }

        const { tools, nonConfigurableToolIds, fileSearchRegistered } =
          createToolRegistry({
            dataStream,
            aiToolsSession,
            userId: databaseUser.id,
            vectorStoreId: resolvedVectorStoreId ?? undefined,
            providerNamespace,
            includeTranscriptDetails,
          });

        if (resolvedVectorStoreId) {
          if (fileSearchRegistered) {
            console.log(
              `🗂️ Enabling file_search tool for vector store ${resolvedVectorStoreId}`,
            );
          } else if (isXaiModel) {
            console.log(
              `🤖 Skipping OpenAI file_search tool for ${providerModelId}; using get_file_contents fallback only.`,
            );
          }
        }

        if (normalizedAgentMentions.length > 0) {
          const agentMessages = await handleAgentMentions({
            mentions: normalizedAgentMentions,
            chatId: id,
            userId: databaseUser.id,
            writer: dataStream,
            defaultModelId: selectedChatModelId,
            userMessage: reconstructedUserInput,
            requestHints,
            aiToolsSession,
            isMemberRole,
            requestedActiveTools,
            reasoningEffort,
          });

          if (agentMessages.length > 0) {
            uiMessages.push(...agentMessages);
          }
        }

        // 1) Validate the full UI history against your tool schemas
        const availableToolIds = Object.keys(tools);
        const requestedToolSet = new Set(
          requestedActiveTools !== undefined
            ? requestedActiveTools
            : availableToolIds,
        );

        const activeToolsForRun = availableToolIds.filter(
          (toolId) =>
            requestedToolSet.has(toolId) || nonConfigurableToolIds.has(toolId),
        );

        const validated = await validateUIMessages({
          messages: uiMessages,
          tools, // <= critical for typed tool parts when replaying history
        });

        // 2) Convert to model messages with the same tool registry
        const modelMessages = convertToModelMessages(validated, { tools });

        if (isDevelopmentEnvironment) {
          console.log(
            '🧪 Model messages:',
            JSON.stringify(modelMessages, null, 2),
          );
        }

        const providerOptions: SharedV2ProviderOptions = {};

        if (isOpenAIModel) {
          const openAIOptions: OpenAIResponsesProviderOptions = {
            reasoningEffort: reasoningEffort,
            reasoningSummary: 'auto',
            include: [
              'reasoning.encrypted_content',
              'file_search_call.results',
            ],
          };
          providerOptions.openai =
            openAIOptions as SharedV2ProviderOptions[string];
        }

        if (isXaiModel) {
          providerOptions.xai = {
            searchParameters: {
              mode: 'auto',
              returnCitations: true,
              maxSearchResults: 12,
            },
          } satisfies SharedV2ProviderOptions[string];
        }

        const promptAgentContext = agentSlug
          ? agentContext
            ? {
                agentPrompt: agentContext.agent.agentPrompt || '',
                agentName: agentContext.agent.name,
                knowledgeFiles: knowledgeFileSummaries,
              }
            : knowledgeFileSummaries.length > 0
              ? {
                  agentPrompt:
                    'Leverage the knowledge base files listed below to assist the user.',
                  agentName: 'Agent',
                  knowledgeFiles: knowledgeFileSummaries,
                }
              : undefined
          : previewAgentContext
            ? {
                agentPrompt: previewAgentContext.agentPrompt || '',
                agentName: previewAgentContext.agentName || 'Preview Agent',
                knowledgeFiles: knowledgeFileSummaries,
              }
            : knowledgeFileSummaries.length > 0
              ? {
                  agentPrompt:
                    'Leverage the knowledge base files listed below to assist the user.',
                  agentName: 'Preview Agent',
                  knowledgeFiles: knowledgeFileSummaries,
                }
              : undefined;

        const resolvedProviderOptions =
          Object.keys(providerOptions).length > 0 ? providerOptions : undefined;

        const result = streamText({
          model: myProvider.languageModel(selectedChatModelId),
          system: systemPrompt({
            selectedChatModel: selectedChatModelId,
            requestHints,
            agentContext: promptAgentContext,
          }),
          messages: modelMessages, // <= not UI parts anymore
          stopWhen: stepCountIs(50),
          activeTools: activeToolsForRun,
          experimental_transform: smoothStream({ chunking: 'word' }),
          tools: tools,
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
          providerOptions: resolvedProviderOptions,
          onFinish: ({ usage }) => {
            finalUsage = usage;
            dataStream.write({ type: 'data-usage', data: usage });
          },
        });

        if (isDevelopmentEnvironment) {
          console.log('🧪 Starting streamText execution...');
        }

        result.consumeStream();
        dataStream.merge(
          result.toUIMessageStream({
            sendReasoning: true,
            sendSources: true,
          }),
        );
      },
      generateId: generateUUID,
      onFinish: async ({ messages, responseMessage }) => {
        await saveMessages({
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            parts: m.parts,
            createdAt: new Date(),
            attachments: [],
            chatId: id,
          })),
        });

        if (finalUsage) {
          try {
            await updateChatLastContextById({
              chatId: id,
              context: finalUsage,
            });
          } catch (err) {
            console.warn('Unable to persist last usage for chat', id, err);
          }
        }
      },
      onError: (error) => {
        if (isDevelopmentEnvironment) {
          console.error('🚨 Error in chat API:', {
            error,
            message: (error as Error)?.message,
            stack: (error as Error)?.stack,
            name: (error as Error)?.name,
            cause: (error as any)?.cause,
            timestamp: new Date().toISOString(),
            chatId: id,
            userId: databaseUser.id,
          });
        } else {
          console.error('Error in chat API:', error);
        }
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    if (isDevelopmentEnvironment) {
      console.error('🚨 Unhandled error in chat API:', {
        error: error,
        message: (error as Error)?.message,
        stack: (error as Error)?.stack,
        name: (error as Error)?.name,
        cause: (error as any)?.cause,
        timestamp: new Date().toISOString(),
        requestBody: requestBody
          ? {
              id: requestBody.id,
              messageId: requestBody.message?.id,
              agentSlug: requestBody.agentSlug,
              selectedVisibilityType: requestBody.selectedVisibilityType,
            }
          : 'unknown',
      });
    } else {
      console.error('Unhandled error in chat API:', error);
    }
    return new ChatSDKError('offline:chat').toResponse();
  }
}

async function handleAgentMentions({
  mentions,
  chatId,
  userId,
  writer,
  defaultModelId,
  userMessage,
  requestHints,
  aiToolsSession,
  isMemberRole,
  requestedActiveTools,
  reasoningEffort,
}: {
  mentions: Array<AgentMention>;
  chatId: string;
  userId: string;
  writer: {
    write: (chunk: {
      type: string;
      data: unknown;
      transient?: boolean;
    }) => void;
  };
  defaultModelId: string;
  userMessage: string;
  requestHints: RequestHints;
  aiToolsSession: any;
  isMemberRole: boolean;
  requestedActiveTools?: Array<string>;
  reasoningEffort: 'low' | 'medium' | 'high';
}): Promise<Array<ChatMessage>> {
  if (!mentions.length) {
    return [];
  }

  const agentMessages: Array<ChatMessage> = [];
  const dbMessages: Array<DBMessage> = [];

  for (const mention of mentions) {
    const slug = mention.slug;
    const mentionPrompt = mention.prompt?.trim() ?? '';
    const now = new Date();
    const uiMessageId = generateUUID();

    let responseHeader = `@${slug}`;
    let responseBody = '';
    let agentName: string | undefined;
    let status: 'finished' | 'error' = 'finished';

    writer.write({
      type: 'data-agent-status',
      data: { slug, status: 'started' },
      transient: true,
    });

    try {
      const agentRecord = await getAgentBySlug({ slug });

      if (!agentRecord) {
        responseBody = `No agent named @${slug} is available.`;
      } else if (!agentRecord.isPublic && agentRecord.userId !== userId) {
        responseBody = `You do not have access to @${slug}. Ask the owner to make it public or share it with you.`;
      } else {
        agentName = agentRecord.name;
        responseHeader = `@${slug}${agentRecord.name ? ` (${agentRecord.name})` : ''}`;

        const resolvedModelId =
          getChatModelById(agentRecord.modelId ?? '')?.id ?? defaultModelId;
        const providerModelId = resolveProviderModelId(resolvedModelId);
        const [providerNamespace] = providerModelId.split('/');

        let knowledgeFiles: Array<{
          id: string;
          name: string;
          sizeBytes?: number | null;
        }> = [];

        const agentVectorStoreId =
          agentRecord.vectorStoreId && agentRecord.userId === userId
            ? agentRecord.vectorStoreId
            : undefined;

        if (agentVectorStoreId) {
          try {
            const files = await getVectorStoreFilesByUser({
              userId,
              vectorStoreId: agentVectorStoreId,
            });

            knowledgeFiles = files.map((file) => ({
              id: file.vectorStoreFileId,
              name: file.fileName,
              sizeBytes: file.fileSizeBytes ?? null,
            }));
          } catch (error) {
            console.warn('Unable to load vector store files for agent mention', {
              slug,
              userId,
              error,
            });
          }
        }

        const agentSystemPrompt = systemPrompt({
          selectedChatModel: resolvedModelId,
          requestHints,
          agentContext: {
            agentPrompt: agentRecord.agentPrompt ?? '',
            agentName: agentRecord.name,
            knowledgeFiles,
          },
        });

        const { tools: agentTools, nonConfigurableToolIds } = createToolRegistry({
          dataStream: writer,
          aiToolsSession,
          userId,
          vectorStoreId: agentVectorStoreId,
          providerNamespace,
          includeTranscriptDetails: !isMemberRole,
        });

        const availableToolIds = Object.keys(agentTools);
        const requestedToolSet = new Set(
          requestedActiveTools && requestedActiveTools.length > 0
            ? requestedActiveTools
            : availableToolIds,
        );

        let activeToolsForAgent = availableToolIds.filter(
          (toolId) =>
            requestedToolSet.has(toolId) || nonConfigurableToolIds.has(toolId),
        );

        if (activeToolsForAgent.length === 0) {
          activeToolsForAgent = availableToolIds;
        }

        const providerOptions: SharedV2ProviderOptions = {};

        if (providerNamespace === 'openai') {
          const openAIOptions: OpenAIResponsesProviderOptions = {
            reasoningEffort,
            reasoningSummary: 'auto',
            include: [
              'reasoning.encrypted_content',
              'file_search_call.results',
            ],
          };
          providerOptions.openai =
            openAIOptions as SharedV2ProviderOptions[string];
        }

        if (providerNamespace === 'xai') {
          providerOptions.xai = {
            searchParameters: {
              mode: 'auto',
              returnCitations: true,
              maxSearchResults: 12,
            },
          } satisfies SharedV2ProviderOptions[string];
        }

        const resolvedProviderOptions =
          Object.keys(providerOptions).length > 0 ? providerOptions : undefined;

        const instruction = buildAgentInstruction({
          userMessage,
          mentionPrompt,
          slug,
        });

        const { text } = await generateText({
          model: myProvider.languageModel(resolvedModelId),
          system: agentSystemPrompt,
          prompt: instruction,
          tools: agentTools,
          activeTools: activeToolsForAgent as Array<keyof typeof agentTools>,
          stopWhen: stepCountIs(20),
          providerOptions: resolvedProviderOptions,
        });

        responseBody = text.trim().length > 0 ? text.trim() : 'No response generated.';
      }
    } catch (error) {
      console.error('Failed to run agent mention', {
        chatId,
        slug,
        error,
      });
      responseBody = `Encountered an error while running @${slug}.`;
      status = 'error';
    }

    const textContent = `### Response from ${responseHeader}

${responseBody}`;

    const uiMessage: ChatMessage = {
      id: uiMessageId,
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text: textContent,
        },
      ],
      metadata: {
        createdAt: now.toISOString(),
      },
    };

    agentMessages.push(uiMessage);
    dbMessages.push({
      id: uiMessageId,
      chatId,
      role: 'assistant',
      parts: uiMessage.parts,
      attachments: [],
      createdAt: now,
    });

    writer.write({
      type: 'data-appendMessage',
      data: JSON.stringify(uiMessage),
    });

    writer.write({
      type: 'data-agent-status',
      data: {
        slug,
        status,
        messageId: uiMessageId,
        agentName,
      },
      transient: true,
    });
  }

  if (dbMessages.length > 0) {
    await saveMessages({ messages: dbMessages });
  }

  return agentMessages;
}

function buildAgentInstruction({
  userMessage,
  mentionPrompt,
  slug,
}: {
  userMessage: string;
  mentionPrompt: string;
  slug: string;
}) {
  const trimmedPrompt = mentionPrompt.trim();
  const segments: string[] = [];

  if (userMessage.trim().length > 0) {
    segments.push(`Full user message:
${userMessage.trim()}`);
  }

  if (trimmedPrompt.length > 0) {
    segments.push(`Focus on the instruction provided after @${slug}:
${trimmedPrompt}`);
  } else {
    segments.push(
      `The user referenced @${slug} without additional instructions. Provide a concise, helpful response based on the overall conversation context.`,
    );
  }

  return segments.join(`

`);
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await withAuth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  // Get the database user from the WorkOS user
  const databaseUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName ?? undefined,
    lastName: session.user.lastName ?? undefined,
  });

  if (!databaseUser) {
    return new ChatSDKError('unauthorized:chat', 'User not found').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
