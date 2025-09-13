'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  FileTextIcon, 
  CopyIcon,
  ChevronDownIcon,
  ChevronUpIcon
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

interface AgentPromptCardProps {
  agentPrompt: string;
  showTitle?: boolean;
  /** Number of lines to show when collapsed (defaults to 8) */
  collapsedLines?: number;
  /** Character length that triggers truncation (defaults to 500) */
  longCharThreshold?: number;
  /** Line count that triggers truncation (defaults to 8) */
  longLineThreshold?: number;
}

export function AgentPromptCard({
  agentPrompt,
  showTitle = true,
  collapsedLines = 8,
  longCharThreshold = 500,
  longLineThreshold = 8,
}: AgentPromptCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const totalLines = agentPrompt.split('\n');
  const isLong = agentPrompt.length > longCharThreshold || totalLines.length > longLineThreshold;
  const displayText = !isExpanded && isLong
    ? totalLines.slice(0, collapsedLines).join('\n') + (totalLines.length > collapsedLines ? '\n...' : '...')
    : agentPrompt;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt);
      toast.success('Agent prompt copied to clipboard');
    } catch (error) {
      toast.error('Failed to copy prompt');
    }
  };

  if (!showTitle) {
    return (
      <div className="space-y-3">
        <div className="bg-muted/50 rounded-lg p-4 border">
          <pre className="font-mono text-sm whitespace-pre-wrap text-foreground leading-relaxed">
            {displayText}
          </pre>
        </div>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={copyToClipboard} className="flex items-center gap-2">
            <CopyIcon className="size-4" />
            Copy
          </Button>

          {isLong && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-2"
            >
              {isExpanded ? (
                <>
                  <ChevronUpIcon className="size-4" />
                  Show Less
                </>
              ) : (
                <>
                  <ChevronDownIcon className="size-4" />
                  Show More
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <FileTextIcon className="size-5" />
            Agent Prompt
          </CardTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={copyToClipboard}>
                <CopyIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy prompt to clipboard</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <div className="bg-muted/50 rounded-lg p-4 border">
            <pre className="font-mono text-sm whitespace-pre-wrap text-foreground leading-relaxed">
              {displayText}
            </pre>
          </div>

          {isLong && (
            <div className="flex justify-center mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-2"
              >
                {isExpanded ? (
                  <>
                    <ChevronUpIcon className="size-4" />
                    Show Less
                  </>
                ) : (
                  <>
                    <ChevronDownIcon className="size-4" />
                    Show More
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}