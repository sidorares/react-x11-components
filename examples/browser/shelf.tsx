// What the browser has saved, along the bottom of its window: a page's
// downloads as they go, drawn here because a tab's process has nothing it can
// draw outside its pane.
import type { ReactElement } from 'react';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { Button, ProgressBar } from 'react-x11';

import type { DownloadState } from './downloads.js';

/** A size, as a person reads one. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** The file in the machine's file manager. */
function showInFolder(path: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', path]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${path}`]]
        : ['xdg-open', [dirname(path)]];
  spawn(command, args as string[], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function statusOf(item: DownloadState): string {
  if (item.state === 'done') return sizeOf(item.received);
  if (item.state === 'cancelled') return 'Cancelled';
  if (item.state === 'failed') return item.error ?? 'Failed';
  return item.size
    ? `${sizeOf(item.received)} of ${sizeOf(item.size)}`
    : sizeOf(item.received);
}

/** One line of what is saved and saving: nothing at all until there is
 *  something, so that a browser that downloads nothing has no shelf. */
export function DownloadShelf({
  downloads,
  onCancel,
  onDismiss,
}: {
  downloads: readonly DownloadState[];
  onCancel(id: string): void;
  onDismiss(id: string): void;
}): ReactElement | null {
  if (!downloads.length) return null;
  return (
    <box
      role="status"
      aria-label="Downloads"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        backgroundColor: '$surfaceHover',
        borderTopWidth: 1,
        borderTopColor: '$border',
        overflow: 'hidden',
      }}
    >
      {downloads.map((item) => (
        <box
          key={item.id}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <box style={{ flexDirection: 'column', maxWidth: 220 }}>
            <text style={{ textWrap: 'nowrap', textOverflow: 'ellipsis' }}>
              {item.name}
            </text>
            <text
              style={{
                color: '$textMuted',
                fontSize: 11,
                textWrap: 'nowrap',
                textOverflow: 'ellipsis',
              }}
            >
              {statusOf(item)}
            </text>
          </box>
          {item.state === 'running' ? (
            <>
              <box style={{ width: 80 }}>
                <ProgressBar
                  value={item.size ? item.received / item.size : undefined}
                />
              </box>
              <Button
                variant="ghost"
                size="small"
                onPress={() => onCancel(item.id)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              {item.path ? (
                <Button
                  variant="ghost"
                  size="small"
                  onPress={() => showInFolder(item.path!)}
                >
                  Show in Folder
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="small"
                aria-label={`Dismiss ${item.name}`}
                onPress={() => onDismiss(item.id)}
              >
                ×
              </Button>
            </>
          )}
        </box>
      ))}
    </box>
  );
}
