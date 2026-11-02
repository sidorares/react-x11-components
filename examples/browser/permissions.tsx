// What a page has been allowed, as this browser keeps it: the questions it can
// put to its user, and the bar it puts them in.
//
// A page's process cannot put a question: a pane draws the page and nothing
// around it. So `page.tsx` asks through a prop, the bar goes up here in the
// browser's window, and the answer goes back the same way and into the profile
// (`HtmlProfile.permissions`), which every tab's process reads for itself.
import type { ReactElement } from 'react';
import { Button } from 'react-x11';

import type { HtmlPermissionState } from '../../src/html/index.js';

/** What this browser can ask a user, in the words it asks them. Anything else
 *  is refused: there is no feature behind it to allow. */
export const QUESTIONS: Readonly<Record<string, string>> = {
  notifications: 'show notifications',
  'clipboard-read': 'see what you copied',
};

/** A page's question, waiting for its user. */
export interface PermissionAsk {
  tab: string;
  id: number;
  origin: string;
  name: string;
}

/** Where a permission stands where the user has said nothing. */
export function unanswered(name: string, origin: string): HtmlPermissionState {
  // an opaque origin has nothing to keep an answer under
  if (origin === 'null') return 'denied';
  if (name in QUESTIONS) return 'prompt';
  // a press is all a write of the clipboard needs (`clipboard.ts`)
  return name === 'clipboard-write' ? 'prompt' : 'denied';
}

/** An origin as a person reads it. */
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

/** The question at the top of the tab it is from. The origin is the browser's
 *  to say: nothing in this bar is the page's. */
export function PermissionBar({
  ask,
  onAnswer,
}: {
  ask: PermissionAsk;
  /** The user's answer, or null where they closed it and said nothing. */
  onAnswer(state: 'granted' | 'denied' | null): void;
}): ReactElement {
  return (
    <box
      role="alertdialog"
      aria-label="Permission request"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        backgroundColor: '$surfaceHover',
        borderBottomWidth: 1,
        borderBottomColor: '$border',
      }}
    >
      <box style={{ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
        <text
          style={{
            color: '$text',
            textWrap: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {`${hostOf(ask.origin)} wants to ${QUESTIONS[ask.name] ?? ask.name}`}
        </text>
      </box>
      <Button label="Allow" onPress={() => onAnswer('granted')} />
      <Button label="Block" onPress={() => onAnswer('denied')} />
      <box
        role="button"
        aria-label="Decide later"
        focusable
        onClick={() => onAnswer(null)}
        style={{ paddingLeft: 6, paddingRight: 6, cursor: 'pointer' }}
      >
        <text style={{ color: '$textMuted' }}>×</text>
      </box>
    </box>
  );
}
