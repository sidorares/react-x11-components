// Type-level test: the parts compile as JSX against react-x11's namespace,
// the unions are closed (a typo in `variant` or `size` is an error, not a
// silent fallback), `value` is required where it names a tab, and the change
// event carries Chakra's details shape.
import { Icon } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from '../../src/index.js';
import type {
  TabsProps,
  TabsSize,
  TabsTriggerProps,
  TabsValueChange,
  TabsVariant,
} from '../../src/index.js';

/** The shortest thing that works: prose in every slot. */
export const plain = (
  <Tabs defaultValue="members">
    <TabsList>
      <TabsTrigger value="members">Members</TabsTrigger>
      <TabsTrigger value="projects">Projects</TabsTrigger>
    </TabsList>
    <TabsContent value="members">Manage your team members</TabsContent>
    <TabsContent value="projects">Manage your projects</TabsContent>
  </Tabs>
);

/** Every root prop, a glyph beside a label, and an indicator in the strip. */
export const configured = (
  <Tabs
    value="members"
    onValueChange={(change: TabsValueChange) => void change.value}
    variant="plain"
    size="lg"
    orientation="vertical"
    activationMode="manual"
    fitted
    justify="center"
    lazyMount
    unmountOnExit
    accent="$success"
    ground="$surface"
    style={{ width: 480 }}
    data-testname="tabs"
  >
    <TabsList style={{ gap: 4 }} data-testname="list">
      <TabsIndicator style={{ borderRadius: 6 }} />
      <TabsTrigger value="members" data-testname="tab">
        {/* the ink inherits; the size does not, so it is named */}
        <Icon name="check" size={12} />
        Members
      </TabsTrigger>
      <TabsTrigger value="projects" disabled style={[{ paddingLeft: 20 }]}>
        Projects
      </TabsTrigger>
    </TabsList>
    <TabsContent value="members" style={{ padding: 12 }} data-testname="panel">
      <box style={{ gap: 8 }} />
    </TabsContent>
  </Tabs>
);

/** The unions are closed. */
// @ts-expect-error -- 'pill' is not a variant
export const badVariant = <Tabs variant="pill" />;
// @ts-expect-error -- 'xl' is not a size
export const badSize = <Tabs size="xl" />;
// @ts-expect-error -- a trigger names the tab it selects
export const missingValue = <TabsTrigger>Members</TabsTrigger>;
// @ts-expect-error -- so does a panel
export const missingPanelValue = <TabsContent>…</TabsContent>;

/** The prop bags are exact enough to reuse. */
export const reused: TabsProps = {
  variant: 'enclosed' satisfies TabsVariant,
  size: 'sm' satisfies TabsSize,
};
export const triggerBag: TabsTriggerProps = { value: 'a', disabled: true };

/** `style` takes one style or a list, like everywhere in the package. */
const one: Style = { flexGrow: 1 };
export const styles = (
  <Tabs style={one}>
    <TabsList style={[one, { gap: 2 }]} />
  </Tabs>
);
