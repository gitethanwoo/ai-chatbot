'use client';

import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from './icons';

export interface ToolConfig {
  icon: React.ComponentType<{ size?: number }>;
  getAction: (toolType: string, state: 'input' | 'output') => string;
  formatParameters: (input: any, toolType: string) => string;
  getToolType: (toolCallId: string) => string;
  getResultSummary?: (output: any, input: any, toolType: string) => string;
}

interface UnifiedToolProps {
  toolCallId: string;
  state: 'input-available' | 'output-available';
  output?: any;
  input?: any;
  isReadonly?: boolean;
  config: ToolConfig;
}

export function UnifiedTool({
  toolCallId,
  state,
  output,
  input,
  isReadonly = false,
  config,
}: UnifiedToolProps) {
  const [showDetails, setShowDetails] = useState(false);

  const toolType = config.getToolType(toolCallId);
  const Icon = config.icon;

  // Check for errors
  const getError = () => {
    if (!output) return null;

    try {
      if (typeof output === 'object' && 'error' in output) {
        return String(output.error);
      }
      if (typeof output === 'string') {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          return String(parsed.error);
        }
      }
    } catch {
      // If parsing fails, no error
    }
    return null;
  };

  const error = state === 'output-available' ? getError() : null;

  if (error) {
    return (
      <div className="text-red-500 p-2 border rounded">Error: {error}</div>
    );
  }

  const params = config.formatParameters(input, toolType);
  const actionText = config.getAction(
    toolType,
    state === 'input-available' ? 'input' : 'output',
  );
  const resultSummary =
    state === 'output-available' && config.getResultSummary
      ? config.getResultSummary(output, input, toolType)
      : '';

  const handleToggle = () => {
    if (input || output) {
      setShowDetails(!showDetails);
    }
  };

  return (
    <div className="border-b border-muted">
      <button
        type="button"
        className={`flex items-center justify-between w-full text-left px-2 py-5 rounded transition-colors ${input || output ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default'}`}
        onClick={handleToggle}
        aria-label={showDetails ? 'Hide details' : 'Show details'}
      >
        <div className="text-sm flex items-center gap-2">
          <Icon size={16} />
          {actionText} {params} {resultSummary}
        </div>

        {(input || output) && (
          <div className="text-muted-foreground">
            {showDetails ? (
              <ChevronDownIcon size={16} />
            ) : (
              <ChevronRightIcon size={16} />
            )}
          </div>
        )}
      </button>

      {showDetails && (
        <div className="mt-3 space-y-3 text-xs">
          {input && (
            <div>
              <div className="font-medium text-muted-foreground mb-1">
                Query Parameters:
              </div>
              <pre className="bg-muted p-2 rounded text-xs overflow-x-auto">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}

          {output && state === 'output-available' && (
            <div>
              <div className="font-medium text-muted-foreground mb-1">
                Raw Output:
              </div>
              <pre className="bg-muted p-2 rounded text-xs overflow-auto max-h-40">
                {typeof output === 'string'
                  ? output
                  : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
