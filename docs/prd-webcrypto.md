# The Web Cryptography API in `<Html scripts>`

`crypto.subtle`, `SubtleCrypto` and `CryptoKey`, in windows, frames and every
kind of worker. `src/html/scripts/webcrypto.ts` is the page's half and
`src/html/scripts/subtle.ts` the host's.

It was left out on purpose until a sample of real tools showed what the
absence cost. None of the 21 tools opened in the example browser was stopped
by an Interop gap, and several were stopped by a missing platform API. PKCE
sign-in needs `digest`, end-to-end encrypted applications need AES-GCM, and
vscode.dev reports `'crypto.subtle' is not available so webviews will not
work` as soon as its workbench loads.

## Who does what

The specification splits each method into steps that run as it is called and
steps that run "in parallel". That split is the line between the two files.

| Where                     | What                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's realm          | Web IDL's conversions, algorithm normalization, copying buffers, the promise, every object a page holds and every rejection, as that realm's classes.           |
| The host                  | Everything the specification does in parallel, through the runtime's own `crypto.subtle`, which is told back through `__crypto` and settles the page's promise. |
| The realm, never the host | What a getter on a page's dictionary sees, and when a change to its buffer stops mattering: both are the specification's order because they run here.           |
| The host, never the realm | Whether a key may be exported, and what it may be used for.                                                                                                     |

The runtime is not reimplemented. Node and Bun both have a full `crypto.subtle`
and Node runs WPT's `WebCryptoAPI/` over its own, so this is an IDL layer and a
key store, and the algorithms a page gets are the ones its runtime has.

## Where a key is

This is the decision the rest stands on, because a key has four requirements
that pull against each other:

1. Its bytes must never be readable by a page's script. The facade runs in the
   page's realm, so anything that passes through the realm can be intercepted:
   a page can replace `JSON.stringify`, or read what `__in` is handed.
2. It has to cross threads. A worker uses a key a page posted it, and a thread
   shares nothing with the page's host but messages.
3. It has to reach a disk. Authentication libraries keep non-extractable keys
   in IndexedDB, and `HtmlProfile` is read by every tab's process after a
   restart.
4. A clone is text. `serializeClone` is how everything crosses a realm, and a
   record reaches the profile as the JSON that function writes.

**A `CryptoKey` holds a sealed string, and the string is the key.** `subtle.ts`
puts a key's material, its `type`, `extractable`, `algorithm` and `usages` under
AES-256-GCM with a secret no realm has, and hands the realm the result.

- A page's script may come by that string. It can read nothing in it and change
  nothing in it: an edited string does not open.
- It needs no special case in `serializeClone`, `transfersOf` or the worker
  channels, since it is a string, and no special case in `idbDiff`, since a
  record holding one is a record holding a string.
- Nothing is kept per key. There is no table of handles to replicate to a
  thread, to clear when a document goes, or to rebuild after a restart.

### What was turned down

**A table of handles in the host, with a number in the realm.** It is the
obvious shape and it fails on (2): a worker's host is on another thread, so a
handle means nothing there, and the table would have to be replicated or every
operation in a worker forwarded to the page. It fails on (3) as well, since the
disk needs the material in some form, which is the sealed form again.

**Keeping the runtime's `CryptoKey` objects.** They do not cross a `node:vm`
context, a thread or a disk, and a non-extractable one cannot be read back by
anything, the host included.

**Sealing only for the disk.** That is two forms of a key and a conversion
between them at every boundary, to save one AES-GCM operation that the cache of
opened keys already saves.

### What is believed

`extractable`, `usages` and `algorithm` are read from the opened record, always.
What the facade says of a key is shown to the page and believed nowhere: a page
that replaces `JSON.parse` can make `key.extractable` read `true`, and
`exportKey` still refuses. `test/html/webcrypto.test.ts` does exactly that.

### Another realm's key

