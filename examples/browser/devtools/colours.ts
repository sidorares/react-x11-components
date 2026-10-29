// The colours the tools draw markup in: a browser's tools' own, in either
// scheme.
import type { Theme } from 'react-x11';

import { isDarkBackground } from '../../../src/code-language/theme.js';
import type { LabelPart } from './model.js';

/** The colours a row's tags, attributes and text are in, as a browser's
 *  tools colour them, in either scheme. */
export function syntaxColours(theme: Theme): Record<LabelPart['kind'], string> {
  return isDarkBackground(theme.background)
    ? {
        punct: '#9aa0a6',
        tag: '#5db0d7',
        attr: '#9bbbdc',
        value: '#f29766',
        text: theme.text,
        comment: '#898989',
      }
    : {
        punct: '#a8459f',
        tag: '#881280',
        attr: '#994500',
        value: '#1a1aa6',
        text: theme.text,
        comment: '#236e25',
      };
}
