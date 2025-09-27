import { PreviewMessage, ThinkingMessage, AgentThinkingMessage } from './message';
import { Greeting } from './greeting';
import { memo, useEffect, useMemo } from 'react';
import type { Vote } from '@/lib/db/schema';
import equal from 'fast-deep-equal';
import type { UseChatHelpers } from '@ai-sdk/react';
import { useMessages } from '@/hooks/use-messages';
import type { ChatMessage } from '@/lib/types';
import { useDataStream } from './data-stream-provider';
import { Conversation, ConversationContent } from './elements/conversation';
import { ArrowDownIcon } from 'lucide-react';
import { parseAgentResponseText } from '@/lib/agents/mentions';

interface MessagesProps {
  chatId: string;
  status: UseChatHelpers<ChatMessage>['status'];
  votes: Array<Vote> | undefined;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>['setMessages'];
  regenerate: UseChatHelpers<ChatMessage>['regenerate'];
  isReadonly: boolean;
  isArtifactVisible: boolean;
  reasoningEffort: 'low' | 'medium' | 'high';
}

function PureMessages({
  chatId,
  status,
  votes,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  isArtifactVisible,
  reasoningEffort,
}: MessagesProps) {
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    scrollToBottom,
    hasSentMessage,
  } = useMessages({
    chatId,
    status,
  });
  const { dataStream } = useDataStream();

  const pendingAgentStatuses = useMemo(() => {
    const map = new Map<
      string,
      { slug: string; agentName?: string; status: string }
    >();

    dataStream.forEach((part) => {
      if (part.type === 'data-agent-status') {
        const payload = part.data as {
          slug?: string;
          status?: string;
          agentName?: string;
        };
        if (payload?.slug && payload.status) {
          map.set(payload.slug.toLowerCase(), {
            slug: payload.slug,
            agentName: payload.agentName,
            status: payload.status,
          });
        }
      }
    });

    messages.forEach((message) => {
      if (message.role !== 'assistant') return;
      const firstTextPart = message.parts.find((part) => part.type === 'text');
      const textValue =
        firstTextPart && typeof (firstTextPart as any).text === 'string'
          ? ((firstTextPart as any).text as string)
          : '';
      const parsed = parseAgentResponseText(textValue);
      if (parsed) {
        map.delete(parsed.slug.toLowerCase());
      }
    });

    return Array.from(map.values()).filter((entry) => entry.status === 'started');
  }, [dataStream, messages]);

  useEffect(() => {
    if (status === 'submitted') {
      requestAnimationFrame(() => {
        const container = messagesContainerRef.current;
        if (container) {
          container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth',
          });
        }
      });
    }
  }, [status, messagesContainerRef]);

  return (
    <div
      ref={messagesContainerRef}
      className="overflow-y-scroll flex-1 touch-pan-y overscroll-behavior-contain -webkit-overflow-scrolling-touch"
      style={{ overflowAnchor: 'none' }}
    >
      <Conversation className="flex flex-col gap-4 px-2 py-4 mx-auto min-w-0 max-w-4xl md:gap-6 md:px-4">
        <ConversationContent className="flex flex-col gap-4 md:gap-6">
          {messages.length === 0 && <Greeting />}

          {messages.map((message, index) => (
            <PreviewMessage
              key={message.id}
              chatId={chatId}
              message={message}
              isLoading={
                status === 'streaming' && messages.length - 1 === index
              }
              vote={
                votes
                  ? votes.find((vote) => vote.messageId === message.id)
                  : undefined
              }
              setMessages={setMessages}
              regenerate={regenerate}
              isReadonly={isReadonly}
              requiresScrollPadding={
                hasSentMessage && index === messages.length - 1
              }
              isArtifactVisible={isArtifactVisible}
            />
          ))}

          {pendingAgentStatuses.map((statusEntry) => (
            <AgentThinkingMessage
              key={`agent-pending-${statusEntry.slug}`}
              slug={statusEntry.slug}
              agentName={statusEntry.agentName}
            />
          ))}

          {status === 'submitted' &&
            messages.length > 0 &&
            messages[messages.length - 1].role === 'user' && (
              <ThinkingMessage />
            )}

          <div
            ref={messagesEndRef}
            className="shrink-0 min-w-[24px] min-h-[24px]"
          />
        </ConversationContent>
      </Conversation>

      {!isAtBottom && (
        <button
          className="absolute bottom-40 left-1/2 z-10 p-2 rounded-full border shadow-lg transition-colors -translate-x-1/2 bg-background hover:bg-muted"
          onClick={() => scrollToBottom('smooth')}
          type="button"
          aria-label="Scroll to bottom"
        >
          <ArrowDownIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

export const Messages = memo(PureMessages, (prevProps, nextProps) => {
  if (prevProps.isArtifactVisible && nextProps.isArtifactVisible) return true;

  if (prevProps.status !== nextProps.status) return false;
  if (prevProps.messages.length !== nextProps.messages.length) return false;
  if (!equal(prevProps.messages, nextProps.messages)) return false;
  if (!equal(prevProps.votes, nextProps.votes)) return false;

  return false;
});