A frame with a realm of its own has its own facade, and a `postMessage` to its
window runs there, so a key the page hands it has no slots in the realm that
serializes it. `CryptoKey.prototype` carries one method under
`Symbol.for('react-x11.sealedKey')`, which answers the sealed string. A page's
script can call it and can put one on anything, which gets it no further than
the string does: what a string opens to is decided by the host.

### The runtime's key

The host imports the material into a runtime key for each use, keeping the
last 256 keys opened per thread. It imports them extractable, because it has to
be able to read a generated key's material out to seal it. The `extractable`
the page sees is the record's and is enforced here, before the runtime is
asked. Two consequences:

- **HKDF and PBKDF2 keys cannot be extractable** in any runtime, so they
  are imported as they are and their material is what they were imported from.
  A key derived or unwrapped into one is handled by hand (`_deriveKey`,
  `_unwrapKey`), since the runtime's result could not be read out.
- **`unwrapKey` is the specification's steps**, not the runtime's method: the
  runtime would hand back a key it will not export where the page's may not be.
  The bytes are unwrapped into a scratch HMAC key, which any bytes can be, read
  out, and imported as the page asked.

### The secret

Each thread holds a list of secrets. The first is the one a host with no store
seals with: the process's, made as it is first asked for and handed to each
worker through `workerData`, which no realm sees.

A store that keeps databases past the process answers `keySecret()`
(`HtmlIndexedDB`), so what it holds opens in the next process. `HtmlProfile`
keeps 32 random bytes in its database, made by the first process to ask. That
is the posture a browser's profile has: Chrome keeps CryptoKeys in its IndexedDB
files, so someone who can read the profile can read them, and the boundary is
page scripts rather than the local user.

A store with no `keySecret` still works, for the life of the process. After a
restart such a record does not open and reads back as no record, which is what
`idbFromHost` does with any record it cannot read. An application with its own
store should answer `keySecret`, and one lost is every key kept in it lost.

**No switch turns this on.** It is a capability of the runtime and not a seam
of the host's: it opens nothing, sends nothing and writes nothing but what a
page's own IndexedDB already writes. `<Html scripts>` is the switch, and a
document with scripts off has none of it.

## Secure contexts

`subtle`, `SubtleCrypto`, `CryptoKey` and `randomUUID` exist only in a secure
context, and are absent rather than refused, as `[SecureContext]` has it.

The answer is the host's (`_secureContext`): the document at the top of the
frames has to be trustworthy, and so does a frame's own document where it came
over a network. A worker's is its owner's. `https:`, `wss:`, `file:`,
`localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` are trustworthy.

**A top-level `about:blank` or `data:` document is not**, as Chromium and
Firefox have it, though Secure Contexts 3.2 lists both. So a `<Html scripts>`
given no `baseUrl` has no `crypto.subtle`, and one that wants it names an
address. A frame of `about:blank`, `srcdoc` or `data:` takes its parent's answer.

## Bun

`src/` cannot name `node:crypto`, so `subtle.ts` reaches it through
`nodeModule`, at the top of the lazy chunk. Sealing has to be synchronous,
because a key that arrives in a clone has to be a `CryptoKey` before the message
is delivered, and the runtime's `crypto.subtle` answers a promise.

`test/html/webcrypto.test.ts` passes under `bun test`, worker clones and the
restart through `HtmlProfile` included. Nothing in the host branches on the
runtime.

## What is left

Measured on the whole of `WebCryptoAPI/`, 334 tests, against Node 26.

- `algorithm-discards-context` times out. Its scripts are appended to a frame's
  initial `about:blank`, and a script put into a realm-less frame does not run
  here at all, which is a limit of frames and not of this.
- `WorkerGlobalScope interface: attribute crypto`: a worker's global has no
  `WorkerGlobalScope.prototype` to hang the accessor on.
- `Window interface: attribute crypto` calls the getter on another object and
  wants a `TypeError`. On Bun a call on the global hands a getter nothing it
  could tell from that object, and a check of it left every page with no
  `crypto`, so the getter asks nothing.
