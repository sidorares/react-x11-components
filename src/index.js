// The convenience barrel. `import { Sparkline } from '@react-x11/components'`
// and `import { Sparkline } from '@react-x11/components/sparkline'` are the
// same module either way — with `sideEffects: false` and no side effects at
// this level, a bundler drops the components an app does not name.
//
// This file must never do more than re-export. Anything with a side effect
// here (a registration, a theme install, a feature probe) runs for every
// consumer of the barrel and takes the whole package into their bundle.
export { Sparkline, SPARKLINE_ELEMENT } from './sparkline/index.js';
