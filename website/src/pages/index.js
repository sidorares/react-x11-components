import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';

import styles from './index.module.css';

const COMPONENTS = [
  {
    name: 'Terminal',
    href: '/docs/reference/components/terminal',
    blurb:
      'An embedded xterm, or a VT this package draws itself — one prop apart. Bring your own pty and it runs over ssh.',
  },
  {
    name: 'CodeEditor',
    href: '/docs/reference/components/code-editor',
    blurb:
      'Highlighting, completion, undo, LSP-shaped diagnostics. Languages plug in three ways, none of them bundled.',
  },
  {
    name: 'Markdown',
    href: '/docs/reference/components/markdown',
    blurb:
      'GFM for streamed model output: every instant renders clean, and text selects across every block.',
  },
  {
    name: 'Calendar',
    href: '/docs/reference/components/calendar',
    blurb:
      'A month grid, single or range, any day blockable — and a hook that reads the desktop’s real calendars.',
  },
  {
    name: 'MediaPlayer',
    href: '/docs/reference/components/media-player',
    blurb:
      'mpv or VLC in a window you lay out, driven over its own IPC socket rather than respawned.',
  },
  {
    name: 'TrayHost',
    href: '/docs/reference/components/tray-host',
    blurb:
      'Be the system tray. Takes the selection, broadcasts MANAGER, and applications dock themselves.',
  },
];

const SNIPPET = `import { Terminal } from '@react-x11/components';

<Terminal
  command={['bash', '-lc', 'npm test']}
  onExit={({ code }) => setPassed(code === 0)}
  style={{ flexGrow: 1 }}
/>;`;

function Hero() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.hero)}>
      <div className="container">
        <h1 className={styles.title}>{siteConfig.title}</h1>
        <p className={styles.tagline}>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/intro">
            What this is
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/reference"
          >
            Component reference
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  return (
    <Layout
      title="Components for react-x11"
      description="Terminals, code editors, markdown, calendars and a system tray for react-x11 — built on its public API, and tree-shaken one component at a time."
    >
      <Hero />
      <main>
        <section className="container margin-vert--lg">
          <div className="row">
            <div className="col col--6">
              <h2>One import, one element</h2>
              <p>
                Importing a component is what teaches react-x11 its element, so
                there is no setup call to remember and no registration to run at
                startup — and a bundler drops every component an app does not
                name.
              </p>
              <p>
                Nothing here is a hard dependency, either. A machine with no
                terminal emulator and no media player is an ordinary state of a
                healthy machine, so each of those is a <code>status</code>, a{' '}
                <code>fallback</code> and an error that names what it looked for
                — never a throw out of render.
              </p>
            </div>
            <div className="col col--6">
              <CodeBlock language="jsx">{SNIPPET}</CodeBlock>
            </div>
          </div>
        </section>

        <section className="container margin-vert--lg">
          <h2>What is in the box</h2>
          <div className="row">
            {COMPONENTS.map((c) => (
              <div key={c.name} className="col col--4 margin-bottom--lg">
                <div className={clsx('card', styles.card)}>
                  <div className="card__header">
                    <h3>
                      <Link to={c.href}>{c.name}</Link>
                    </h3>
                  </div>
                  <div className="card__body">
                    <p>{c.blurb}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
