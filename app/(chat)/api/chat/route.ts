import {
  convertToModelMessages,
  createUIMessageStream,
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
  getVectorStoreFilesByUser,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
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
import { after, NextResponse } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import { toNextResponse, toNativeResponse } from '@/lib/server/next-response';
import type { ChatMessage } from '@/lib/types';
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

async function handlePOST(request: Request) {
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
    return toNextResponse(new ChatSDKError('bad_request:api').toResponse());
  }

  try {
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
      return toNextResponse(
        new ChatSDKError('unauthorized:chat').toResponse(),
      );
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
      return toNextResponse(
        new ChatSDKError(
          'unauthorized:chat',
          'User not found',
        ).toResponse(),
      );
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
        return toNextResponse(new ChatSDKError('forbidden:chat').toResponse());
      }
    }

    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];

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
    const isMemberRole = session.role === 'member';

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
        // Build your tool set (the same set you pass to streamText)
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

        // Always register file_search + get_file_contents schemas so
        // validateUIMessages can handle prior tool parts in history.
        if (isOpenAIModel) {
          tools.file_search = openai.tools.fileSearch(
            resolvedVectorStoreId
              ? { vectorStoreIds: [resolvedVectorStoreId] }
              : { vectorStoreIds: [] },
          );
          fileSearchRegistered = true;
        }
        tools.get_file_contents = getFileContents({
          session: aiToolsSession,
          userId: databaseUser.id,
          // Empty string ensures execute() gracefully reports missing store
          vectorStoreId: resolvedVectorStoreId ?? '',
        });

        if (resolvedVectorStoreId) {
          if (fileSearchRegistered) {
            nonConfigurableToolIds.add('file_search');
          }
          nonConfigurableToolIds.add('get_file_contents');
        }

        // Add transcript details tool only for elevated roles (not members)
        if (!isMemberRole) {
          tools.getTranscriptDetails = getTranscriptDetails({
            session: aiToolsSession,
            dataStream,
          });
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
      return new NextResponse(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new NextResponse(
        stream.pipeThrough(new JsonToSseTransformStream()),
      );
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return toNextResponse(error.toResponse());
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
    return toNextResponse(new ChatSDKError('offline:chat').toResponse());
  }
}

async function handleDELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return toNextResponse(new ChatSDKError('bad_request:api').toResponse());
  }

  const session = await withAuth();

  if (!session?.user) {
    return toNextResponse(
      new ChatSDKError('unauthorized:chat').toResponse(),
    );
  }

  // Get the database user from the WorkOS user
  const databaseUser = await getDatabaseUserFromWorkOS({
    id: session.user.id,
    email: session.user.email,
    firstName: session.user.firstName ?? undefined,
    lastName: session.user.lastName ?? undefined,
  });

  if (!databaseUser) {
    return toNextResponse(
      new ChatSDKError('unauthorized:chat', 'User not found').toResponse(),
    );
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return toNextResponse(new ChatSDKError('forbidden:chat').toResponse());
  }

  const deletedChat = await deleteChatById({ id });

  return NextResponse.json(deletedChat, { status: 200 });
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  const response = await handlePOST(...args);
  return toNativeResponse(response);
}

export async function DELETE(...args: Parameters<typeof handleDELETE>) {
  const response = await handleDELETE(...args);
  return toNativeResponse(response);
}
