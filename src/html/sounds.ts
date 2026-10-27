// The players `<Html>` mounts for what a page plays and nobody sees: core's
// `<audio>`, one for each sound the element reports (`onSounds`,
// `HtmlViewNode._publishSounds`) — an `<audio>` a script played, in the
// document or made with `new Audio()` and never put in it.
//
// Nothing here is placed: an `<audio>` takes no room and draws nothing, so
// these are children of `<Html>`'s root that lay nothing out. What a page's
// script asks — `play()`, `pause()`, `muted`, `volume`, `playbackRate` — is
// in the sound (`MediaAsked`) and goes to the player as core's props, which
// tell the player that is playing rather than make another; a seek is a
// count, and the player is sought once each time it moves, as a video's is.
//
// What the player says goes back the other way (`soundEvent`), to the page
// whose clock follows it: its length, how far it has got, its end, a
// failure. A new source is a new player, keyed so, as HTML has it.
import React from 'react';
import type { ReactNode } from 'react';
import type { AudioElementNode } from 'react-x11';

import { hx } from './hx.js';
import type { Element } from './dom.js';
import type { Sound } from './media.js';
import type { HtmlViewNode } from './node.js';

export interface Sounds {
  /** What the element reports to. */
  onSounds: (sounds: Sound[]) => void;
  /** The players, in the order the page first played them. */
  render(): ReactNode[];
}

/** The players for a document's sounds, kept as the element reported them. */
export function useSounds(view: {
  readonly current: HtmlViewNode | null;
}): Sounds {
  const [sounds, setSounds] = React.useState<Sound[]>([]);
  const ids = React.useRef(new WeakMap<Element, number>()).current;
  const next = React.useRef(0);
  const idOf = (el: Element): number => {
    let id = ids.get(el);
    if (id === undefined) ids.set(el, (id = ++next.current));
    return id;
  };
  // each element's player, and the seek it was last sought by: a seek
  // asked while no player was mounted is the next one's
  const players = React.useRef(new Map<Element, AudioElementNode>()).current;
  const sought = React.useRef(new WeakMap<Element, number>()).current;
  React.useEffect(() => {
    for (const { element, seek } of sounds) {
      const node = seek && players.get(element);
      if (!node || sought.get(element) === seek.count) continue;
      sought.set(element, seek.count);
      node.seek(seek.time);
    }
  }, [sounds, players, sought]);
  const playerOf = (el: Element) => (node: AudioElementNode | null) => {
    if (node) players.set(el, node);
    else players.delete(el);
  };
  return {
    onSounds: React.useCallback((reported: Sound[]) => {
      setSounds(reported);
    }, []),
    render: () =>
      sounds.map((sound) =>
        renderSound(sound, idOf(sound.element), view, playerOf(sound.element)),
      ),
  };
}

function renderSound(
  sound: Sound,
  id: number,
  view: { readonly current: HtmlViewNode | null },
  ref: (node: AudioElementNode | null) => void,
): ReactNode {
  const { element: el, url } = sound;
  const tell = (kind: 'metadata' | 'time' | 'ended' | 'error', value = '') =>
    view.current?.soundEvent(el, url, kind, value);
  return hx('audio', {
    // a new source is a new player, and where the element changes its
    // source a new one is what HTML has too
    key: `audio:${id}:${url}`,
    ref,
    src: sound.source.src,
    loop: sound.loop,
    muted: sound.muted,
    // controlled once something said, which a sound is only once played
    ...(sound.paused !== undefined && { paused: sound.paused }),
    ...(sound.volume !== undefined && { volume: sound.volume }),
    ...(sound.playbackRate !== undefined && {
      playbackRate: sound.playbackRate,
    }),
    onLoadedMetadata: ({ duration }) => tell('metadata', String(duration)),
    onTimeUpdate: ({ currentTime }) => tell('time', String(currentTime)),
    onEnded: () => tell('ended'),
    onError: (err) => tell('error', err.message),
  });
}
