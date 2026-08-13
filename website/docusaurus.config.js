// @ts-check
// Docusaurus configuration for the @react-x11/components documentation site.
// See https://docusaurus.io/docs/api/docusaurus-config

const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: '@react-x11/components',
  tagline:
    'Components for react-x11 that do not belong in the core package — terminals, editors, calendars, a system tray',
  favicon: 'img/favicon.svg',

  url: 'https://sidorares.github.io',
  baseUrl: '/react-x11-components/',
  trailingSlash: false,

  organizationName: 'sidorares',
  projectName: 'react-x11-components',

  onBrokenLinks: 'throw',
  // The narrative pages link deep into the synced reference; a heading
  // renamed in docs/ must break the build, not just the link.
  onBrokenAnchors: 'throw',

  markdown: {
    // Reference pages are synced verbatim from the repo's docs/ directory and
    // are plain Markdown — they contain <element> names and {braces} that are
    // not valid MDX. 'detect' parses .md as CommonMark and .mdx as MDX.
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl:
            'https://github.com/sidorares/react-x11-components/tree/master/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/favicon.svg',
      colorMode: {
        defaultMode: 'light',
        disableSwitch: false,
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: '@react-x11/components',
        logo: {
          alt: 'react-x11 components logo',
          src: 'img/favicon.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          {
            to: '/docs/reference',
            label: 'Components',
            position: 'left',
          },
          {
            href: 'https://sidorares.github.io/react-x11/',
            label: 'react-x11',
            position: 'right',
          },
          {
            href: 'https://github.com/sidorares/react-x11-components',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/intro' },
              { label: 'Getting started', to: '/docs/getting-started' },
              { label: 'Components', to: '/docs/reference' },
            ],
          },
          {
            title: 'Project',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/sidorares/react-x11-components',
              },
              {
                label: 'npm',
                href: 'https://www.npmjs.com/package/@react-x11/components',
              },
              {
                label: 'Issues',
                href: 'https://github.com/sidorares/react-x11-components/issues',
              },
            ],
          },
          {
            title: 'The stack below',
            items: [
              {
                label: 'react-x11',
                href: 'https://sidorares.github.io/react-x11/',
              },
              { label: 'ntk', href: 'https://sidorares.github.io/ntk/' },
              {
                label: 'node-x11',
                href: 'https://sidorares.github.io/node-x11/',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} react-x11 contributors. Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'jsx', 'tsx'],
      },
    }),
};

module.exports = config;
