// A window a page opened: a `Page` of its own in a managed `<popup>`, which is
// a real window on every backend here, drawn by the process of the tab that
// opened it.
//
// That process is the point. A window with an opener shares its opener's
// realms, so it cannot be a tab, which is a process of its own: `<Html
// scripts>` links the two in one process (docs/prd-popups.md), and this is
// where that window is shown. A page that asks for no features gets one too,
// where Chrome gives it a tab, for the same reason. What has no opener —
// `noopener`, a plain `target=_blank` — is a tab, as it always was.
//
// The browser's own toolbar does not reach it, so it has what a popup has in
// any browser: the address it is at, which a user cannot edit, and every
// page's own keys and menu. What leaves it for a tab goes to the tab's browser
// through the props the tab's page was given.
import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';

import type { HtmlPopup, PostData } from '../../src/html/index.js';
import type { History, LinkTarget, LoadHow, PageProps } from './page.js';
import type { Command } from './keys.js';

/** The windows a tab's pages have open: each `Page` of the tab, and of its
 *  popups, adds to one, and the tab's draws them. */
export class PopupWindows {
  private _list: readonly HtmlPopup[] = [];
  private _heard = new Set<() => void>();

  /** The host's answer to a page: every window asked for is shown. */
  add = (popup: HtmlPopup): boolean => {
    this._list = [...this._list, popup];
    popup.onClose(() => {
      this._list = this._list.filter((other) => other !== popup);
      this._tell();
    });
    this._tell();
    return true;
  };

  list = (): readonly HtmlPopup[] => this._list;

  watch = (listener: () => void): (() => void) => {
    this._heard.add(listener);
    return () => this._heard.delete(listener);
  };

  private _tell(): void {
    for (const listener of [...this._heard]) listener();
  }
}

/** The address bar's height, on top of what the page asked for. */
const BAR = 28;
/** A window that names no size or place of its own. */
const WIDTH = 980;
const HEIGHT = 700;
const LEFT = 140;
const TOP = 100;

interface Loading {
  seq: number;
  url: string;
  how: LoadHow;
  key: string;
  post: PostData | null;
  fresh: boolean;
}

export function PopupWindow(props: {
  popup: HtmlPopup;
  /** The props of the tab's page, for what is the tab's in here too. */
  page: PageProps;
  windows: PopupWindows;
  Page: ComponentType<PageProps>;
}): ReactElement {
  const { popup, page, windows, Page } = props;
  const count = useRef(0);
  const [loading, setLoading] = useState<Loading | null>(null);
  const [step, setStep] = useState({ seq: 0, delta: 0 });
  const [title, setTitle] = useState<string | null>(null);
  const [address, setAddress] = useState(popup.url);
  const history = useRef<History | null>(null);

  const go = (
    url: string,
    how: LoadHow,
    post: PostData | null = null,
    key = '',
    fresh = false,
  ) => {
    count.current += 1;
    setAddress(url);
    setLoading({ seq: count.current, url, how, key, post, fresh });
  };

  // it opened at `about:blank`, which `<Html scripts>` made as `window.open`
  // was called, and goes where it was asked to as it is mounted
  useEffect(() => {
    if (popup.url === 'about:blank') return;
    const form = popup.post;
    go(
      popup.url,
      'push',
      form ? { ...form, from: popup.referrer ?? popup.url } : null,
    );
  }, []);

  const pane = useRef<{ raise?: () => void } | null>(null);
  useEffect(() => popup.onFocus(() => pane.current?.raise?.()), []);

  const reload = (fresh: boolean) => {
    const entries = history.current;
    const entry = entries?.entries[entries.index];
    if (entry) go(entry.url, 'reload', null, entry.key, fresh);
  };
  const onCommand = (command: Command) => {
    if (command === 'closeTab') popup.close();
    else if (command === 'reload') reload(false);
    else if (command === 'reloadFresh') reload(true);
    else if (command === 'back' || command === 'forward') {
      setStep((was) => ({
        seq: was.seq + 1,
        delta: command === 'back' ? -1 : 1,
      }));
    } else page.onCommand(command);
  };

  const left = popup.features.left ?? LEFT;
  const top = popup.features.top ?? TOP;
  const width = popup.features.width ?? WIDTH;
  const height = popup.features.height ?? HEIGHT;
  return (
    <popup
      ref={(node: unknown) => {
        const held = node as { window?: { raise?: () => void } } | null;
        pane.current = held?.window ?? null;
      }}
      x={left}
      y={top}
      width={width}
      height={height + BAR}
      overrideRedirect={false}
      title={title ?? address}
      onCloseRequest={() => popup.close()}
      style={{ flexDirection: 'column', backgroundColor: '$background' }}
    >
      <box
        style={{
          height: BAR,
          flexShrink: 0,
          justifyContent: 'center',
          paddingLeft: 10,
          paddingRight: 10,
          borderBottomWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        <text
          style={{
            fontSize: 12,
            color: '$textMuted',
            maxLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {address}
        </text>
      </box>
      <Page
        {...page}
        popup={popup}
        windows={windows}
        loadSeq={loading?.seq ?? 0}
        loadUrl={loading?.url ?? ''}
        loadHow={loading?.how ?? 'push'}
        loadKey={loading?.key ?? ''}
        loadFresh={loading?.fresh ?? false}
        loadPost={loading?.post ?? null}
        stepSeq={step.seq}
        stepDelta={step.delta}
        stepUrl=""
        history=""
        zoom={1}
        devtools={false}
        onDevtools={() => {}}
        onCommit={(_seq, _url, stated) => setTitle(stated)}
        onFinish={(seq) => setLoading((was) => (was?.seq === seq ? null : was))}
        onHistory={(json) => {
          const told = JSON.parse(json) as History;
          history.current = told;
          const url = told.entries[told.index]?.url;
          if (url) setAddress(url);
        }}
        onMeta={(_doc, stated) => {
          if (stated !== undefined) setTitle(stated);
        }}
        onLink={(url: string, target: LinkTarget, post: PostData | null) => {
          if (target === 'here') go(url, 'page', post);
          else page.onLink(url, target, post);
        }}
        onLoad={(url, how, key) => go(url, how, null, key)}
        onCommand={onCommand}
        onBringForward={() => pane.current?.raise?.()}
      />
    </popup>
  );
}
