'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SendIcon } from 'lucide-react';
import { generateUUID } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import type { Transcript } from './use-transcripts';
import BlurEffect from 'react-progressive-blur';

interface TranscriptChatInputProps {
  selectedTranscripts: Transcript[];
}

const extractTopic = (summary: string) => {
  if (!summary) return 'No summary available';

  // Look for "Topic:" followed by content
  const topicMatch = summary.match(/Topic:\s*([^\n]*)/i);
  if (topicMatch?.[1]) {
    const topic = topicMatch[1].trim();
    // Truncate if too long and add "cut off" indicator
    if (topic.length > 80) {
      return `${topic.substring(0, 77)}...`;
    }
    return topic;
  }

  // Fallback to first line if no "Topic:" found
  const firstLine = summary.split('\n')[0].trim();
  if (firstLine.length > 80) {
    return `${firstLine.substring(0, 77)}...`;
  }
  return firstLine || 'No summary available';
};

export function TranscriptChatInput({
  selectedTranscripts,
}: TranscriptChatInputProps) {
  const router = useRouter();
  const [chatQuery, setChatQuery] = useState('');
  const [isCreatingChat, setIsCreatingChat] = useState(false);

  const handleChatWithTranscripts = async () => {
    if (selectedTranscripts.length === 0 || !chatQuery.trim() || isCreatingChat)
      return;

    setIsCreatingChat(true);
    try {
      const chatId = generateUUID();

      // Fetch full cleaned transcript content for each selected transcript
      const transcriptContents = await Promise.all(
        selectedTranscripts.map(async (transcript) => {
          try {
            const res = await fetch(`/api/transcripts/${transcript.id}`);
            if (!res.ok) {
              throw new Error('Failed to fetch transcript content');
            }
            const data: { id: number; content: string | null } =
              await res.json();
            return data.content ?? '';
          } catch (err) {
            console.error(`Error fetching transcript ${transcript.id}:`, err);
            return '';
          }
        }),
      );

      // Build a single context string combining metadata and full content
      const transcriptContext = selectedTranscripts
        .map((transcript, idx) => {
          const topic = extractTopic(transcript.summary);
          const date = new Date(
            transcript.recording_start,
          ).toLocaleDateString();
          const time = new Date(transcript.recording_start).toLocaleTimeString(
            'en-US',
            {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            },
          );

          const fullContent = transcriptContents[idx];

          return `**Meeting: ${topic}**\nDate: ${date} at ${time}\n\nType: ${transcript.meeting_type}\nFull Transcript:\n${fullContent}`;
        })
        .join('\n\n---\n\n');

      const messageParts = [
        {
          // Distinguish transcript data from user query
          type: 'text',
          text: transcriptContext,
        },
        {
          type: 'text',
          text: chatQuery.trim(),
        },
      ];

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: chatId,
          message: {
            id: generateUUID(),
            role: 'user',
            parts: messageParts,
          },
          selectedChatModel: 'chat-model',
          selectedVisibilityType: 'private',
        }),
      });

      if (response.ok) {
        router.push(`/chat/${chatId}`);
      } else {
        throw new Error('Failed to create chat');
      }
    } catch (error) {
      console.error('Error creating chat:', error);
    } finally {
      setIsCreatingChat(false);
    }
  };

  if (selectedTranscripts.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-0 inset-x-0 md:left-64 z-50">
      {/* Progressive blur effect at the bottom */}
      <BlurEffect
        className="h-48 bg-gradient-to-t from-background via-background/80 to-transparent"
        position="bottom"
        intensity={100}
      />

      {/* Chat input container */}
      <div className="absolute bottom-0 inset-x-0 flex justify-center px-4 pb-6 pt-8 z-10">
        <div className="bg-background/95 backdrop-blur-md border border-border/50 shadow-2xl rounded-3xl overflow-hidden w-full max-w-4xl">
          <div className="mb-4">
            <Input
              placeholder={`Message about ${selectedTranscripts.length} meeting${
                selectedTranscripts.length > 1 ? 's' : ''
              }...`}
              value={chatQuery}
              onChange={(e) => setChatQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleChatWithTranscripts();
                }
              }}
              disabled={isCreatingChat}
              className="text-base h-12 px-4 border-0 bg-transparent !ring-0 !outline-none focus:!ring-0 focus:!outline-none resize-none w-full"
              style={{
                boxShadow: 'none',
              }}
            />
          </div>
          <div className="px-4 pb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {selectedTranscripts.length} meeting
              {selectedTranscripts.length > 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded">↵</kbd>
                to send
              </span>
              <Button
                onClick={handleChatWithTranscripts}
                disabled={!chatQuery.trim() || isCreatingChat}
                size="sm"
                className="size-6 p-0 rounded-md bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
              >
                {isCreatingChat ? (
                  <div className="animate-spin rounded-full size-3 border-b-2 border-current" />
                ) : (
                  <SendIcon className="size-3" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
